import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AsyncResource } from "node:async_hooks"
import type { AgentRunExecutionContext } from "../../agent/agent-run-service"
import { ModsManager } from "../manager"
import { createFunctionPluginPromptHost } from "./plugin-prompt-host"
import { nativePluginPromptRun } from "../../agent/mods-plugin-prompt-entry"
import { withFunctionAgentExecution, functionCallAuthority } from "./host-call"
import { currentFunctionExecution, functionExecutionScope, withFunctionWriteLease } from
  "./execution-context"
import { claimLocalThreadRunLease, getLocalThreadRunLease, releaseLocalThreadRunLease } from
  "../../agent/thread-run-lease"
import { FunctionSessionActivity } from "./session-activity"

const host = vi.hoisted(() => ({
  workspace: "",
  invoke: vi.fn<(request: { threadId: string; message: string },
    context: AgentRunExecutionContext) => Promise<void>>()
}))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle: () => {} }
}))
vi.mock("../../agent/runtime", () => ({ createAgentRuntime: vi.fn() }))
vi.mock("../../db", async original => ({
  ...(await original<typeof import("../../db")>()),
  getThreadCore: () => ({ created_at: 1,
    metadata: JSON.stringify({ workspacePath: host.workspace, agentMode: "normal" }) })
}))
vi.mock("../../agent/goals/runtime", () => ({ goalManager: { get: () => null } }))
vi.mock("../../agent/agent-run-service", () => ({
  isAgentRunBusy: () => false,
  onAgentRunSettled: () => () => {},
  startAgentRun: async (request: { threadId: string; message: string }, _delivery: unknown,
    context: AgentRunExecutionContext) => ({ threadId: request.threadId,
    completion: host.invoke(request, context) })
}))
vi.mock("../../agent/managed-transport-delivery", () => ({
  createManagedTransportAgentRunDelivery: () => ({})
}))
vi.mock("./composer-permission-scope", () => ({
  createComposerPermissionScope: async (workspace: string, _thread: string,
    assertOwner: () => void, signal: AbortSignal) => ({
    workspace,
    assertLive: () => { signal.throwIfAborted(); assertOwner() },
    queryTool: async () => ({ decision: "deny" as const, reason: "NO_TEST_TOOL" })
  })
}))

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  host.invoke.mockReset()
})

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "plugin-prompt-owner-review-"))
  const manager = new ModsManager(join(folder, "control.sqlite"), () => [], async () => true,
    () => {})
  manager.configure(folder, true, false)
  const workspace = manager.workspaceKey(folder)
  host.workspace = workspace
  const threadId = "plugin-prompt-owner-review"
  const original = manager.createRuntimeAuthority({ workspace, threadId, turnId: "old-turn",
    agentId: "main" })
  const unbind = manager.bindThread({ workspace, threadId, turnId: "old-turn", agentId: "main",
    runtimeAuthority: original.authority, queryTool: async () => ({ decision: "deny" }) })
  const originalGuard = manager.captureFunctionRuntimeGuard(original.authority)
  cleanups.push(() => {
    const lease = getLocalThreadRunLease(threadId)
    if (lease) releaseLocalThreadRunLease(threadId, lease.owner, lease.runId)
    unbind()
    original.release()
    manager.close()
    rmSync(folder, { recursive: true, force: true })
  })
  expect(claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "old-physical" })
    .acquired).toBe(true)
  const inOldWriteLease = (run: () => Promise<void>) => withFunctionAgentExecution({
    workspace, threadId, turnId: "old-turn", agentId: "main",
    runtimeAuthority: original.authority, userInitiated: true, leased: true, immediate: false
  }, () => withFunctionWriteLease(workspace, threadId, run))
  const releaseOriginalLease = () => {
    expect(releaseLocalThreadRunLease(threadId, "desktop", "old-physical")).toBe(true)
  }
  return { manager, workspace, threadId, original, originalGuard,
    inOldWriteLease, releaseOriginalLease }
}

it("a readonly plugin preparer exits a stale ancestor write lease without retiring main", async () => {
  const f = fixture()
  let entered = 0
  const onInvalid = vi.fn()
  await expect(f.inOldWriteLease(async () => {
    f.releaseOriginalLease()
    await f.manager.withPluginPromptPreparation(f.workspace, f.threadId,
      new AbortController().signal, f.originalGuard, onInvalid, async assertPreparation => {
      assertPreparation()
      entered++
      const execution = currentFunctionExecution()!
      expect(execution).toMatchObject({ userInitiated: false, leased: false, immediate: true })
      expect(execution.agentId).toMatch(/^plugin-prompt:/)
      expect(execution.runtimeAuthority).not.toBe(f.original.authority)
      expect(functionCallAuthority(f.workspace, f.threadId)).toBe(execution.runtimeAuthority)
      expect(() => functionExecutionScope("other-workspace", f.threadId))
        .toThrow("MODS_CALL_SCOPE_CHANGED")
      await Promise.resolve()
      f.originalGuard()
    })
  })).rejects.toThrow("MODS_FS_WRITE_LEASE")
  expect(entered).toBe(1)
  expect(onInvalid).not.toHaveBeenCalled()
  expect(f.manager.functionUserScope(f.workspace, f.threadId).runtimeAuthority)
    .toBe(f.original.authority)
  f.originalGuard()
})

