import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./threads.ts", import.meta.url), "utf8")

describe("threads:get hydration contract", () => {
  it("uses narrow core and projected values reads under the thread lock", () => {
    const start = source.indexOf('ipcMain.handle("threads:get"')
    const end = source.indexOf('ipcMain.handle("threads:messages"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("withThreadRunMutationLock(threadId")
    expect(handler).toContain("getThreadCore(threadId)")
    expect(handler).toContain("ensureSubagentTranscriptRows(threadId)")
    expect(handler).toContain("getThreadHydrationValuesJson(threadId)")
    expect(handler).not.toMatch(/\bgetThread\(threadId\)/)
    expect(handler).not.toContain("SELECT *")
  })

  it("filters all legacy lifetime maps from update and merge payloads", () => {
    const filterStart = source.indexOf("function threadValuesWithoutSubagentTranscripts")
    const filterEnd = source.indexOf("const checkedLegacySubagentTranscriptThreads", filterStart)
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
})
