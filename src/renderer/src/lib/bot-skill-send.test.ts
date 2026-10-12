import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { BotDomainError } from "../../../shared/bot-types"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import { parseBotComposerDraft } from "./bot-composer-draft"
import {
  composerDocument,
  composerDocumentChange,
  composerDraftSelectionQuotes
} from "./bot-composer-document"
import type { BotSelectionQuote } from "../../../shared/bot-selection-quotes"
const initial = useBotWorkspaceStore.getState()
const reference = { botId: "bot", id: "skill", version: 1, name: "评审流程" }
const send = vi.fn()
beforeEach(() => {
  const cache = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key)
  })
  vi.stubGlobal("window", { api: { bots: { send } } })
  send.mockReset()
  useBotWorkspaceStore.setState(
    {
      ...initial,
      drafts: {},
      pending: {},
      sending: {},
      uploading: {},
      host: {
        protocol: 1,
        hostId: "host",
        platform: "test",
        runtimeReady: true,
        error: null,
        capabilities: ["skill-references"]
      },
      loadMessages: async () => {},
      refresh: async () => {}
    },
    true
  )
  useBotWorkspaceStore.getState().draft("conversation", "请评审接口")
  useBotWorkspaceStore.getState().skills("conversation", [reference])
})
afterEach(() => {
  useBotWorkspaceStore.setState(initial, true)
  vi.unstubAllGlobals()
})

it("retains inline positions with the exact accepted nonce while a newer document is edited", async () => {
  const state = useBotWorkspaceStore.getState()
  useBotWorkspaceStore.setState({
    host: { ...state.host!, capabilities: ["skill-references", "inline-references"] }
  })
  const document = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "请使用" },
          { type: "botReference", attrs: { reference: { ...reference, kind: "skill" } } },
          { type: "text", text: "评审" }
        ]
      }
    ]
  }
  state.updateDraft("conversation", composerDocumentChange(document, state.drafts.conversation)!)
  send.mockRejectedValueOnce(new Error("reply lost"))
  await expect(state.send("conversation")).rejects.toThrow("reply lost")
  const pending = useBotWorkspaceStore.getState().pending.conversation
  expect(pending.inlineReferences).toEqual([
    { from: 3, to: 8, reference: { kind: "skill", botId: "bot", id: "skill", version: 1 } }
  ])
  expect(JSON.parse(localStorage.getItem("bot-pending:conversation")!).inlineReferences).toEqual(
    pending.inlineReferences
  )
  state.draft("conversation", "新任务")
  send.mockResolvedValueOnce({ messageId: "accepted", runIds: [] })
  await state.send("conversation")
  expect(send.mock.calls[1][0]).toEqual(pending)
  expect(useBotWorkspaceStore.getState().drafts.conversation.prompt).toBe("新任务")
})

it("retains the exact nonce and selected version after an unknown transport result", async () => {
  send.mockRejectedValueOnce(new BotDomainError("host_timeout", "unknown outcome"))
  await expect(useBotWorkspaceStore.getState().send("conversation")).rejects.toThrow("unknown")
  const pending = useBotWorkspaceStore.getState().pending.conversation
  expect(pending.skills).toEqual([{ botId: "bot", id: "skill", version: 1 }])
  useBotWorkspaceStore.getState().draft("conversation", "新的输入不要被重试覆盖")
  useBotWorkspaceStore.getState().skills("conversation", [{ ...reference, version: 2 }])
  send.mockResolvedValueOnce({ messageId: "accepted", runIds: ["run"] })
  await useBotWorkspaceStore.getState().send("conversation")
  expect(send.mock.calls[1][0]).toEqual(pending)
  expect(useBotWorkspaceStore.getState().drafts.conversation).toMatchObject({
    prompt: "新的输入不要被重试覆盖",
    skills: [{ ...reference, version: 2 }]
  })
  expect(useBotWorkspaceStore.getState().pending.conversation).toBeUndefined()
})