it("the preparer rejects its actual binding replacement after an await before admission", async () => {
  const f = fixture()
  const onInvalid = vi.fn()
  let admissions = 0
  await expect(f.manager.withPluginPromptPreparation(f.workspace, f.threadId,
    new AbortController().signal, f.originalGuard, onInvalid, async assertPreparation => {
    assertPreparation()
    const authority = currentFunctionExecution()!.runtimeAuthority!
    const unbindReplacement = f.manager.bindThread({ workspace: f.workspace,
      threadId: f.threadId, turnId: authority.turnId, agentId: authority.agentId,
      runtimeAuthority: authority, readOnly: true, commandOnly: true,
      allowedToolNames: new Set(), queryTool: async () => ({ decision: "deny" }) })
    cleanups.push(unbindReplacement)
    await Promise.resolve()
    assertPreparation()
    admissions++
  })).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(admissions).toBe(0)
  expect(onInvalid).toHaveBeenCalledTimes(1)
  expect(onInvalid.mock.calls[0][0]).toMatchObject({ code: "MODS_CALL_SCOPE_CHANGED" })
  f.originalGuard()
})

it("a queued native run owns its actual mods lease and cannot inherit the stale writer", async () => {
  const f = fixture()
  let finish!: () => void
  const settled = new Promise<void>(resolve => { finish = resolve })
  host.invoke.mockImplementation(async (request, context) => {
    const receipt = nativePluginPromptRun(context.pluginPrompt, request.threadId, request.message)!
    const execution = currentFunctionExecution()!
    expect(execution).toMatchObject({ workspace: f.workspace, threadId: f.threadId,
      userInitiated: false, leased: true, immediate: false })
    expect(execution.runtimeAuthority).toBeUndefined()
    expect(() => functionExecutionScope("other-workspace", f.threadId))
      .toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(context.localRunLease).toMatchObject({ owner: "mods", managedExternally: true })
    expect(getLocalThreadRunLease(f.threadId)?.runId).toBe(context.localRunLease?.runId)
    receipt.assertLive()
    f.originalGuard()
    // This thin service stand-in tests the native transport owner, not logical-start timing.
    receipt.started()
    await settled
    receipt.assertLive()
  })
  const queue = createFunctionPluginPromptHost(f.manager, (workspace, threadId) => {
    expect(workspace).toBe(f.workspace)
    expect(threadId).toBe(f.threadId)
  })
  cleanups.push(queue.close)
  await expect(f.inOldWriteLease(async () => {
    const ticket = queue.reserve(f.workspace, f.threadId,
      { kind: "plugin", name: "actual" }, new AbortController().signal, f.originalGuard)
    const accepted = ticket.accept({ text: "native words", origin: { kind: "plugin", name: "actual" },
      wait: false })
    ticket.finish(accepted)
    f.releaseOriginalLease()
    try {
      await expect(ticket.wait()).resolves.toEqual(accepted)
      expect(host.invoke).toHaveBeenCalledTimes(1)
      expect(getLocalThreadRunLease(f.threadId)?.owner).toBe("mods")
    } finally { finish() }
  })).rejects.toThrow("MODS_FS_WRITE_LEASE")
  await expect.poll(() => getLocalThreadRunLease(f.threadId)).toBeUndefined()
  f.originalGuard()
})

it("a queued native run enters after the creator activity ends without reviving that token", async () => {
  const f = fixture()
  const activity = new FunctionSessionActivity()
  cleanups.push(() => activity.close())
  let finish!: () => void
  const settled = new Promise<void>(resolve => { finish = resolve })
  host.invoke.mockImplementation(async (request, context) => {
    const receipt = nativePluginPromptRun(context.pluginPrompt, request.threadId, request.message)!
    expect(activity.withinEntry).toBe(false)
    await Promise.resolve()
    const release = activity.retain()
    try {
      expect(activity.foregroundSize).toBe(1)
      expect(currentFunctionExecution()?.userInitiated).toBe(false)
      receipt.started()
      await settled
      receipt.assertLive()
    } finally { release() }
  })
  const queue = createFunctionPluginPromptHost(f.manager, () => f.originalGuard())
  cleanups.push(queue.close)
  const ticket = queue.reserve(f.workspace, f.threadId,
    { kind: "plugin", name: "actual" }, new AbortController().signal, f.originalGuard)
  let finishFromOldActivity!: () => void
  let retainFromOldActivity!: () => () => void
  await activity.run(async () => {
    const accepted = ticket.accept({ text: "after source", origin: { kind: "plugin", name: "actual" },
      wait: false })
    // Queue scheduling really inherits this token; a closure invoked outside ALS would miss it.
    finishFromOldActivity = AsyncResource.bind(() => ticket.finish(accepted))
    retainFromOldActivity = AsyncResource.bind(() => activity.retain())
  })
  expect(activity.size).toBe(0)
  expect(retainFromOldActivity).toThrow("MODS_ENTRY_EXPIRED")
  f.releaseOriginalLease()
  finishFromOldActivity()
  try {
    await expect(ticket.wait()).resolves.toMatchObject({ text: "after source" })
    expect(host.invoke).toHaveBeenCalledTimes(1)
    expect(activity.foregroundSize).toBe(1)
    expect(retainFromOldActivity).toThrow("MODS_ENTRY_EXPIRED")
  } finally { finish() }
  await expect.poll(() => activity.size).toBe(0)
  await expect.poll(() => getLocalThreadRunLease(f.threadId)).toBeUndefined()
  f.originalGuard()
})
