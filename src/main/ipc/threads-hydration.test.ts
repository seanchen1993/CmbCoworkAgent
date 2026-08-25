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
    const start = source.indexOf('ipcMain.handle("threads:delete"')
    const end = source.indexOf('// Get thread history', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler.indexOf("cancelLegacySubagentTranscriptMigration(threadId)")).toBeLessThan(
      handler.indexOf("withThreadRunMutationLock(threadId")
    )
    expect(handler.indexOf("cancelLegacyCheckpointTranscriptBootstrap(threadId)")).toBeLessThan(
      handler.indexOf("withThreadRunMutationLock(threadId")
    )
    const deleteIndex = source.indexOf("dbDeleteThread(threadId)")
    const forgetIndex = source.indexOf("forgetLegacySubagentTranscriptMigration(threadId)")
    expect(deleteIndex).toBeGreaterThanOrEqual(0)
    expect(forgetIndex).toBeGreaterThan(deleteIndex)
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
    expect(handler).not.toContain("withCheckpointer")
    expect(handler).not.toContain("getLatestRuntimeTuple")
  })
})