it("keeps the draft editable after a definite skill rejection across the Electron error envelope", async () => {
  send.mockResolvedValue({ botFailure: { code: "skill_changed", message: "请确认新版本" } })
  await expect(useBotWorkspaceStore.getState().send("conversation")).rejects.toThrow("新版本")
  expect(useBotWorkspaceStore.getState().pending.conversation).toBeUndefined()
  expect(useBotWorkspaceStore.getState().drafts.conversation.skills).toEqual([reference])
  expect(
    parseBotComposerDraft(JSON.parse(localStorage.getItem("bot-draft:conversation")!))?.skills
  ).toEqual([reference])
  useBotWorkspaceStore.getState().skills("conversation", [{ ...reference, version: 2 }])
  send.mockResolvedValueOnce({ messageId: "accepted", runIds: ["run"] })
  await useBotWorkspaceStore.getState().send("conversation")
  expect(send.mock.calls[1][0].nonce).not.toBe(send.mock.calls[0][0].nonce)
  expect(useBotWorkspaceStore.getState().drafts.conversation.skills).toEqual([])
})

it("preserves the same selected skill on a new task when an earlier receipt arrives", async () => {
  const state = useBotWorkspaceStore.getState()
  send.mockRejectedValueOnce(new BotDomainError("host_timeout", "unknown outcome"))
  await expect(state.send("conversation")).rejects.toThrow("unknown")
  state.draft("conversation", "第二个接口也按这个流程评审")
  state.skills("conversation", [reference])
  send.mockResolvedValueOnce({ messageId: "accepted", runIds: ["run"] })
  await state.send("conversation")
  expect(useBotWorkspaceStore.getState().drafts.conversation).toMatchObject({
    prompt: "第二个接口也按这个流程评审",
    skills: [reference]
  })
})

it("preserves a reused attachment and reply target after a delayed earlier receipt", async () => {
  useBotWorkspaceStore.setState({
    host: {
      ...useBotWorkspaceStore.getState().host!,
      capabilities: ["skill-references", "message-replies"]
    }
  })
  const state = useBotWorkspaceStore.getState()
  const attachment = { path: "file-id", name: "需求.md" }
  state.attachments("conversation", [attachment])
  state.reply("conversation", "same-message")
  send.mockRejectedValueOnce(new BotDomainError("host_timeout", "unknown outcome"))
  await expect(state.send("conversation")).rejects.toThrow("unknown")
  state.draft("conversation", "补充一个不同的问题")
  send.mockResolvedValueOnce({ messageId: "accepted", runIds: ["run"] })
  await state.send("conversation")
  expect(useBotWorkspaceStore.getState().drafts.conversation).toMatchObject({
    prompt: "补充一个不同的问题",
    attachments: [attachment],
    replyToId: "same-message"
  })
})

it("preserves an edited draft even when the user restores identical text", async () => {
  const state = useBotWorkspaceStore.getState()
  send.mockRejectedValueOnce(new BotDomainError("host_timeout", "unknown outcome"))
  await expect(state.send("conversation")).rejects.toThrow("unknown")
  state.draft("conversation", "临时修改")
  state.draft("conversation", "请评审接口")
  const newDraft = useBotWorkspaceStore.getState().drafts.conversation
  send.mockResolvedValueOnce({ messageId: "accepted", runIds: ["run"] })
  await state.send("conversation")
  expect(useBotWorkspaceStore.getState().drafts.conversation).toBe(newDraft)
})

it("restores receipt ownership across a renderer reload without exposing it to the Host", async () => {
  const state = useBotWorkspaceStore.getState()
  send.mockRejectedValueOnce(new BotDomainError("host_timeout", "unknown outcome"))
  await expect(state.send("conversation")).rejects.toThrow("unknown")
  const submitted = send.mock.calls[0][0]
  state.draft("conversation", "刷新后也应保留的新任务")
  useBotWorkspaceStore.setState({
    selected: null,
    drafts: {},
    pending: {},
    pendingDraftRevisions: {}
  })
  state.select("conversation", true)
  send.mockResolvedValueOnce({ messageId: "accepted", runIds: ["run"] })
  await state.send("conversation")
  expect(send.mock.calls[1][0]).toEqual(submitted)
  expect(send.mock.calls[1][0]).not.toHaveProperty("draftRevision")
  expect(useBotWorkspaceStore.getState().drafts.conversation).toMatchObject({
    prompt: "刷新后也应保留的新任务",
    skills: [reference]
  })
})

