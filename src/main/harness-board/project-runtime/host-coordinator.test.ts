import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HostProjectStore } from "./host-store"
import { HostProjectCoordinator, type HostProjectExecutionProvider } from "./host-coordinator"
import {
  hostProjectFixture,
  prepareFixture,
  receiptFixture,
  TEST_FINGERPRINT,
  TEST_NOW
} from "./host-fixtures.test-helper"

const cleanup: Array<() => void> = []
function fixture(overrides: Partial<HostProjectExecutionProvider> = {}) {
  const root = mkdtempSync(join(tmpdir(), "host-project-coordinator-"))
  const store = new HostProjectStore(join(root, "state.sqlite"), () => TEST_NOW)
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  store.create(hostProjectFixture(root))
  const operation = store.prepare(prepareFixture())
  const provider: HostProjectExecutionProvider = {
    authorize: vi.fn(async () => {}),
    fingerprint: vi.fn(async () => TEST_FINGERPRINT),
    execute: vi.fn(async () => "succeeded" as const),
    validate: vi.fn(async (_state, ticket) => [receiptFixture(ticket)]),
    ...overrides
  }
  return { store, operation, provider, coordinator: new HostProjectCoordinator(store, provider) }
}
afterEach(() => {
  cleanup.splice(0).forEach((run) => run())
  vi.restoreAllMocks()
})

