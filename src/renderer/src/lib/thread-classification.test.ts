import { describe, expect, it } from "vitest"
import type { Thread } from "@/types"
import { findFirstChatThread, isRegularChatThread } from "./thread-classification"

const thread = (id: string, metadata: Record<string, unknown> = {}) =>
  ({ thread_id: id, metadata }) as Thread
describe("workspace thread selection", () => {
  it("does not select Bot or project sessions when opening the ordinary workbench", () => {
    const bot = thread("bot", { botId: "a" }),
      group = thread("group", { botId: "a", botGroupId: "g" })
    const project = thread("project", { harnessFeature: { projectId: "p", slug: "s" } })
    const chat = thread("chat"),
      older = thread("older")
    expect(findFirstChatThread([bot, group, project, chat, older])).toBe(chat)
    expect(findFirstChatThread([bot, group, project])).toBeNull()
    expect(isRegularChatThread(null)).toBe(false)
    expect(findFirstChatThread([chat, older])).toBe(chat)
  })
})
