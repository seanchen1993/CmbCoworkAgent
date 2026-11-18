import { readFileSync } from "fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import type { ThreadDeleteOptions } from "../types"
import { assertThreadDeletionWorkspace, isThreadDeletionBusy } from "./thread-deletion-busy"

const source = readFileSync(new URL("./threads.ts", import.meta.url), "utf8")

// Exercise the registered handler and its teardown closure without loading Electron or a DB.
function loadThreadDeletionHandler({
  externalOwner = false,
  backgroundShell = false
}: { externalOwner?: boolean; backgroundShell?: boolean } = {}) {
  const start = source.indexOf("const deletingThreads = new Map")
  const end = source.indexOf("// Get thread history", start)
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const noop = (): void => undefined
  const releaseShellBlock = vi.fn()
  const blockNewBackgroundTasks = vi.fn(() => releaseShellBlock)
  const cancelAndWaitForAgentThreadRun = vi.fn<() => Promise<string>>()
  const cancelWorkflow = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const rollbackWorkflowThreadDisposal = vi.fn()
  const hasExternalThreadRunOwner = vi.fn(() => externalOwner)
  const hasActiveBackgroundTasks = vi.fn(() => backgroundShell)
  const dependencies = {
    normalizeThreadDeleteOptions: (options?: ThreadDeleteOptions) => options,
    requireThreadMutationLease: (threadId: string) => threadId,
    withThreadMutationLeaseLock: (_lease: string, run: (row: { metadata: string }) => unknown) =>
      run({ metadata: "{}" }),
    cancelLegacySubagentTranscriptMigration: noop,
    cancelSubagentTranscriptStartupRead: noop,
    cancelLegacyCheckpointTranscriptBootstrap: noop,
    getAgentModeFromMetadata: () => "normal",
    assertThreadDeletionWorkspace,
    isThreadDeletionBusy,
    hasActiveAgentRun: () => false,
    isActiveAgentRunAborting: () => false,
    waitForActiveAgentRunToSettle: () => Promise.resolve("settled"),
    hasExternalThreadRunOwner,
    isExternallyManagedThreadRunBusy: () =>
      hasExternalThreadRunOwner() || hasActiveBackgroundTasks(),
    LocalSandbox: { blockNewBackgroundTasks, hasActiveBackgroundTasks },
    BrowserWindow: { fromWebContents: () => null },
    workflowRunManager: {
      isActive: () => false,
      activeWorkspaceForThread: () => undefined,
      cancelAndWait: cancelWorkflow
    },
    coordinatorWorkerManager: { hasRunningWorkersForThread: () => false },
    isWorkflowThreadMarkedDisposed: () => false,
    markWorkflowThreadDisposed: noop,
    rollbackWorkflowThreadDisposal,
    cancelAndWaitForAgentThreadRun
  }
  const execute = new Function(
    ...Object.keys(dependencies),
    `let execute
     const ipcMain = { handle: (_channel, callback) => { execute = callback } }
     ${code}
     return execute`
  )(...Object.values(dependencies)) as (
    event: { sender: object },
    threadId: string,
    options?: ThreadDeleteOptions
  ) => Promise<void>

  return {
    remove: (options?: ThreadDeleteOptions) => execute({ sender: {} }, "thread", options),
    blockNewBackgroundTasks,
    releaseShellBlock,
    cancelAndWaitForAgentThreadRun,
    cancelWorkflow,
    hasExternalThreadRunOwner,
    rollbackWorkflowThreadDisposal
  }
}

describe("threads:delete shell and external owner coordination", () => {
  it.each([
    [undefined, "会话仍在运行或有待处理结果，已停止删除。"],
    [{ requireIdle: true }, "会话仍在运行，已跳过该会话。"]
  ] as const)("keeps an externally owned shell running (%j)", async (options, message) => {
    const handler = loadThreadDeletionHandler({ externalOwner: true, backgroundShell: true })

    await expect(handler.remove(options)).rejects.toThrow(message)

    expect(handler.blockNewBackgroundTasks).not.toHaveBeenCalled()
    expect(handler.cancelWorkflow).not.toHaveBeenCalled()
    expect(handler.cancelAndWaitForAgentThreadRun).not.toHaveBeenCalled()
  })

  it("rechecks external ownership after waiting for workflow cancellation", async () => {
    const handler = loadThreadDeletionHandler()
    const workflowExit = Promise.withResolvers<void>()
    handler.cancelWorkflow.mockReturnValue(workflowExit.promise)

    const deletion = handler.remove()
    expect(handler.cancelWorkflow).toHaveBeenCalledExactlyOnceWith("thread")
    handler.hasExternalThreadRunOwner.mockReturnValue(true)
    workflowExit.resolve()

    await expect(deletion).rejects.toThrow("会话仍在运行或有待处理结果，已停止删除。")
    expect(handler.cancelAndWaitForAgentThreadRun).not.toHaveBeenCalled()
    expect(handler.rollbackWorkflowThreadDisposal).toHaveBeenCalledExactlyOnceWith("thread", false)
    expect(handler.releaseShellBlock).toHaveBeenCalledOnce()
  })

  it("waits for the thread's own detached shell during individual deletion", async () => {
    const handler = loadThreadDeletionHandler({ backgroundShell: true })
    const shellExit = Promise.withResolvers<string>()
    handler.cancelAndWaitForAgentThreadRun.mockReturnValue(shellExit.promise)
    const deletion = handler.remove()

    await vi.waitFor(() =>
      expect(handler.cancelAndWaitForAgentThreadRun).toHaveBeenCalledExactlyOnceWith("thread", null)
    )
    expect(handler.blockNewBackgroundTasks).toHaveBeenCalledExactlyOnceWith("thread")
    expect(handler.releaseShellBlock).not.toHaveBeenCalled()
    shellExit.resolve("shell_timed_out")
    await expect(deletion).rejects.toThrow("Shell 任务仍在退出，已停止删除。请稍后重试。")
    expect(handler.releaseShellBlock).toHaveBeenCalledOnce()
  })
})

