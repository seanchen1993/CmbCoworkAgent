import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { BotDomainError } from "../../../shared/bot-types"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import { parseBotComposerDraft, parseStoredBotDraft } from "./bot-composer-draft"

const initial = useBotWorkspaceStore.getState(),
  send = vi.fn()
beforeEach(() => {
  const cache = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key)
  })
  vi.stubGlobal("window", { api: { bots: { send, messages: async () => [] } } })
  send.mockReset()
  useBotWorkspaceStore.setState(
    {
      ...initial,
      drafts: {},
      pending: {},
      sending: {},
      uploading: {},
      loadMessages: async () => {},
      refresh: async () => {}
    },
    true
  )
})
afterEach(() => {
  useBotWorkspaceStore.setState(initial, true)
  vi.unstubAllGlobals()
})

it("retains typed references in drafts and strips object identities after a restored data epoch", () => {
  const state = useBotWorkspaceStore.getState()
  state.draft("direct", "请检查")
  state.references("direct", [{ kind: "routine", id: "routine-1", name: "日检", botId: "owner" }])
  const saved = JSON.parse(localStorage.getItem("bot-draft:direct")!)
  expect(parseBotComposerDraft(saved)?.references).toEqual([
    { kind: "routine", id: "routine-1", name: "日检", botId: "owner" }
  ])
  expect(parseStoredBotDraft(saved, "restored")?.references).toBeUndefined()
  expect(parseStoredBotDraft(saved, "restored")?.prompt).toBe("请检查")
})

it("retries exact reference IDs and preserves references for a newer task to the same object", async () => {
  useBotWorkspaceStore.setState({
    host: {
      protocol: 1,
      hostId: "host",
      platform: "darwin",
      runtimeReady: true,
      error: null,
      capabilities: ["entity-references"]
    }
  })
  const state = useBotWorkspaceStore.getState(),
    references = [{ kind: "bot" as const, id: "same-bot", name: "旧名称" }]
  state.draft("direct", "第一项")
  state.references("direct", references)
  send.mockRejectedValueOnce(new Error("socket closed"))
  await expect(state.send("direct")).rejects.toThrow("socket")
  const pending = useBotWorkspaceStore.getState().pending.direct
  expect(pending.references).toEqual([{ kind: "bot", id: "same-bot" }])
  state.draft("direct", "第二项")
  state.references("direct", [{ ...references[0], name: "新名称" }])
  send.mockResolvedValue({ messageId: "accepted", runIds: [] })
  await state.send("direct")
  expect(send.mock.calls[1][0]).toEqual(pending)
  expect(useBotWorkspaceStore.getState().drafts.direct.references?.[0].name).toBe("新名称")
  await state.send("direct")
  expect(useBotWorkspaceStore.getState().drafts.direct.references).toEqual([])
})

it("keeps a deleted-reference rejection editable and refuses silent downgrade to text", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft("direct", "检查")
  state.references("direct", [{ kind: "routine", id: "deleted", name: "已删除" }])
  await expect(state.send("direct")).rejects.toThrow("升级")
  expect(send).not.toHaveBeenCalled()
  useBotWorkspaceStore.setState({
    host: {
      protocol: 1,
      hostId: "host",
      platform: "darwin",
      runtimeReady: true,
      error: null,
      capabilities: ["entity-references"]
    }
  })
  send.mockRejectedValueOnce(new BotDomainError("reference_unavailable", "重新选择"))
  await expect(state.send("direct")).rejects.toThrow("重新选择")
  expect(useBotWorkspaceStore.getState().pending.direct).toBeUndefined()
  expect(useBotWorkspaceStore.getState().drafts.direct.references?.[0].id).toBe("deleted")
})

it("restores stable recipients with each conversation draft and rejects corrupt selection data", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft("group", "请评审")
  state.recipients("group", ["b", "a"])
  const saved = JSON.parse(localStorage.getItem("bot-draft:group")!)
  expect(parseBotComposerDraft(saved)?.recipients).toEqual(["b", "a"])
  state.select("other")
  useBotWorkspaceStore.setState({ drafts: {} })
  state.select("group")
  expect(useBotWorkspaceStore.getState().drafts.group).toMatchObject({
    prompt: "请评审",
    recipients: ["b", "a"]
  })
  expect(parseBotComposerDraft({ ...saved, recipients: ["a", "a"] })).toBeNull()
  expect(parseBotComposerDraft({ ...saved, recipients: ["not an id"] })).toBeNull()
})

it("retries the original recipients and keeps a newer selection while an older receipt is unknown", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft("group", "第一项")
  state.recipients("group", ["first"])
  send.mockRejectedValueOnce(new Error("socket closed"))
  await expect(state.send("group")).rejects.toThrow("socket")
  const pending = useBotWorkspaceStore.getState().pending.group
  expect(pending.recipients).toEqual(["first"])
  state.draft("group", "另一项")
  state.recipients("group", ["second"])
  send.mockResolvedValue({ messageId: "accepted", runIds: [] })
  await state.send("group")
  expect(send.mock.calls[1][0]).toEqual(pending)
  expect(useBotWorkspaceStore.getState().drafts.group).toMatchObject({
    prompt: "另一项",
    recipients: ["second"]
  })
  await state.send("group")
  expect(send.mock.calls[2][0].recipients).toEqual(["second"])
  expect(useBotWorkspaceStore.getState().drafts.group.recipients).toEqual([])
})

it("keeps removed-member rejections editable instead of locking the user into an invalid retry", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft("group", "工作")
  state.recipients("group", ["removed"])
  send.mockRejectedValueOnce(new BotDomainError("invalid_recipient", "重新选择"))
  await expect(state.send("group")).rejects.toThrow("重新选择")
  expect(useBotWorkspaceStore.getState().pending.group).toBeUndefined()
  expect(useBotWorkspaceStore.getState().drafts.group.recipients).toEqual(["removed"])
  state.recipients("group", ["current"])
  send.mockResolvedValue({ messageId: "accepted", runIds: [] })
  await state.send("group")
  expect(send.mock.calls[1][0].nonce).not.toBe(send.mock.calls[0][0].nonce)
})

it("keeps recipients when the user writes a different task to the same Bot during an uncertain send", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft("group", "第一项")
  state.recipients("group", ["same-bot"])
  send.mockRejectedValueOnce(new Error("socket closed"))
  await expect(state.send("group")).rejects.toThrow("socket")
  state.draft("group", "第二项")
  send.mockResolvedValue({ messageId: "accepted", runIds: [] })
  await state.send("group")
  expect(useBotWorkspaceStore.getState().drafts.group).toMatchObject({
    prompt: "第二项",
    recipients: ["same-bot"]
  })
})