describe("host project execution coordination", () => {
  it.each(["prepared", "interrupted"])("checks authority after the last awaited fingerprint for %s work", async mode => {
    let finish!: (value: string) => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    let current = true
    const f = fixture({
      fingerprint: async () => { entered(); return new Promise(resolve => { finish = resolve }) },
      assertCurrent: () => { if (!current) throw Error("CALLER_REVOKED") }
    })
    if (mode === "interrupted") {
      const ticket = f.store.start(f.operation.operationId, TEST_FINGERPRINT)
      f.store.recordResult(ticket, { outcome: "unknown", receipts: [] })
    }
    const before = f.store.getOperation(f.operation.operationId)
    const running = mode === "prepared" ? f.coordinator.executePrepared(f.operation.operationId)
      : f.coordinator.executeInterrupted(f.operation.operationId)
    await waiting
    current = false
    finish(TEST_FINGERPRINT)
    await expect(running).rejects.toThrow("CALLER_REVOKED")
    expect(f.store.getOperation(f.operation.operationId)).toEqual(before)
    expect(f.provider.execute).not.toHaveBeenCalled()
  })

  it("executes the host provider once, records validation and waits for explicit transition", async () => {
    const { coordinator, provider, operation, store } = fixture()
    expect((await coordinator.executePrepared(operation.operationId)).status).toBe("succeeded")
    expect(provider.execute).toHaveBeenCalledOnce()
    expect(provider.validate).toHaveBeenCalledOnce()
    expect(store.get("local-docs")?.version).toBe(1)
    await expect(coordinator.executePrepared(operation.operationId)).rejects.toThrow(
      "OPERATION_NOT_PREPARED"
    )
    expect(store.transition(operation.operationId, TEST_FINGERPRINT).version).toBe(2)
  })

  it("does not start after authorization denial or an input change", async () => {
    const denied = fixture({
      authorize: async () => {
        throw Error("denied")
      }
    })
    await expect(denied.coordinator.executePrepared(denied.operation.operationId)).rejects.toThrow(
      "denied"
    )
    expect(denied.provider.execute).not.toHaveBeenCalled()
    expect(denied.store.getOperation(denied.operation.operationId)?.status).toBe("failed")
    expect(denied.store.getOperation(denied.operation.operationId)?.startedAt).toBeNull()
    const changed = fixture({ fingerprint: async () => "c".repeat(64) })
    await expect(
      changed.coordinator.executePrepared(changed.operation.operationId)
    ).rejects.toThrow("INPUT_CHANGED")
    expect(changed.provider.execute).not.toHaveBeenCalled()
    expect(changed.store.getOperation(changed.operation.operationId)?.status).toBe("failed")
  })

  it("turns an unobserved external result into unknown and never retries it", async () => {
    const { coordinator, operation, store } = fixture({
      execute: async () => {
        throw Error("connection lost after write")
      }
    })
    expect((await coordinator.executePrepared(operation.operationId)).status).toBe("unknown")
    expect(() => store.prepare(prepareFixture({ idempotencyKey: "new" }))).toThrow(
      "OPERATION_ACTIVE"
    )
    await expect(coordinator.executePrepared(operation.operationId)).rejects.toThrow(
      "OPERATION_NOT_PREPARED"
    )
  })

  it.each(["execute", "validate"] as const)(
    "records only a bounded diagnostic for an unconfirmed %s boundary",
    async phase => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const failure = async () => {
        throw Error("PROJECT_HOST_INPUT_CHANGED", { cause: Error("private/path?credential=value") })
      }
      const f = fixture({ [phase]: failure })
      const result = await f.coordinator.executePrepared(f.operation.operationId)
      expect(result.status).toBe("unknown")
      expect(result.receipts).toEqual([])
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "[ProjectRuntime] Execution result unconfirmed",
        { phase, code: "PROJECT_HOST_INPUT_CHANGED" }
      )
      expect(JSON.stringify(warn.mock.calls)).not.toContain("credential")
      expect(() => f.store.prepare(prepareFixture({ idempotencyKey: "unsafe-retry" })))
        .toThrow("OPERATION_ACTIVE")
      if (phase === "execute") expect(f.provider.validate).not.toHaveBeenCalled()
    }
  )

  it("identifies a rejected persisted receipt without retaining its payload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = fixture({
      validate: async (_state, ticket) => [{ ...receiptFixture(ticket), artifactFingerprint: "private/value" }]
    })
    const result = await f.coordinator.executePrepared(f.operation.operationId)
    expect(result.status).toBe("unknown")
    expect(result.receipts).toEqual([])
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[ProjectRuntime] Execution result unconfirmed",
      { phase: "record-result", code: "PROJECT_HOST_SCHEMA_INVALID" }
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private/value")
  })

  it.each(["private/path?token=value", "BOUNDARY_CHANGED\n", "A".repeat(97)])(
    "redacts arbitrary exception messages while preserving unknown",
    async message => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const f = fixture({ execute: async () => { throw Error(message) } })
      expect((await f.coordinator.executePrepared(f.operation.operationId)).status).toBe("unknown")
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "[ProjectRuntime] Execution result unconfirmed", { phase: "execute", code: "UNKNOWN" }
      )
    }
  )

  it.each(["message-getter", "logger"])(
    "keeps unknown when the diagnostic %s throws",
    async failure => {
      vi.spyOn(console, "warn").mockImplementation(() => {
        if (failure === "logger") throw Error("LOGGING_FAILED")
      })
      const error = Error("BOUNDARY_CHANGED")
      if (failure === "message-getter") Object.defineProperty(error, "message", {
        get: () => { throw Error("MESSAGE_GETTER_FAILED") }
      })
      const f = fixture({ execute: async () => { throw error } })
      const result = await f.coordinator.executePrepared(f.operation.operationId)
      expect(result.status).toBe("unknown")
      expect(result.receipts).toEqual([])
      expect(f.provider.validate).not.toHaveBeenCalled()
    }
  )

  it("keeps cancellation pending while the host chain is running and does not launch validation", async () => {
    let signal: AbortSignal | undefined
    let finish!: (outcome: "succeeded") => void
    let begun!: () => void
    const started = new Promise<void>((resolve) => {
      begun = resolve
    })
    const { coordinator, operation, store, provider } = fixture({
      execute: async (_state, _ticket, hostSignal) => {
        signal = hostSignal
        begun()
        return new Promise((resolve) => {
          finish = resolve
        })
      }
    })
    const running = coordinator.executePrepared(operation.operationId)
    await started
    expect(coordinator.cancel(operation.operationId).status).toBe("cancel_requested")
    expect(signal?.aborted).toBe(true)
    expect(() => store.prepare(prepareFixture({ idempotencyKey: "new" }))).toThrow(
      "OPERATION_ACTIVE"
    )
    finish("succeeded")
    expect((await running).status).toBe("cancelled")
    expect(provider.validate).not.toHaveBeenCalled()
  })

  it("allows only one execution even when authorization awaits race", async () => {
    let admitted!: () => void
    const permission = new Promise<void>((resolve) => {
      admitted = resolve
    })
    const { coordinator, operation, provider } = fixture({ authorize: async () => permission })
    const first = coordinator.executePrepared(operation.operationId)
    const second = coordinator.executePrepared(operation.operationId)
    admitted()
    const results = await Promise.allSettled([first, second])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(provider.execute).toHaveBeenCalledOnce()
  })
})
