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

  it("excludes a Host project stage from ordinary search even in a matching workspace", () => {
    const metadata = {
      workspacePath: "C:/project",
      hostProjectRuntime: {
        projectId: "project",
        operationId: "operation",
        stageId: "prd",
        pluginDigest: "a".repeat(64)
      }
    }
    expect(matchesOrdinaryThreadScope({ metadata })).toBe(false)
    expect(matchesOrdinaryThreadScope({ metadata }, "C:/project")).toBe(false)
  })

  it("keeps local Bot work searchable while excluding remote Bot and Host project histories", () => {
    const local = {
      botId: "assistant",
      botHostId: "local",
      botWorkId: "local-work",
      botAudienceKey: "desktop",
      workspacePath: "C:/work"
    }
    const remote = { ...local, botGroupId: "private-group", botAudienceKey: "im:private-group" }

    expect(matchesOrdinaryThreadScope({ metadata: local }, "C:/work")).toBe(true)
    expect(matchesOrdinaryThreadScope({ metadata: remote }, "C:/work")).toBe(false)
    expect(matchesOrdinaryThreadScope({
      metadata: { ...local, hostProjectRuntime: { projectId: "project" } }
    }, "C:/work")).toBe(false)
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
