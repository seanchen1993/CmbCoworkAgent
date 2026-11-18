import { webcrypto } from "node:crypto"
import { Children, isValidElement, type ReactElement } from "react"
import { beforeEach, expect, it, vi } from "vitest"
import type { BotClient, BotDefinition, BotMessageMention, BotMessageReply, BotTask, SendBotMessageInput } from "../../../shared/bots/contracts"
import type { BotWorkItem, CreateBotWorkInput } from "../../../shared/bots/work"
import { buildAttachmentMessageParts } from "../../../shared/attachment-message-parts"
import { botInputFileIds } from "../../../shared/bots/input-files"
import type { FileAttachment } from "../../../shared/file-attachment"
import type { QueuedMessage, SkillMetadata, Thread } from "../types"
import type { ThreadActions } from "./thread-context"
import { formatSkillUseBlock } from "../../../shared/skill-use-block"
import { resolveAtFileAttachments } from "../features/mentions/atFileAttachments"
import { configureAppCatalogLoaders, invalidateSkillCatalog, resetAppCatalogCacheForTests,
  revalidateSkillCatalog } from "./app-catalog-cache"

// Drive the actual conversation and dialog callbacks with the renderer queue contract.
type Queue = Pick<ThreadActions, "getQueuedMessage" | "updateQueuedMessage" | "deleteQueuedMessage">
const hooks = vi.hoisted(() => ({
  cursor: 0, slots: [] as unknown[], queue: {} as Queue,
  effects: [] as Array<() => void | (() => void)>,
  threads: [] as Thread[],
  addThreadSummary: vi.fn<(thread: Thread) => void>()
}))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect) },
  useState(initial: unknown) {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = initial
    return [hooks.slots[index], (next: unknown) => {
      hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next
    }]
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }
    return hooks.slots[index]
  }
}))
vi.mock("./thread-context", () => ({
  useThreadContext: () => ({ getThreadActions: () => hooks.queue }),
  useThreadStateSelector: () => "[]"
}))
vi.mock("./store", () => {
  const getState = () => ({ threads: hooks.threads, addThreadSummary: hooks.addThreadSummary, pluginVersion: 1 })
  return { useAppStore: Object.assign((select: (state: ReturnType<typeof getState>) => unknown) =>
    select(getState()), { getState }) }
})
vi.mock("./bot-conversation-draft", async original => ({
  ...await original<typeof import("./bot-conversation-draft")>(),
  bindBotConversationDraft: vi.fn()
}))
vi.mock("@/components/chat/ChatContainer", () => ({ ChatContainer: () => null }))
vi.mock("../components/bots/BotConversationTools", () => ({ BotConversationTools: () => null }))
vi.mock("../components/bots/BotMessageReactions", () => ({ BotMessageReactionsProvider: () => null }))
vi.mock("../components/bots/BotMessageFilePreview", () => ({ BotMessageFilePreview: () => null }))
vi.mock("../components/bots/BotWorkControl", () => ({
  BotWorkControl: () => null,
  botWorkControlColor: vi.fn()
}))
vi.mock("../components/bots/BotWorkQuestions", () => ({ BotWorkQuestions: () => null }))

import { ChatContainer } from "@/components/chat/ChatContainer"
import { BotConversation } from "../components/bots/BotConversation"
import { BotSkillTargetDialog } from "../components/bots/BotSkillTargetDialog"
import { DialogContent } from "../components/ui/dialog"

function find<P>(node: unknown, type: unknown): ReactElement<P> | undefined {
  if (!isValidElement<{ children?: React.ReactNode }>(node)) return undefined
  if (node.type === type) return node as ReactElement<P>
  for (const child of Children.toArray(node.props.children)) {
    const match = find<P>(child, type)
    if (match) return match
  }
  return undefined
}

