import { AsyncResource } from "node:async_hooks"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as tick } from "node:timers/promises"
import { expect, it, vi } from "vitest"
import { ModsManager } from "./manager"
import { FunctionSessionActivity } from "./v2/session-activity"
import { functionExecutionScope } from "./v2/execution-context"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

it("enters actual host turn completion independently of a finished model-hook activity", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mods-completion-entry-"))
  const manager = new ModsManager(
    join(folder, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  const activity = new FunctionSessionActivity()
  const completed = Promise.withResolvers<void>()
  let stale!: () => void
  try {
    manager.configure(folder, true, false)
    const workspace = manager.workspaceKey(folder)
    manager.attachFunctions({
      invalidate: () => {},
      closeThread: () => {},
      close: () => {},
      turnComplete: async () => {
        const scope = functionExecutionScope(workspace, "thread")
        expect(scope).toMatchObject({ userInitiated: false, leased: false, immediate: false })
        const release = activity.retain()
        await tick()
        release()
        completed.resolve()
        return { text: "answer" }
      }
    })
    await manager.startFunctionTurn({
      workspace,
      threadId: "thread",
      runId: "run",
      turnId: "turn",
      text: "task",
      signal: new AbortController().signal,
      cancel: () => {},
      assertCurrent: () => {}
    })
    await activity.run(async () => {
      stale = AsyncResource.bind(() => {
        expect(() => activity.retain()).toThrow("MODS_ENTRY_EXPIRED")
        manager.functionTurns.finish("thread", "run", { reason: "answer" })
      })
    })
    stale()
    await completed.promise
    await tick()
    expect(manager.functionTurns.stats).toEqual({ entries: 0, running: 0 })
    expect(activity.size).toBe(0)
  } finally {
    manager.close()
    activity.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
