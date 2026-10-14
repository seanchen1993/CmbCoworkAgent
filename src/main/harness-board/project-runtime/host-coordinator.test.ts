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
afterEach(() => cleanup.splice(0).forEach((run) => run()))

describe("host project execution coordination", () => {
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