const explicitSkill = { name: "review", path: "/skills/review/SKILL.md" }
const enabledSkill: SkillMetadata = {
  ...explicitSkill, id: "review", description: "Review the result", source: "user", version: "1.0.0"
}
const loadSkills = vi.fn(async () => ({ localSkills: [enabledSkill], pluginSkills: [], disabledSkillIds: [] as string[] }))
const inputFileIds = ["input-2e31f056-d6e5-4f12-b637-7182b9a82ea8"]
const pickerAttachment: FileAttachment = {
  filename: "sample.csv", filePath: "shared/sample.csv", content: "price\n5", size: 7,
  mimeType: "text/csv", truncated: false, botInputId: inputFileIds[0]
}
const invalidDirectory = { kind: "create", title: "Original title", path: "/missing" } as const

beforeEach(() => {
  resetAppCatalogCacheForTests()
  loadSkills.mockReset().mockResolvedValue({ localSkills: [enabledSkill], pluginSkills: [], disabledSkillIds: [] })
  configureAppCatalogLoaders({ skills: loadSkills, plugins: async () => [] })
  hooks.cursor = 0
  hooks.slots = [true] // Conversation is mounted and the queue is hydrated.
  hooks.effects = []
  hooks.threads = []
  hooks.addThreadSummary.mockReset().mockImplementation(thread => {
    hooks.threads = [thread, ...hooks.threads.filter(row => row.thread_id !== thread.thread_id)]
  })
})

function fixture(mentions?: BotMessageMention[], attachments = [pickerAttachment], botReplyTo?: BotMessageReply) {
  const ids = botInputFileIds(attachments)
  const original = { id: "original-request", text: mentions ? "@Peer Check the sample." : "Check the sample.",
    botExplicitSkill: explicitSkill, ...(mentions ? { botMentions: mentions } : {}),
    ...(botReplyTo ? { botReplyTo } : {}),
    ...(ids.length ? { botInputFileIds: ids } : {}),
    ...buildAttachmentMessageParts(attachments), created_at: new Date(1), updated_at: new Date(1) }
  let queued: QueuedMessage | undefined = original
  hooks.queue = {
    getQueuedMessage: () => queued,
    updateQueuedMessage: (_id, patch, done) => {
      if (queued) queued = { ...queued, ...patch, updated_at: new Date(queued.updated_at.getTime() + 1) }
      done?.(null)
    },
    deleteQueuedMessage: (_id, done) => {
      queued = undefined
      done?.(null)
    }
  }
  const work = { id: "work-1", botId: "bot", threadId: "work-thread", title: "Existing work",
    audienceKey: "desktop", state: "active" } as BotWorkItem
  const bot = { id: "bot", hostId: "local", threadId: "main", name: "Example" } as BotDefinition
  const validateSkillWorkspace = vi.fn<NonNullable<NonNullable<BotClient["works"]>["validateSkillWorkspace"]>>()
  const create = vi.fn(async (input: CreateBotWorkInput) => ({
    work, task: { workId: work.id, origin: { kind: "user", explicitSkill: input.explicitSkill } }
  }))
  const get = vi.fn(async () => work)
  const send = vi.fn(async (input: SendBotMessageInput) => ({
    ...input, threadId: work.threadId, origin: { kind: "user", explicitSkill: input.explicitSkill, inputFileIds: input.inputFileIds }
  }))
  const requestReceipts = vi.fn<BotClient["requestReceipts"]>(async (_botId, checks) =>
    checks.map(({ requestId }) => ({ requestId, state: "absent" })))
  const messageReply = vi.fn<BotClient["messageReply"]>()
  if (botReplyTo) messageReply.mockResolvedValue(botReplyTo)
  const onOpenWork = vi.fn()
  const expose = vi.fn<NonNullable<BotClient["conversations"]>["expose"]>()
  const cancel = vi.fn<BotClient["cancel"]>()
  const stopConversation = vi.fn<BotClient["stopConversation"]>()
  const client = { hostId: "local", works: { validateSkillWorkspace, create, get },
    conversations: { expose }, send, requestReceipts, messageReply, cancel, stopConversation } as unknown as BotClient
  const workDirectory: NonNullable<Parameters<typeof BotConversation>[0]["workDirectory"]> = {
    items: [work], priority: [], selected: null, cursor: null, query: "", setQuery: vi.fn(),
    loading: false, error: null, refresh: async () => {}, more: async () => {},
    current: { current: { botId: bot.id, selectedId: null, audience: "desktop" } }
  }
  const render = (task?: BotWorkItem, tasks: BotTask[] = [], backgroundBusy = false) => {
    hooks.cursor = 0
    hooks.effects = []
    return BotConversation({
      bot, bots: [bot], tasks, schedules: [], backgroundBusy, client,
      workDirectory,
      ...(task ? { work: task } : {}),
      onOpenWork
    })
  }
  const dialog = () => find<Parameters<typeof BotSkillTargetDialog>[0]>(render(), BotSkillTargetDialog)?.props
  const sendDefault = () => find<Parameters<typeof ChatContainer>[0]>(render(), ChatContainer)!.props.managedTurn!.submitDraft!(queued!)
  // These cases exercise the user's optional choice of a specific destination and its retry.
  const submit = () => {
    if (queued?.botSkillTarget || queued?.handoffRequestedAt || queued?.botHandoffTarget) return sendDefault()
    return find<Parameters<typeof ChatContainer>[0]>(render(), ChatContainer)!.props.managedTurn!.chooseSkillTarget!(queued!)
  }
  return { queued: () => queued, submit, sendDefault, dialog, render, work, original,
    validateSkillWorkspace, create, get, send, requestReceipts, messageReply, onOpenWork, expose, cancel, stopConversation,
    error: () => hooks.slots[1] }
}

