import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./threads.ts", import.meta.url), "utf8")

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
    expect(handler.indexOf("isThreadForkBusy(")).toBeLessThan(
      handler.indexOf("performThreadDeletion(event, threadId, options?.groupGuard)")
    )
    expect(handler).toContain("isExternallyManagedThreadRunBusy(threadId, metadata!)")
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
    const deletionIndex = handler.indexOf("performThreadDeletion(event, threadId, options?.groupGuard)")

    expect(handler).toContain("normalizeThreadDeleteOptions(rawOptions)")
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(incarnationIndex).toBeGreaterThan(lockIndex)
    expect(membershipIndex).toBeGreaterThan(incarnationIndex)
    expect(deletionIndex).toBeGreaterThan(membershipIndex)
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
    expect(handler).toContain("readLatestCheckpointTupleInWorker")
    expect(handler).toContain("messageLimit: 0")
    expect(handler).toContain("messageByteBudget: 0")
    expect(handler).toContain("foregroundKey: `thread-hydration:${event.sender.id}`")
    expect(handler).toContain("isCheckpointRuntimeProjectionCancelled(e)")
    expect(handler).toContain("throw e")
    expect(handler).not.toMatch(
      /Failed to get latest thread checkpoint runtime state:[\s\S]*return null/
    )
    expect(handler).not.toContain("withCheckpointer")
    expect(handler).not.toContain("getLatestRuntimeTuple")
  })
})
