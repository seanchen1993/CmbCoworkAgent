import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModsManager } from "./manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { functionCallAuthority, withFunctionAgentExecution } from "./v2/host-call"
import type { ModObject } from "../../shared/mods/types"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
let permissionLive = true
vi.mock("./v2/composer-permission-scope", () => ({
  // This plain fixture owns no genuine file-data tail.
  readComposerPermissionScopeData: () => undefined,
  createComposerPermissionScope: (
    workspace: string,
    _threadId: string,
    assertOwner: () => void
  ) => ({
    workspace,
    assertLive: () => {
      assertOwner()
      if (!permissionLive) throw Error("sandbox changed")
    },
    queryTool: async () => ({ decision: "allow" })
  })
}))
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run()
  permissionLive = true
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-submit-manager-"))
  const manager = new ModsManager(
    join(root, "control.db"),
    () => [],
    async () => true,
    () => {}
  )
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root)
  const threadId = "submit-manager-thread"
  expect(claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" }).acquired).toBe(true)
  cleanup.push(() => {
    releaseLocalThreadRunLease(threadId, "desktop", "run")
    manager.close()
    rmSync(root, { recursive: true, force: true })
  })
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let captured: ReturnType<typeof functionCallAuthority>
  manager.attachFunctions({
    invalidate: vi.fn(),
    closeThread: vi.fn(),
    close: vi.fn(),
    classicEvent: async (_workspace, _threadId, _event, input, signal, core) => {
      captured = functionCallAuthority(workspace, threadId)
      expect(
        await manager.functionRuntimeScope(workspace, threadId).queryTool!("host:read_file", {
          file_path: join(workspace, "config.json")
        })
      ).toEqual({ decision: "allow" })
      const grant = manager.store.grant(workspace, "function:reader", "digest", true)
      expect(
        await manager.queryFunctionTool(
          workspace,
          threadId,
          grant,
          "host:read_file",
          { file_path: join(workspace, "config.json") },
          signal,
          async () => ({ decision: "allow" })
        )
      ).toEqual({ decision: "deny", reason: "MODS_RUNTIME_TOOL_DENIED" })
      entered.resolve()
      await proceed.promise
      return core!(input, signal)
    }
  })
  const commit = vi.fn(async (input: ModObject) => input)
  const start = () =>
    manager.submitComposerPrompt(
      workspace,
      threadId,
      "turn",
      { text: "plain", origin: { kind: "composer" }, wait: false },
      new AbortController().signal,
      () => {},
      commit
    )
  return { manager, workspace, threadId, entered, proceed, commit, start, captured: () => captured }
}