it("settles an unchanged draft and its receipt in one store update", async () => {
  const state = useBotWorkspaceStore.getState()
  state.attachments("conversation", [{ path: "attachment", name: "规范.md" }])
  const observed: Array<{ prompt: string; pending: boolean; skills: number; files: number }> = []
  const unsubscribe = useBotWorkspaceStore.subscribe((next, previous) => {
    if (next.drafts.conversation !== previous.drafts.conversation)
      observed.push({
        prompt: next.drafts.conversation.prompt,
        pending: !!next.pending.conversation,
        skills: next.drafts.conversation.skills?.length ?? 0,
        files: next.drafts.conversation.attachments.length
      })
  })
  try {
    send.mockResolvedValueOnce({ messageId: "accepted", runIds: ["run"] })
    await state.send("conversation")
  } finally {
    unsubscribe()
  }
  expect(observed).toEqual([{ prompt: "", pending: false, skills: 0, files: 0 }])
  expect(localStorage.getItem("bot-pending:conversation")).toBeNull()
  expect(JSON.parse(localStorage.getItem("bot-draft:conversation")!).prompt).toBe("")
})

it("does not overwrite another window's stored draft or retry", async () => {
  const state = useBotWorkspaceStore.getState()
  let accept!: () => void
  send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve
      })
  )
  const sending = state.send("conversation")
  const stored = {
    prompt: "另一个窗口的新输入",
    attachments: [],
    revision: crypto.randomUUID(),
    dataEpoch: "initial"
  }
  const retry = {
    nonce: "other-window",
    conversationId: "conversation",
    text: "another send",
    dataEpoch: "initial"
  }
  localStorage.setItem("bot-draft:conversation", JSON.stringify(stored))
  localStorage.setItem("bot-pending:conversation", JSON.stringify(retry))
  accept()
  await sending
  expect(JSON.parse(localStorage.getItem("bot-draft:conversation")!)).toEqual(stored)
  expect(JSON.parse(localStorage.getItem("bot-pending:conversation")!)).toEqual(retry)
})

it("can settle a legacy pending message without draft revision metadata", async () => {
  const state = useBotWorkspaceStore.getState()
  const input = {
    nonce: "legacy",
    conversationId: "conversation",
    text: "请评审接口",
    attachments: [],
    skills: [{ botId: "bot", id: "skill", version: 1 }]
  }
  localStorage.setItem("bot-pending:conversation", JSON.stringify(input))
  useBotWorkspaceStore.setState({ selected: null, pending: {}, pendingDraftRevisions: {} })
  state.select("conversation", true)
  send.mockResolvedValueOnce({ messageId: "accepted", runIds: ["run"] })
  await state.send("conversation")
  expect(send.mock.calls[0][0]).toEqual(input)
  expect(useBotWorkspaceStore.getState().drafts.conversation.prompt).toBe("")
})

/** Reuse the existing send fixture and serializer; only the Host boundary is mocked. */
function draftWithSelectionQuote() {
  const state = useBotWorkspaceStore.getState()
  useBotWorkspaceStore.setState({
    host: { ...state.host!, capabilities: ["skill-references", "selection-quotes-v1"] }
  })
  state.attachments("conversation", [{ path: "artifact-id", name: "接口规范.md" }])
  const draft = useBotWorkspaceStore.getState().drafts.conversation
  const quote: BotSelectionQuote = {
    sourceMessageId: "quoted-message",
    sourceConversationId: "conversation",
    sourceSequence: 7,
    sourceDataEpoch: "initial",
    sourceFragment: { from: 0, to: 4 },
    selection: { from: 0, to: 4 },
    text: "接口要求",
    truncated: false
  }
  const document = composerDocument(draft)
  state.updateDraft(
    "conversation",
    composerDocumentChange(
      {
        ...document,
        content: [
          ...document.content,
          { type: "paragraph", content: [{ type: "quoteReference", attrs: { quote } }] }
        ]
      },
      draft
    )!
  )
  return useBotWorkspaceStore.getState().drafts.conversation
}