it("sends a fresh slash selection through the main host without a destination dialog", async () => {
  const f = fixture()
  f.send.mockImplementationOnce(async (input) => ({ ...input, threadId: "main",
    origin: { kind: "user", explicitSkill: input.explicitSkill, inputFileIds: input.inputFileIds } }))
  await f.sendDefault()
  expect(f.dialog()).toBeUndefined()
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ explicitSkill, requestId: f.original.id }))
  expect(f.create).not.toHaveBeenCalled()
})

it("stops only the running reply from a managed task, preserving the queued follow-up", async () => {
  const f = fixture()
  const running = { id: "running-task", state: "running", threadId: f.work.threadId,
    workId: f.work.id, message: "Original work", origin: { kind: "user" } } as BotTask
  const queued = { ...running, id: "pending-supplement", state: "queued" as const }
  const chat = find<Parameters<typeof ChatContainer>[0]>(f.render(f.work, [queued, running]), ChatContainer)!
  expect(chat.props.managedTurn!.showReadOnlyStop).toBe(true)
  await chat.props.managedTurn!.cancel()
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(running.id)
  expect(f.stopConversation).not.toHaveBeenCalled()
})

it("keeps the work busy without offering to stop a reply when only background activity remains", () => {
  const f = fixture()
  const chat = find<Parameters<typeof ChatContainer>[0]>(f.render(f.work, [], true), ChatContainer)!
  expect(chat.props.managedTurn).toMatchObject({ busy: true, showReadOnlyStop: false })
})

it.each([
  { kind: "work", workId: "work-1" },
  { kind: "create", title: "Review report", path: "/selected" }
] as const)("keeps a fresh skill's original target and editable stale quote for %s", async target => {
  const quote = { id: "message-before-upgrade", ordinal: 7, role: "user" as const, text: "Original body" }
  const f = fixture(undefined, undefined, quote)
  f.messageReply.mockResolvedValue({ ...quote, text: "Allowed body" })
  await f.submit()
  f.dialog()!.choose(target)
  await vi.waitFor(() => expect(f.error()).toContain("取消回复"))
  expect(f.messageReply).toHaveBeenCalledExactlyOnceWith("bot", quote.id)
  expect(f.queued()).toMatchObject({ ...f.original, updated_at: expect.any(Date), botSkillTarget: target })
  expect(f.queued()?.handoffRequestedAt).toBeUndefined()
  expect(f.queued()?.botHandoffTarget).toBeUndefined()
  expect(f.send).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()

  hooks.queue.updateQueuedMessage(f.original.id, { botReplyTo: undefined })
  await f.submit()
  const submit = target.kind === "work" ? f.send : f.create
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputFileIds, explicitSkill }))
  expect(f.queued()).toBeUndefined()
})

