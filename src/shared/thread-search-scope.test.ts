import { describe, expect, it } from "vitest"
import { threadIncarnationKey } from "./thread-incarnation"
import { getDisplayThreadTitle, matchesOrdinaryThreadScope } from "./thread-search-scope"

describe("ordinary thread search scope", () => {
  it("includes inbox and scheduled threads and excludes sidebar project threads", () => {
    expect(matchesOrdinaryThreadScope({ metadata: { targetKind: "inbox" } })).toBe(true)
    expect(matchesOrdinaryThreadScope({ metadata: { source: "scheduled" } })).toBe(true)
    expect(
      matchesOrdinaryThreadScope({ metadata: { harnessFeature: { projectId: "", slug: "" } } })
    ).toBe(false)
    expect(
      matchesOrdinaryThreadScope({
        metadata: { harnessProjectSession: { projectId: "project", kind: "planning" } }
      })
    ).toBe(false)
    expect(
      matchesOrdinaryThreadScope({ metadata: { harnessFeature: { projectId: "project" } } })
    ).toBe(true)
  })

  it("keeps persisted workspace paths exact and distinguishes blank from all workspaces", () => {
    const thread = { metadata: { workspacePath: "C:\\Work" } }
    expect(matchesOrdinaryThreadScope(thread)).toBe(true)
    expect(matchesOrdinaryThreadScope(thread, "C:\\Work")).toBe(true)
    expect(matchesOrdinaryThreadScope(thread, "c:/Work")).toBe(false)
    expect(matchesOrdinaryThreadScope(thread, null)).toBe(false)
    expect(matchesOrdinaryThreadScope({ metadata: { workspacePath: "\t" } }, null)).toBe(true)
  })

  it("uses the sidebar's display prefixes and ID fallback", () => {
    const thread_id = "123456789012345678901"
    expect(getDisplayThreadTitle({ thread_id, title: "[定时] 每周汇总" })).toBe("每周汇总")
    expect(getDisplayThreadTitle({ thread_id, title: "[远端机器人] Inbox" })).toBe("(远端) Inbox")
    expect(getDisplayThreadTitle({ thread_id, title: " … " })).toBe("12345678901234567890...")
  })

  it("encodes token and legacy identity with distinct SQLite keys", () => {
    expect(threadIncarnationKey({ token: "17", legacyCreatedAt: 1 })).toBe("uuid:17")
    expect(threadIncarnationKey({ token: null, legacyCreatedAt: 17 })).toBe("legacy:17")
    expect(() => threadIncarnationKey({ token: null, legacyCreatedAt: NaN })).toThrow(TypeError)
  })
})