it.each(["invalid_selection_quote", "selection_quote_scope", "selection_quote_unavailable"])(
  "releases a definitely refused quote (%s) so removing it sends a new nonce without losing the draft",
  async (code) => {
    const submittedDraft = draftWithSelectionQuote()
    const state = useBotWorkspaceStore.getState()
    const quotes = composerDraftSelectionQuotes(submittedDraft)
    expect(quotes).toHaveLength(1)
    send.mockResolvedValueOnce({ botFailure: { code, message: "引用已失效，请重新选择" } })
    await expect(state.send("conversation")).rejects.toThrow("引用已失效")
    const rejected = send.mock.calls[0][0]
    expect(rejected.selectionQuotes).toEqual(quotes)
    expect(useBotWorkspaceStore.getState().pending.conversation).toBeUndefined()
    expect(useBotWorkspaceStore.getState().pendingDraftRevisions.conversation).toBeUndefined()
    expect(localStorage.getItem("bot-pending:conversation")).toBeNull()
    expect(useBotWorkspaceStore.getState().drafts.conversation).toBe(submittedDraft)
    expect(
      parseBotComposerDraft(JSON.parse(localStorage.getItem("bot-draft:conversation")!))
    ).toEqual(submittedDraft)

    // Simulate removing only the quote atom through the real editor serializer.
    const document = composerDocument(submittedDraft)
    state.updateDraft(
      "conversation",
      composerDocumentChange(
        {
          ...document,
          content: document.content.filter(
            (node) => !node.content?.some((child) => child.type === "quoteReference")
          )
        },
        submittedDraft
      )!
    )
    const repaired = useBotWorkspaceStore.getState().drafts.conversation
    expect(composerDraftSelectionQuotes(repaired)).toEqual([])
    expect(repaired).toMatchObject({
      prompt: "/评审流程 请评审接口",
      attachments: submittedDraft.attachments,
      skills: [reference]
    })
    send.mockResolvedValueOnce({ messageId: "accepted", runIds: ["run"] })
    await state.send("conversation")
    expect(send.mock.calls[1][0].nonce).not.toBe(rejected.nonce)
    expect(send.mock.calls[1][0]).toMatchObject({
      text: "/评审流程 请评审接口",
      attachments: ["artifact-id"],
      skills: [{ botId: "bot", id: "skill", version: 1 }]
    })
    expect(send.mock.calls[1][0]).not.toHaveProperty("selectionQuotes")
  }
)

it("retries an unknown quoted send with the persisted old nonce after reload and preserves a newer draft", async () => {
  const submittedDraft = draftWithSelectionQuote()
  const state = useBotWorkspaceStore.getState()
  send.mockRejectedValueOnce(new Error("socket closed before receipt"))
  await expect(state.send("conversation")).rejects.toThrow("socket closed")
  const submitted = send.mock.calls[0][0]
  expect(useBotWorkspaceStore.getState().pending.conversation).toEqual(submitted)
  expect(JSON.parse(localStorage.getItem("bot-pending:conversation")!)).toMatchObject({
    nonce: submitted.nonce,
    selectionQuotes: submitted.selectionQuotes,
    draftRevision: submittedDraft.revision,
    dataEpoch: "initial"
  })
  state.draft("conversation", "新的任务，保留附件")
  useBotWorkspaceStore.setState({
    selected: null,
    drafts: {},
    pending: {},
    pendingDraftRevisions: {}
  })
  state.select("conversation", true)
  send.mockResolvedValueOnce({ messageId: "accepted-original", runIds: ["run"] })
  await state.send("conversation")
  expect(send.mock.calls[1][0]).toEqual(submitted)
  expect(send.mock.calls[1][0]).not.toHaveProperty("draftRevision")
  expect(send.mock.calls[1][0]).not.toHaveProperty("dataEpoch")
  expect(useBotWorkspaceStore.getState().pending.conversation).toBeUndefined()
  expect(localStorage.getItem("bot-pending:conversation")).toBeNull()
  expect(useBotWorkspaceStore.getState().drafts.conversation).toMatchObject({
    prompt: "新的任务，保留附件",
    attachments: submittedDraft.attachments,
    skills: [reference]
  })
})