it.each([
  [{ kind: "main" }, [enabledSkill], ["review"]],
  [{ kind: "work", workId: "work-1" }, [{ ...enabledSkill, name: "Replacement" }], []],
  [{ kind: "create", title: "Review report", path: "/valid" }, [{ ...enabledSkill, path: "/other/SKILL.md" }], []]
] as const)("keeps the queued skill and attachments when the selection changes while choosing %j", async (target, skills, disabled) => {
  const f = fixture()
  await revalidateSkillCatalog(1)
  await f.submit()
  expect(f.dialog()).toBeDefined()

  loadSkills.mockResolvedValue({ localSkills: [...skills], pluginSkills: [], disabledSkillIds: [...disabled] })
  invalidateSkillCatalog()
  f.dialog()!.choose(target)
  await vi.waitFor(() => expect(f.dialog()?.error ?? f.error()).toContain("原技能已不可用"))
  expect(f.queued()).toMatchObject({ ...f.original, updated_at: expect.any(Date) })
  expect(f.queued()?.handoffRequestedAt).toBeUndefined()
  expect(f.send).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(loadSkills).toHaveBeenCalledTimes(2)
})

it.each(["accepted", "absent"] as const)(
  "looks up an uncertain skill send before checking an invalidated catalog (%s)", async receipt => {
    vi.stubGlobal("crypto", webcrypto)
    try {
      const f = fixture()
      f.send.mockRejectedValueOnce(new Error("回复未到达"))
      await f.submit()
      f.dialog()!.choose({ kind: "work", workId: "work-1" })
      await vi.waitFor(() => expect(f.requestReceipts).toHaveBeenCalledOnce())
      expect(f.queued()?.handoffRequestedAt).toBeInstanceOf(Date)
      loadSkills.mockResolvedValue({ localSkills: [], pluginSkills: [], disabledSkillIds: [] })
      invalidateSkillCatalog()
      f.requestReceipts.mockImplementation(async (_botId, checks) =>
        checks.map(({ requestId }) => ({ requestId, state: receipt })))

      await f.submit()

      expect(f.send).toHaveBeenCalledOnce()
      expect(f.requestReceipts).toHaveBeenCalledTimes(2)
      if (receipt === "accepted") {
        expect(f.queued()).toBeUndefined()
        expect(loadSkills).toHaveBeenCalledOnce()
      } else {
        expect(f.error()).toContain("原技能已不可用")
        expect(f.queued()).toMatchObject({ ...f.original, updated_at: expect.any(Date) })
        expect(loadSkills).toHaveBeenCalledTimes(2)
      }
    } finally { vi.unstubAllGlobals() }
  }
)

it.each([undefined, { settling: true, heldInputs: 1 }])(
  "keeps managed task drafts intact and refuses direct retry while control is %j", async userControl => {
    const f = fixture()
    const task = { ...f.work, userControl }
    const props = find<Parameters<typeof ChatContainer>[0]>(f.render(task), ChatContainer)!.props
    expect(props.managedTurn!.composerReadOnlyReason).toBeTruthy()
    expect(props.managedTurn!.userOwnsComposer).toBe(false)
    expect(props.managedTurn!.validateDraft!(f.original)).toBeTruthy()
    await expect(props.managedTurn!.submitDraft!(f.original)).rejects.toThrow()
    expect(f.queued()).toBe(f.original)
    expect(f.send).not.toHaveBeenCalled()
  }
)

