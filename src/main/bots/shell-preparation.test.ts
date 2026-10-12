import { expect, it, vi } from "vitest"
import {
  BotShellProcess,
  BotShellPreparationError,
  withBotShellPreparationScope
} from "./shell-process"
import { BotDomainError } from "../../shared/bot-types"
import { BotOwnedShellProcess } from "./owned-shell-process"
import type { OwnedShellProcessOptions } from "./owned-shell-process"
import type { BotShellRequest } from "./shell-contract"
const request: BotShellRequest = {
  command: "echo never-run",
  cwd: "/project",
  runId: "run",
  timeoutMs: 1000,
  execution: { windowsSandbox: "none", resourceDirectory: "/resources" }
}
it.each(["validation", "missing-factory", "factory"] as const)(
  "produces trusted not-started proof only for %s before owned dispatch",
  async (mode) => {
    const owned = vi.spyOn(BotOwnedShellProcess.prototype, "start")
    const original = new BotDomainError("native_missing", "Native component is unavailable")
    const factory = vi.fn(async (): Promise<OwnedShellProcessOptions> => {
      throw original
    })
    const runner = new BotShellProcess(mode === "missing-factory" ? undefined : factory)
    const scope = {}
    try {
      const operation = withBotShellPreparationScope(scope, async () => {
        const call = runner.start(
          mode === "validation" ? { ...request, timeoutMs: -1 } : request,
          new AbortController().signal
        )
        const replies = await Promise.allSettled([call.admitted, call.completion])
        expect(replies.map((value) => value.status)).toEqual(["rejected", "rejected"])
        for (const reply of replies) {
          expect(reply).toHaveProperty("reason")
          if (reply.status !== "rejected") throw Error("Unexpected shell start")
          expect(reply.reason).toBeInstanceOf(BotShellPreparationError)
          expect(reply.reason.belongsTo(scope)).toBe(true)
          expect(reply.reason.belongsTo({})).toBe(false)
          expect(reply.reason.cancelled).toBe(false)
        }
      })
      await operation
      expect(owned).not.toHaveBeenCalled()
      expect(factory).toHaveBeenCalledTimes(mode === "factory" ? 1 : 0)
    } finally {
      owned.mockRestore()
    }
  }
)
it("marks cancellation during preparation known-not-started without entering owned start", async () => {
  const controller = new AbortController()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const runner = new BotShellProcess(async () => {
    await held
    controller.signal.throwIfAborted()
    throw Error("Unexpected live factory")
  })
  const owned = vi.spyOn(BotOwnedShellProcess.prototype, "start")
  try {
    const operation = runner.start(request, controller.signal)
    controller.abort(new Error("cancelled while preparing"))
    release()
    await expect(operation.completion).rejects.toMatchObject({
      cancelled: true,
      message: "cancelled while preparing"
    })
    await expect(operation.admitted).rejects.toBeInstanceOf(BotShellPreparationError)
    expect(owned).not.toHaveBeenCalled()
  } finally {
    owned.mockRestore()
  }
})
it("preserves a rejected owned admission after dispatch as uncertain even if its error code resembles preparation", async () => {
  const failure = new BotDomainError("shell_preparation_failed", "lost commit acknowledgement")
  const prepared: OwnedShellProcessOptions = {
    helper: { entry: "/private/helper.cjs", sha256: "a".repeat(64) },
    launch: {
      entry: "/private/worker.cjs",
      entrySha256: "b".repeat(64),
      cwd: "/project",
      executable: process.execPath,
      execArgv: [],
      environment: {}
    },
    controlRoot: "/private/control",
    origin: { hostId: "host", dataEpoch: "epoch", policySha256: "c".repeat(64) },
    assertCurrent: vi.fn(async () => {}),
    releasePrepared: vi.fn(async () => {})
  }
  const dispatched = vi.spyOn(BotOwnedShellProcess.prototype, "start").mockImplementation(() => {
    const admitted = Promise.reject(failure),
      completion = Promise.reject(failure)
    void admitted.catch(() => {})
    void completion.catch(() => {})
    return { admitted, completion }
  })
  try {
    const call = new BotShellProcess(async () => prepared).start(
      request,
      new AbortController().signal
    )
    await expect(call.admitted).rejects.toBe(failure)
    await expect(call.completion).rejects.toBe(failure)
    expect(failure).not.toBeInstanceOf(BotShellPreparationError)
    expect(dispatched).toHaveBeenCalledOnce()
  } finally {
    dispatched.mockRestore()
  }
})