describe("threads:get hydration contract", () => {
  it("runs the hot path in the read-only metadata worker with a narrow fallback", () => {
    const channel = source.indexOf('"threads:get"')
    const start = source.lastIndexOf("ipcMain.handle(", channel)
    const end = source.indexOf('ipcMain.handle("threads:messages"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("await readThreadHydrationInWorker(")
    expect(handler).toContain('requestScope === "foreground-hydration"')
    expect(handler).toContain("isThreadMetadataHydrationWorkerUnavailable")
    expect(handler).toContain("getThreadHydrationCore(threadId)")
    expect(handler).toContain("thread_values: {}")
    expect(handler).not.toContain("withThreadRunMutationLock")
    expect(handler).not.toContain("ensureSubagentTranscriptRows")
    expect(handler).not.toContain("getLegacyThreadSubagentMigrationPayload")
    expect(handler).not.toMatch(/\bgetThread\(threadId\)/)
    expect(handler).not.toContain("SELECT *")
  })

  it("filters all legacy lifetime maps from update and merge payloads", () => {
    const filterStart = source.indexOf("function threadValuesWithoutSubagentTranscripts")
    const filterEnd = source.indexOf("function rowBackedSubagentTranscriptPage", filterStart)
    const filter = source.slice(filterStart, filterEnd)
    for (const key of [
      "messageTimes",
      "messageTimeOrder",
      "internalGoalMessageTimes",
      "internalGoalMessageTimeOrder"
    ]) {
      expect(filter).toContain(`delete values.${key}`)
      expect(source).toContain(`delete safePatch.${key}`)
      expect(source).toContain(`delete safeValues.${key}`)
    }
  })

  it("cancels migration before deletion waits and forgets it only after DB removal", () => {
    const channel = source.indexOf('"threads:delete"')
    const start = source.lastIndexOf("ipcMain.handle(", channel)
    const end = source.indexOf('// Get thread history', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("const lease = requireThreadMutationLease(threadId)")
    expect(handler.indexOf("cancelLegacySubagentTranscriptMigration(threadId)")).toBeLessThan(
      handler.indexOf("withThreadMutationLeaseLock(lease")
    )
    expect(handler.indexOf("cancelLegacyCheckpointTranscriptBootstrap(threadId)")).toBeLessThan(
      handler.indexOf("withThreadMutationLeaseLock(lease")
    )
    expect(handler).toContain("if (options?.requireIdle)")
    expect(handler.indexOf("isThreadDeletionBusy(")).toBeLessThan(
      handler.indexOf("performThreadDeletion(event, threadId, metadata, options)")
    )
    expect(handler).toContain("isExternallyManagedThreadRunBusy(id, metadata)")
    expect(handler).not.toContain("isThreadForkBusy(")
    expect(handler).not.toContain("restoreWorkersForThread")
    expect(handler).not.toContain("isBusyForThreadAsync")
    const workspaceGuard = handler.indexOf("assertThreadDeletionWorkspace(")
    expect(workspaceGuard).toBeGreaterThan(handler.indexOf("withThreadMutationLeaseLock(lease"))
    expect(workspaceGuard).toBeLessThan(handler.indexOf("if (options?.requireIdle)"))
    expect(workspaceGuard).toBeLessThan(handler.indexOf("performThreadDeletion("))
    const deleteIndex = source.indexOf("dbDeleteThread(threadId)")
    const forgetIndex = source.indexOf("forgetLegacySubagentTranscriptMigration(threadId)")
    expect(deleteIndex).toBeGreaterThanOrEqual(0)
    expect(forgetIndex).toBeGreaterThan(deleteIndex)
  })

  it("binds grouped deletion to the confirmed incarnation and selector inside the mutation lock", () => {
    const channel = source.indexOf('"threads:delete"')
    const start = source.lastIndexOf("ipcMain.handle(", channel)
    const end = source.indexOf("// Get thread history", start)
    const handler = source.slice(start, end)
    const lockIndex = handler.indexOf("withThreadMutationLeaseLock(lease")
    const incarnationIndex = handler.indexOf("matchesThreadIncarnation(threadRow")
    const membershipIndex = handler.indexOf("threadMetadataMatchesGroupSelector(")
    const deletionIndex = handler.indexOf(
      "performThreadDeletion(event, threadId, metadata, options)"
    )

    expect(handler).toContain("normalizeThreadDeleteOptions(rawOptions)")
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(incarnationIndex).toBeGreaterThan(lockIndex)
    expect(membershipIndex).toBeGreaterThan(incarnationIndex)
    expect(deletionIndex).toBeGreaterThan(membershipIndex)
  })

  it("rechecks grouped deletion shell activity directly before blocking new starts", () => {
    const start = source.indexOf('"threads:delete"')
    const end = source.indexOf("// Get thread history", start)
    const handler = source.slice(start, end)
    const priorDeletion = handler.indexOf("await deletingThreads.get(threadId)")
    const idleCheck = handler.indexOf("await isThreadDeletionBusy(threadId")
    const shellRecheck = handler.indexOf("busy || hasBackgroundShell(threadId)")
    const block = handler.indexOf("LocalSandbox.blockNewBackgroundTasks(threadId)")

    expect(handler).toContain("hasActiveBackgroundTasks(id, { includeChildRuns: true })")
    expect(priorDeletion).toBeGreaterThanOrEqual(0)
    expect(idleCheck).toBeGreaterThan(priorDeletion)
    expect(shellRecheck).toBeGreaterThan(idleCheck)
    expect(block).toBeGreaterThan(shellRecheck)
    expect(handler.slice(shellRecheck, block)).not.toMatch(/\bawait\b/)
  })

  it("revalidates a grouped selection again at the synchronous database commit boundary", () => {
    const start = source.indexOf("const performThreadDeletion = async")
    const end = source.indexOf('"threads:delete"', start)
    const deletion = source.slice(start, end)
    const finalIncarnationCheck = deletion.lastIndexOf("matchesThreadIncarnation(")
    const finalMembershipCheck = deletion.lastIndexOf("threadMetadataMatchesGroupSelector(")
    const databaseCommit = deletion.indexOf("dbDeleteThread(threadId)")

    expect(finalIncarnationCheck).toBeGreaterThanOrEqual(0)
    expect(finalMembershipCheck).toBeGreaterThan(finalIncarnationCheck)
    expect(finalMembershipCheck).toBeLessThan(databaseCommit)
    expect(deletion.slice(finalMembershipCheck, databaseCommit)).not.toContain("await ")
  })

  it("rechecks owner-managed runs at the synchronous database commit boundary", () => {
    const start = source.indexOf("const performThreadDeletion = async")
    const end = source.indexOf('"threads:delete"', start)
    const deletion = source.slice(start, end)
    const finalBusyCheck = deletion.lastIndexOf("isExternallyManagedThreadRunBusy(")
    const databaseCommit = deletion.indexOf("dbDeleteThread(threadId)")

    expect(finalBusyCheck).toBeGreaterThanOrEqual(0)
    expect(finalBusyCheck).toBeLessThan(databaseCommit)
    expect(deletion.slice(finalBusyCheck, databaseCommit)).not.toContain("await ")
  })

  it("does not turn post-commit artifact cleanup failures into deletion failures", () => {
    const start = source.indexOf("const performThreadDeletion = async")
    const end = source.indexOf('"threads:delete"', start)
    const deletion = source.slice(start, end)
    const commitIndex = deletion.indexOf("dbDeleteThread(threadId)")
    const workflowCleanupIndex = deletion.indexOf(
      "await deleteWorkflowRunsForThread(workspacePath, threadId)"
    )
    const coordinatorCleanupIndex = deletion.indexOf(
      "await coordinatorWorkerManager.forgetThreadAndDeleteArtifacts(threadId)"
    )

    expect(commitIndex).toBeGreaterThanOrEqual(0)
    expect(workflowCleanupIndex).toBeGreaterThan(commitIndex)
    expect(coordinatorCleanupIndex).toBeGreaterThan(commitIndex)
    expect(deletion).toMatch(
      /try\s*{\s*await deleteWorkflowRunsForThread\(workspacePath, threadId\)[\s\S]{0,400}catch \(e\)/
    )
    expect(deletion).toMatch(
      /try\s*{\s*await coordinatorWorkerManager\.forgetThreadAndDeleteArtifacts\(threadId\)[\s\S]{0,400}catch \(e\)/
    )
  })

  it("keeps background subagent refreshes out of the foreground latest-wins scope", () => {
    const channel = source.indexOf('"threads:getSubagentTranscripts"')
    const start = source.lastIndexOf("ipcMain.handle(", channel)
    const end = source.indexOf('ipcMain.handle(\n    "threads:getSubagentTranscript"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain('options?.requestScope === "foreground-hydration"')
    expect(handler).toContain("if (isForeground)")
    expect(handler).toContain(":background:${threadId}")
    expect(handler).toContain(":foreground`")
  })

  it("does not turn a failed subagent transcript read into an authoritative empty baseline", () => {
    const channel = source.indexOf('"threads:getSubagentTranscripts"')
    const start = source.lastIndexOf("ipcMain.handle(", channel)
    const end = source.indexOf('ipcMain.handle(\n    "threads:getSubagentTranscript"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("if (!getThreadCore(threadId)) return {}")
    expect(handler).toContain("if (isSubagentTranscriptStartupCancelled(error)) return {}")
    expect(handler).toContain("throw error")
  })

  it("uses the shifted deferred row when a complete tool group is prepended", () => {
    const channel = source.indexOf('"threads:getSubagentTranscript"')
    const start = source.lastIndexOf("ipcMain.handle(", channel)
    const end = source.indexOf('"threads:exportSubagentTranscriptBlob"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain(
      "selectedPage.messages[selectedPage.deferredHydrationIndex ?? 0]"
    )
    expect(handler).toContain("page.messages[deferredHydrationIndex]")
    expect(handler).toContain("messageIndex: page.start + deferredHydrationIndex")
  })

  it("uses an empty goal sidecar only for a successful read or bounded worker fallback", () => {
    const channel = source.indexOf('"threads:goalEvents"')
    const start = source.lastIndexOf("ipcMain.handle(", channel)
    const end = source.indexOf('"threads:goalState"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("events = result.events")
    expect(handler).toContain("if (!isThreadMetadataHydrationWorkerUnavailable(error)) throw error")
    expect(handler).toContain("events = getThreadGoalEventsHydrationFallback(threadId")
    expect(handler).not.toMatch(/catch \(error\) \{[\s\S]{0,300}events = \[\]/)
  })

  it("keeps the empty-transcript checkpoint bridge bounded across IPC", () => {
    const channel = source.indexOf('"threads:bootstrap-legacy-checkpoint-transcript"')
    const start = source.lastIndexOf("ipcMain.handle(", channel)
    const end = source.indexOf('ipcMain.handle("threads:exportSession"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("bootstrapLegacyCheckpointTranscriptInWorker")
    expect(handler).toContain("limit: 128")
    expect(handler).toContain("byteBudget: 1024 * 1024")
    expect(handler).toContain("checkpoint: bootstrap.runtimeTuple")
    expect(handler).toContain("`thread-hydration:${event.sender.id}`")
    expect(handler).not.toContain("withCheckpointer")
    expect(handler).not.toContain("readLatestCheckpointTupleInWorker")
    expect(handler).not.toContain("getLatestCheckpoint(")
  })

  it("returns only a cancellable bounded worker-checkpoint tail", () => {
    const start = source.indexOf('ipcMain.handle("threads:latest-checkpoint"')
    const end = source.indexOf(
      'ipcMain.handle("threads:latest-checkpoint-runtime-state"',
      start
    )
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("messageLimit: 500")
    expect(handler).toContain("messageByteBudget: 1024 * 1024")
    expect(handler).toContain("foregroundKey: `worker-panel:${event.sender.id}`")
    expect(handler).not.toContain("withCheckpointer")
    expect(handler).toContain("isCheckpointRuntimeProjectionCancelled(e)")
  })

  it("hydrates only bounded runtime channels in the cancellable projection worker", () => {
    const start = source.indexOf('ipcMain.handle("threads:latest-checkpoint-runtime-state"')
    const end = source.indexOf(
      '"threads:bootstrap-legacy-checkpoint-transcript"',
      start
    )
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("readLatestCheckpointRuntimeTupleInWorker")
    expect(handler).toContain("`thread-hydration:${event.sender.id}`")
    expect(handler).toContain("isCheckpointRuntimeProjectionCancelled(e)")
    expect(handler).toContain("throw e")
    expect(handler).not.toMatch(
      /Failed to get latest thread checkpoint runtime state:[\s\S]*return null/
    )
    expect(handler).not.toContain("withCheckpointer")
    expect(handler).not.toContain("getLatestRuntimeTuple")
    expect(handler).not.toContain("readLatestCheckpointTupleInWorker")
  })
})