it("restores task-local input on takeover and fences a stale sender after return", async () => {
  const f = fixture()
  const owned = { ...f.work, userControl: { settling: false, heldInputs: 0 } }
  const active = find<Parameters<typeof ChatContainer>[0]>(f.render(owned), ChatContainer)!.props.managedTurn!
  expect(active.composerReadOnlyReason).toBeUndefined()
  expect(active.userOwnsComposer).toBe(true)
  expect(active.ownerConversation).toBe(false)
  expect(active.validateDraft!(f.original)).toBeNull()
  f.render(f.work)
  await expect(active.submitDraft!(f.original)).rejects.toThrow("由 Bot 管理")
  expect(f.queued()).toBe(f.original)
  expect(f.send).not.toHaveBeenCalled()
  const restored = find<Parameters<typeof ChatContainer>[0]>(f.render(owned), ChatContainer)!.props.managedTurn!
  await restored.submitDraft!(f.original)
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: f.original.id, explicitSkill }))
  expect(f.send.mock.calls[0][0]).not.toHaveProperty("skillDraftFromMain")
  expect(f.send.mock.calls[0][0]).not.toHaveProperty("skillDraftSourceThreadId")
  expect(f.queued()).toBeUndefined()
})

it("exposes the same thread after takeover and retries settings without losing the draft", async () => {
  const f = fixture()
  const owned = { ...f.work, userControl: { settling: false, heldInputs: 0 } }
  const bound: BotWorkItem = { ...owned, conversation: {
    state: "bound", origin: "created", ref: {
      kind: "local_thread", threadId: owned.threadId, incarnation: { token: "same-thread", legacyCreatedAt: 1 }
    }
  } }
  const unboundSummary: Thread = {
    thread_id: owned.threadId, created_at: new Date(1), updated_at: new Date(1), status: "idle",
    metadata: { botId: owned.botId, botHostId: "local", botWorkId: owned.id, botAudienceKey: "desktop" },
    thread_values: {}
  }
  const boundSummary = { ...unboundSummary, metadata: { ...unboundSummary.metadata,
    botLocalConversation: true, botWorkOrigin: "created", botWorkModelRoutingMode: "pinned", model: "selected" } }
  const getThread = vi.fn(async () => boundSummary)
  hooks.threads = [unboundSummary]
  f.expose.mockRejectedValueOnce(new Error("原工作目录暂不可用")).mockResolvedValueOnce(bound)
  vi.stubGlobal("window", { api: { threads: { get: getThread } } })
  try {
    f.render({ ...owned, userControl: { ...owned.userControl, settling: true } })
    hooks.effects.at(-1)!()
    expect(f.expose).not.toHaveBeenCalled()

    const initial = find<Parameters<typeof ChatContainer>[0]>(f.render(owned), ChatContainer)!.props.managedTurn!
    expect(initial.ownerConversation).toBe(false)
    expect(initial.userOwnsComposer).toBe(true)
    const finishFailedAttempt = hooks.effects.at(-1)!()
    await vi.waitFor(() => {
      const retry = find<{ children: string }>(f.render(owned), "button")
      expect(retry?.props.children).toBe("重试任务设置")
    })
    expect(getThread).not.toHaveBeenCalled()
    expect(f.queued()).toBe(f.original)
    finishFailedAttempt?.()
    find<{ onClick(): void }>(f.render(owned), "button")!.props.onClick()
    f.render(owned)
    const finishRetry = hooks.effects.at(-1)!()
    await vi.waitFor(() => expect(hooks.addThreadSummary).toHaveBeenCalledOnce())
    expect(f.expose.mock.calls).toEqual([[owned.botId, owned.id], [owned.botId, owned.id]])
    expect(getThread).toHaveBeenCalledExactlyOnceWith(owned.threadId)
    const ready = find<Parameters<typeof ChatContainer>[0]>(f.render(bound), ChatContainer)!.props.managedTurn!
    expect(ready.ownerConversation).toBe(true)
    expect(ready.userOwnsComposer).toBe(true)
    expect(ready.composerReadOnlyReason).toBeUndefined()
    expect(f.queued()).toBe(f.original)
    finishRetry?.()
    hooks.effects.at(-1)!()

    f.render({ ...bound, conversation: { ...bound.conversation!, state: "detached" } })
    hooks.effects.at(-1)!()
    expect(f.expose).toHaveBeenCalledTimes(2)
  } finally { vi.unstubAllGlobals() }
})

