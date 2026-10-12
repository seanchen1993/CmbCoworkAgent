import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import { parseBotComposerDraft } from "./bot-composer-draft"
import type { BotMessage } from "../../../shared/bot-types"
import { BotDomainError } from "../../../shared/bot-types"
import { replyQuoteLabel } from "../components/bots/upstream/grok-reply-preview"

const initial = useBotWorkspaceStore.getState(),
  send = vi.fn(),
  message = vi.fn(),
  messages = vi.fn()
const entry = (id: string, sequence: number): BotMessage => ({
  id,
  sequence,
  conversationId: "conversation",
  sender: "user",
  botId: null,
  text: id,
  runId: null,
  replyTo: null,
  attachments: [],
  createdAt: 1
})
beforeEach(() => {
  const cache = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key)
  })
  vi.stubGlobal("window", { api: { bots: { send, message, messages } } })
  send.mockReset()
  message.mockReset()
  messages.mockReset()
  useBotWorkspaceStore.setState(
    {
      ...initial,
      selected: "conversation",
      messages: {},
      drafts: {},
      pending: {},
      sending: {},
      opening: {},
      host: {
        protocol: 1,
        hostId: "test",
        runtimeReady: true,
        error: null,
        platform: "test",
        capabilities: ["message-replies"]
      },
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

it("persists the target, retries exactly, and preserves a new reply composed while the receipt is unknown", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft("conversation", "修改第二项")
  state.reply("conversation", "original")
  expect(
    parseBotComposerDraft(JSON.parse(localStorage.getItem("bot-draft:conversation")!))?.replyToId
  ).toBe("original")
  send.mockRejectedValueOnce(new Error("socket closed"))
  await expect(state.send("conversation")).rejects.toThrow("socket")
  const accepted = useBotWorkspaceStore.getState().pending.conversation
  expect(accepted.replyTo).toBe("original")
  state.draft("conversation", "另外一个问题")
  state.reply("conversation", "new-target")
  send.mockResolvedValueOnce({ messageId: "ok", runIds: [] })
  await state.send("conversation")
  expect(send.mock.calls[1][0]).toEqual(accepted)
  expect(useBotWorkspaceStore.getState().drafts.conversation).toMatchObject({
    prompt: "另外一个问题",
    replyToId: "new-target"
  })
  send.mockResolvedValueOnce({ messageId: "new-ok", runIds: [] })
  await state.send("conversation")
  expect(useBotWorkspaceStore.getState().drafts.conversation.replyToId).toBeUndefined()
})

it("keeps a rejected reply editable, and never silently drops a reply for an older Host", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft("conversation", "内容")
  state.reply("conversation", "missing")
  send.mockRejectedValueOnce(new BotDomainError("reply_unavailable", "原消息不可用"))
  await expect(state.send("conversation")).rejects.toThrow("不可用")
  expect(useBotWorkspaceStore.getState().pending.conversation).toBeUndefined()
  expect(useBotWorkspaceStore.getState().drafts.conversation.replyToId).toBe("missing")
  useBotWorkspaceStore.setState({
    host: { ...useBotWorkspaceStore.getState().host!, capabilities: [] }
  })
  await expect(state.send("conversation")).rejects.toThrow("升级")
  expect(send).toHaveBeenCalledTimes(1)
})

it("loads a contiguous window around an old quote and ignores a result after leaving the conversation", async () => {
  message.mockResolvedValueOnce(entry("target", 51))
  messages.mockImplementation(({ before }) =>
    Promise.resolve(
      before
        ? Array.from({ length: 50 }, (_, i) => entry(`old-${i}`, i + 1))
        : Array.from({ length: 50 }, (_, i) => entry(`new-${i}`, i + 52))
    )
  )
  await useBotWorkspaceStore.getState().jumpToMessage("conversation", "target")
  const state = useBotWorkspaceStore.getState()
  expect(state.messages.conversation).toHaveLength(101)
  expect(state.messages.conversation[50].id).toBe("target")
  expect(state.hasNewer.conversation).toBe(true)
  expect(state.hasOlder.conversation).toBe(true)
  expect(state.opening.conversation).toBe(false)
  let resolve!: (value: BotMessage) => void
  message.mockImplementationOnce(
    () =>
      new Promise<BotMessage>((done) => {
        resolve = done
      })
  )
  const pending = state.jumpToMessage("conversation", "elsewhere")
  useBotWorkspaceStore.setState({ selected: "another" })
  resolve(entry("elsewhere", 1000))
  await pending
  expect(useBotWorkspaceStore.getState().messages.conversation).toEqual(state.messages.conversation)
})

it("retains Grok's compact quote normalization and rejects malformed persisted targets", () => {
  expect(replyQuoteLabel({ kind: "assistant-text", text: " a\n\t b " })).toBe("a b")
  expect(replyQuoteLabel({ kind: "user-text", text: "a".repeat(200) })).toHaveLength(96)
  expect(parseBotComposerDraft({ prompt: "a", attachments: [], replyToId: "../../x" })).toBeNull()
})