it("creates and releases a real admission owner without borrowing an old main binding", async () => {
  const f = fixture()
  const pending = f.start()
  await f.entered.promise
  expect(f.captured()?.turnId).toBe("turn")
  expect(f.captured()?.agentId).toMatch(/^composer:/)
  f.proceed.resolve()
  await expect(pending).resolves.toMatchObject({ text: "plain" })
  expect(f.commit).toHaveBeenCalledOnce()
  expect(() => f.captured()?.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
})
it("edits without a physical task lease and keeps an existing main binding", async () => {
  const f = fixture()
  releaseLocalThreadRunLease(f.threadId, "desktop", "run")
  const main = f.manager.createRuntimeAuthority({ workspace: f.workspace, threadId: f.threadId,
    turnId: "resident-edit" })
  cleanup.push(main.release)
  cleanup.push(f.manager.bindThread({ workspace: f.workspace, threadId: f.threadId,
    turnId: "resident-edit", runtimeAuthority: main.authority }))
  const editing = f.manager.editComposerPrompt(f.workspace, f.threadId,
    { text: "old", cursor: 3, start: 0, end: 3, inputText: "new", origin: { kind: "composer" } },
    new AbortController().signal, () => {})
  await f.entered.promise
  expect(f.captured()?.agentId).toMatch(/^editor:/)
  expect(f.captured()).not.toBe(main.authority)
  expect(f.manager.functionUserScope(f.workspace, f.threadId).runtimeAuthority).toBe(main.authority)
  f.proceed.resolve()
  expect(await editing).toEqual({ text: "new", cursor: 3 })
  expect(() => f.captured()?.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(() => main.authority.assertLive()).not.toThrow()
})
it.each(["cancel", "owner", "sandbox"])("does not apply an editor result after %s changes", async kind => {
  const f = fixture(), signal = new AbortController()
  let mounted = true
  const editing = f.manager.editComposerPrompt(f.workspace, f.threadId,
    { text: "old", cursor: 3, start: 0, end: 3, inputText: "new", origin: { kind: "composer" } },
    signal.signal, () => { if (!mounted) throw Error("owner changed") })
  const rejected = expect(editing).rejects.toThrow()
  await f.entered.promise
  if (kind === "cancel") signal.abort()
  else if (kind === "owner") mounted = false
  else permissionLive = false
  f.proceed.resolve()
  await rejected
  expect(() => f.captured()?.assertLive()).toThrow()
})
it("keeps an actual cumulative caret without exposing it in the edit event", async () => {
  const f = fixture()
  const editing = f.manager.editComposerPrompt(f.workspace, f.threadId,
    { text: "aa", cursor: 2, start: 0, end: 2, inputText: "aaa", origin: { kind: "composer" } },
    new AbortController().signal, () => {}, 1)
  await f.entered.promise
  f.proceed.resolve()
  expect(await editing).toEqual({ text: "aaa", cursor: 1 })
})

it.each(["accepted", "cancelled"])(
  "keeps the resident main, its loading owner and session view during %s admission",
  async (ending) => {
    const f = fixture()
    const main = f.manager.createRuntimeAuthority({
      workspace: f.workspace,
      threadId: f.threadId,
      turnId: "resident"
    })
    cleanup.push(main.release)
    const binding = {
      workspace: f.workspace,
      threadId: f.threadId,
      turnId: "resident",
      runtimeAuthority: main.authority,
      queryTool: async () => ({ decision: "allow" as const })
    }
    cleanup.push(f.manager.bindThread(binding))
    f.manager.bindFunctionSession(main.authority, "resident-model")
    const read = await withFunctionAgentExecution(
      {
        ...binding,
        userInitiated: false,
        leased: false,
        immediate: false
      },
      async () => f.manager.captureFunctionSession(f.workspace, f.threadId)
    )
    cleanup.push(read.release)
    const controller = new AbortController()
    const pending = f.manager.submitComposerPrompt(
      f.workspace,
      f.threadId,
      "new-turn",
      { text: "plain", origin: { kind: "composer" }, wait: false },
      controller.signal,
      () => {},
      f.commit
    )
    const rejected = ending === "cancelled" ? expect(pending).rejects.toThrow() : undefined
    await f.entered.promise
    expect(f.captured()).not.toBe(main.authority)
    expect(f.manager.functionUserScope(f.workspace, f.threadId).runtimeAuthority).toBe(
      main.authority
    )
    expect(() => main.authority.assertLive()).not.toThrow()
    expect(() => read.assertLive()).not.toThrow()
    expect(read.model).toBe("resident-model")
    if (ending === "cancelled") controller.abort()
    f.proceed.resolve()
    if (rejected) {
      await rejected
      expect(f.commit).not.toHaveBeenCalled()
    } else {
      await expect(pending).resolves.toMatchObject({ text: "plain" })
      expect(f.commit).toHaveBeenCalledOnce()
    }
    expect(() => f.captured()?.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    expect(() => main.authority.assertLive()).not.toThrow()
    expect(() => read.assertLive()).not.toThrow()
    expect(f.manager.functionUserScope(f.workspace, f.threadId).runtimeAuthority).toBe(
      main.authority
    )
  }
)

it.each(["epoch", "lease", "sandbox"])(
  "refuses a stale %s before the durable commit",
  async (change) => {
    const f = fixture()
    const pending = f.start()
    const rejected = expect(pending).rejects.toThrow()
    await f.entered.promise
    if (change === "epoch") {
      f.manager.configure(f.workspace, false, false)
      f.manager.configure(f.workspace, true, false)
    } else if (change === "lease") {
      releaseLocalThreadRunLease(f.threadId, "desktop", "run")
      claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "run" })
    } else permissionLive = false
    f.proceed.resolve()
    await rejected
    expect(f.commit).not.toHaveBeenCalled()
    expect(() => f.captured()?.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  }
)