it("reconciles an already accepted task draft while managed without sending it again", async () => {
  vi.stubGlobal("crypto", webcrypto)
  try {
    const f = fixture()
    hooks.queue.updateQueuedMessage(f.original.id, { handoffRequestedAt: new Date() })
    f.requestReceipts.mockImplementation(async (_botId, checks) =>
      checks.map(({ requestId }) => ({ requestId, state: "accepted" })))
    const managed = find<Parameters<typeof ChatContainer>[0]>(f.render(f.work), ChatContainer)!.props.managedTurn!
    await managed.submitDraft!(f.queued()!)
    expect(f.queued()).toBeUndefined()
    expect(f.requestReceipts).toHaveBeenCalledOnce()
    expect(f.send).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

it("restores a parked workbench slash selection and submits the same attachment IDs without asking again", async () => {
  const f = fixture()
  const block = formatSkillUseBlock(explicitSkill)
  hooks.queue.updateQueuedMessage(f.original.id, { botExplicitSkill: undefined, skillBlock: block })
  await f.sendDefault()
  expect(f.dialog()).toBeUndefined()
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ requestId: f.original.id, explicitSkill, inputFileIds }))
})

it("creates skill work from an @file resolved through the main-process retained-input capability", async () => {
  const readWorkspaceFile = vi.fn()
  const readWorkspaceAttachment = vi.fn(async () => pickerAttachment)
  const resolved = await resolveAtFileAttachments({
    rawMessage: "Check @sample.csv", attachments: [], mentionedFiles: [], workspacePath: "/workspace",
    workspaceFiles: [{ path: "sample.csv", is_dir: false }],
    maxAttachments: 3, maxTotalChars: 24000, readWorkspaceFile, readWorkspaceAttachment
  })
  expect(readWorkspaceAttachment).toHaveBeenCalledExactlyOnceWith("/sample.csv", 24000)
  expect(readWorkspaceFile).not.toHaveBeenCalled()
  const f = fixture(undefined, resolved.attachments)
  await f.submit()
  f.dialog()!.choose({ kind: "create", title: "Review file", path: "/selected" })
  await vi.waitFor(() => expect(f.onOpenWork).toHaveBeenCalledWith("work-1"))
  expect(f.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputFileIds, explicitSkill }))
})

it("reopens the real skill chooser after an invalid directory and sends the unchanged draft to a corrected target", async () => {
  const f = fixture()
  f.validateSkillWorkspace.mockRejectedValueOnce(new Error("工作区不存在"))
  await f.submit()
  f.dialog()!.choose(invalidDirectory)
  await vi.waitFor(() => expect(f.dialog()?.error).toBe("工作区不存在"))
  const dialog = f.dialog()!
  expect(dialog.retry).toEqual(invalidDirectory)
  const conversationState = hooks.slots
  hooks.slots = []
  hooks.cursor = 0
  const form = BotSkillTargetDialog(dialog)
  hooks.slots = conversationState
  expect(find<{ value: string }>(form, "input")?.props.value).toBe(invalidDirectory.title)
  expect(find<{ value: string }>(form, "select")?.props.value).toBe("directory")
  expect(f.queued()).toMatchObject({ ...f.original, updated_at: expect.any(Date) })
  expect(f.queued()?.botSkillTarget).toBeUndefined()
  expect(f.queued()?.handoffRequestedAt).toBeUndefined()
  expect(f.create).not.toHaveBeenCalled()

  f.dialog()!.choose({ ...invalidDirectory, path: "/corrected" })
  await vi.waitFor(() => expect(f.onOpenWork).toHaveBeenCalledWith("work-1"))
  expect(f.create).toHaveBeenCalledExactlyOnceWith({
    botId: "bot", operationId: f.original.id, title: invalidDirectory.title, goal: f.original.text,
    inputFileIds, explicitSkill, workspace: { kind: "directory", path: "/corrected" }
  })
  expect(f.queued()).toBeUndefined()
})

