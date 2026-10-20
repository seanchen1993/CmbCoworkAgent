import { describe, expect, it } from "vitest"
import type { Thread } from "@/types"
import {
  findFirstChatThread,
  isRegularChatThread,
  isManagedLocalWorkConversation
} from "./thread-classification"

const thread = (id: string, metadata: Record<string, unknown> = {}) =>
  ({ thread_id: id, metadata }) as Thread
describe("workspace thread selection", () => {
  it("resolves only desktop work candidates, leaving unrelated/project/remote views independent of the Bot backend", () => {
    const local = {
      botId: "owner",
      botHostId: "local",
      botWorkId: "work",
      botAudienceKey: "desktop"
    }
    expect(isManagedLocalWorkConversation(thread("work", local))).toBe(true)
    for (const metadata of [
      {},
      { botId: "owner" },
      { ...local, botGroupId: "group" },
      { ...local, botMockBindingId: "mock" },
      { ...local, harnessFeature: { projectId: "project", slug: "feature" } },
      { ...local, remoteState: "historical" },
      { ...local, remoteReadOnly: true },
      { ...local, targetKind: "inbox", imDeliveryContext: {} }
    ])
      expect(isManagedLocalWorkConversation(thread("unrelated", metadata))).toBe(false)
    expect(findFirstChatThread([thread("local-work", local)])?.thread_id).toBe("local-work")
  })

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