it.each([false, true])("keeps an older attachment in the draft when new task creation cannot retain it (mixed=%s)", async mixed => {
  const legacyAttachment: FileAttachment = {
    filename: "old.txt", filePath: "shared/old.txt", mimeType: "text/plain", size: 80,
    content: `The file mentions <attachment filename="sample.csv" input_id="${inputFileIds[0]}" type="text/csv">`,
    truncated: false
  }
  const f = fixture(undefined, mixed ? [pickerAttachment, legacyAttachment] : [legacyAttachment])
  await f.submit()
  f.dialog()!.choose({ ...invalidDirectory, path: "/valid" })
  await vi.waitFor(() => expect(f.dialog()?.error).toContain("重新选择附件"))
  expect(f.queued()).toMatchObject({ ...f.original, updated_at: expect.any(Date) })
  expect(f.queued()?.botSkillTarget).toBeUndefined()
  expect(f.queued()?.handoffRequestedAt).toBeUndefined()
  expect(f.validateSkillWorkspace).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.onOpenWork).not.toHaveBeenCalled()

  f.dialog()!.choose({ kind: "work", workId: "work-1" })
  await vi.waitFor(() => expect(f.onOpenWork).toHaveBeenCalledWith("work-1"))
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    workId: "work-1", explicitSkill, message: expect.stringContaining(f.original.attachmentModelBlocks)
  }))
})

it("offers another target when the selected existing work is already unavailable", async () => {
  const f = fixture()
  f.get.mockRejectedValueOnce(new Error("工作不属于当前 Bot"))
  await f.submit()
  f.dialog()!.choose({ kind: "work", workId: "deleted" })
  await vi.waitFor(() => expect(f.dialog()?.error).toBe("工作不属于当前 Bot"))
  expect(f.queued()?.botSkillTarget).toBeUndefined()
  expect(f.queued()?.handoffRequestedAt).toBeUndefined()
  expect(f.send).not.toHaveBeenCalled()

  f.dialog()!.choose({ kind: "work", workId: "work-1" })
  await vi.waitFor(() => expect(f.onOpenWork).toHaveBeenCalledWith("work-1"))
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    requestId: f.original.id, workId: "work-1", inputFileIds, explicitSkill,
    skillDraftFromMain: true, skillDraftSourceThreadId: "main"
  }))
  expect(f.queued()).toBeUndefined()
})

it("keeps the full skill draft and reopens the chooser when an existing work's fixed directory is unavailable", async () => {
  const f = fixture()
  f.validateSkillWorkspace.mockRejectedValueOnce(new Error("原工作区不存在"))
  await f.submit()
  const target = { kind: "work", workId: "work-1" } as const
  f.dialog()!.choose(target)
  await vi.waitFor(() => expect(f.dialog()?.error).toBe("原工作区不存在"))
  expect(f.dialog()?.retry).toEqual(target)
  expect(f.validateSkillWorkspace).toHaveBeenCalledExactlyOnceWith("bot", { ...target, threadId: "work-thread" })
  expect(f.queued()).toMatchObject({ ...f.original, updated_at: expect.any(Date) })
  expect(f.queued()?.botSkillTarget).toBeUndefined()
  expect(f.queued()?.handoffRequestedAt).toBeUndefined()
  expect(f.queued()?.botHandoffTarget).toBeUndefined()
  expect(f.send).not.toHaveBeenCalled()

  f.dialog()!.choose(target)
  await vi.waitFor(() => expect(f.onOpenWork).toHaveBeenCalledWith("work-1"))
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    requestId: f.original.id, workId: "work-1", inputFileIds, explicitSkill,
    message: expect.stringContaining(f.original.attachmentModelBlocks)
  }))
})

it("reuses the exact create arguments after a lost response without reopening the chooser or revalidating the directory", async () => {
  const mentions = [{ botId: "selected-peer", start: 0, end: 5, label: "Peer" }]
  const quote = { id: "quoted", ordinal: 4, role: "user" as const, text: "Approved body" }
  const f = fixture(mentions, undefined, quote)
  f.create.mockRejectedValueOnce(new Error("回复未到达"))
  await f.submit()
  const originalTarget = { ...invalidDirectory, path: "/valid" }
  f.dialog()!.choose(originalTarget)
  await vi.waitFor(() => expect(f.queued()?.handoffRequestedAt).toBeInstanceOf(Date))
  expect(f.queued()?.botSkillTarget).toEqual(originalTarget)
  expect(f.dialog()).toBeUndefined()
  f.messageReply.mockRejectedValue(new Error("Source is no longer available"))
  await f.submit()
  expect(f.create).toHaveBeenCalledTimes(2)
  expect(f.create.mock.calls[0][0]).toMatchObject({ mentions: [expect.objectContaining({ botId: "selected-peer" })],
    inputFileIds, explicitSkill, goal: expect.stringContaining(f.original.text) })
  expect(f.create.mock.calls[1]).toEqual(f.create.mock.calls[0])
  expect(f.messageReply).toHaveBeenCalledExactlyOnceWith("bot", quote.id)
  expect(f.validateSkillWorkspace).toHaveBeenCalledTimes(1)
  expect(f.queued()).toBeUndefined()
})

it("keeps an uncertain existing-work send bound to its original target if that task is later unavailable", async () => {
  vi.stubGlobal("crypto", webcrypto)
  try {
    const f = fixture()
    f.send.mockRejectedValueOnce(new Error("回复未到达"))
    await f.submit()
    const target = { kind: "work", workId: "work-1" } as const
    f.dialog()!.choose(target)
    await vi.waitFor(() => expect(f.requestReceipts).toHaveBeenCalledOnce())
    const handoff = f.queued()!.handoffRequestedAt
    expect(handoff).toBeInstanceOf(Date)
    f.get.mockRejectedValueOnce(new Error("工作已不可用"))
    await f.submit()
    expect(f.dialog()).toBeUndefined()
    expect(f.queued()).toMatchObject({ id: f.original.id, botSkillTarget: target, handoffRequestedAt: handoff })
    expect(f.send).toHaveBeenCalledOnce()
    f.validateSkillWorkspace.mockRejectedValueOnce(new Error("原工作区不存在"))
    await f.submit()
    expect(f.validateSkillWorkspace).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]).toEqual(f.send.mock.calls[0])
    expect(f.queued()).toBeUndefined()
  } finally {
    vi.unstubAllGlobals()
  }
})

it.each(["trigger", "disabled-trigger", "departed-thread"])(
  "returns skill chooser focus only within its original conversation: %s", mode => {
    const composer = { focus: vi.fn() }
    const thread = { isConnected: mode !== "departed-thread", querySelector: vi.fn(() => composer) }
    class OriginalControl {
      isConnected = mode !== "departed-thread"
      focus = vi.fn()
      matches = () => mode === "disabled-trigger"
      closest = (selector: string) => selector === "[data-chat-thread-id]" ? thread : null
    }
    const trigger = new OriginalControl()
    vi.stubGlobal("HTMLElement", OriginalControl)
    vi.stubGlobal("document", { activeElement: trigger })
    try {
      hooks.cursor = 0
      hooks.slots = []
      const tree = BotSkillTargetDialog({ skill: "review", close: vi.fn(), choose: vi.fn(),
        directory: { items: [], priority: [], query: "", loading: false, selected: null, cursor: null,
          setQuery: vi.fn(), error: null, refresh: async () => {}, more: async () => {},
          current: { current: { botId: "bot", selectedId: null, audience: "desktop" } } } })
      const content = find<{ onCloseAutoFocus(event: { preventDefault(): void }): void }>(tree, DialogContent)!
      const preventDefault = vi.fn()
      content.props.onCloseAutoFocus({ preventDefault })
      expect(trigger.focus).toHaveBeenCalledTimes(mode === "trigger" ? 1 : 0)
      expect(composer.focus).toHaveBeenCalledTimes(mode === "disabled-trigger" ? 1 : 0)
      expect(preventDefault).toHaveBeenCalledTimes(mode === "departed-thread" ? 0 : 1)
      if (mode === "disabled-trigger") expect(thread.querySelector).toHaveBeenCalledWith(expect.stringContaining("[data-bot-composer]"))
    } finally {
      vi.unstubAllGlobals()
    }
  }
)
