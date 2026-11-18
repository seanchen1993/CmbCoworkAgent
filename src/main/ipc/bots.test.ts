import { beforeEach, describe, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMain } from "electron"
import { botContinuationMessageId } from "../bots/continuation"
import { parseGroup, parseSendBotMessage } from "../../shared/bots/validation"
import { formatBotMessageReply } from "../../shared/bots/message-reply"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "../bots/store"
import { LocalBotHost } from "../bots/host"
import { deleteBotThreadHistory, setBotHistoryInputSource } from "../bots/history-input-projection"
import { localBotWorkspaces } from "../bots/workspace"
import { BotMemoryService } from "../bots/memory"
import { BotImChannelService, type BotImGatewayClient } from "../services/im/bot-channel-service"
import {
  botImBrowserScope,
  assertBotImBinding,
  assertBotImEvent,
  type BotImBinding
} from "../../shared/bots/im-channel"
const fixture = vi.hoisted(() => ({
  getHost: vi.fn(),
  featureStore: { unfinished: () => [], followedProjects: () => [] },
  conversationLinks: { forBot: () => [], forThread: () => null },
  introduce: vi.fn(),
  getThread: vi.fn(),
  getThreadMessagesByIds: vi.fn(),
  removeBot: vi.fn(),
  removeGroup: vi.fn(),
  removeBrowserGroup: vi.fn(),
  getBot: vi.fn((id: string) => ({ id, archived: id === "archived" })),
  subscribe: vi.fn(),
  share: vi.fn(),
  remove: vi.fn(),
  write: vi.fn(),
  listMemory: vi.fn(),
  create: vi.fn(),
  preview: vi.fn(),
  hasOpenPages: vi.fn(),
  assertWorkNotDeleting: vi.fn(),
  takeOver: vi.fn(),
  navigate: vi.fn(),
  giveBack: vi.fn(),
  operateBrowser: vi.fn(),
  browserScope: vi.fn((id: string) => {
    if (id === "group-missing--a") throw new Error("群聊不存在")
    return id
  }),
  snapshot: vi.fn(() => ({ revision: 1 })),
  exchange: vi.fn(),
  exchangeHistory: vi.fn(),
  messageOrigins: vi.fn(),
  messageReply: vi.fn(),
  messageReactions: vi.fn(),
  setMessageReaction: vi.fn(),
  requestReceipts: vi.fn(),
  stopConversation: vi.fn(),
  stopWork: vi.fn(),
  stopGroup: vi.fn(),
  markUnread: vi.fn(),
  markRead: vi.fn(),
  groupMessages: vi.fn(),
  listWorks: vi.fn(),
  workSummaries: vi.fn(),
  pendingWorkQuestions: vi.fn(),
  answerWorkQuestion: vi.fn(),
  getWork: vi.fn(),
  workOwnerCandidates: vi.fn(() => []),
  resolveOrdinaryThreadSource: vi.fn(),
  createWork: vi.fn(),
  sendDesktopMessage: vi.fn(),
  changeWork: vi.fn(),
  changeWorkControl: vi.fn(),
  saveSchedule: vi.fn(),
  removeSchedule: vi.fn(),
  markWorksRead: vi.fn(),
  listenConversationTransitions: vi.fn(),
  finishConversationTransition: vi.fn(),
  windowFor: vi.fn(() => ({}))
}))
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: fixture.windowFor },
  powerMonitor: { on: vi.fn() }
}))
vi.mock("../bots/local-service", () => ({
  initializeBotNotificationDispatch: vi.fn(),
  refreshBotFeatureProjects: vi.fn(async () => {}),
  getLocalBotHost: fixture.getHost,
  getBotMemoryService: () => ({
    removeBot: fixture.removeBot,
    share: fixture.share,
    write: fixture.write,
    list: fixture.listMemory,
    remove: fixture.remove
  }),
  getBotBrowserService: () => ({
    giveBack: fixture.giveBack,
    operateAsHuman: fixture.operateBrowser,
    preview: fixture.preview,
    hasOpenPages: fixture.hasOpenPages,
    takeOver: fixture.takeOver,
    navigateAsHuman: fixture.navigate,
    removeBot: fixture.removeBot,
    removeGroup: fixture.removeBrowserGroup
  })
}))
vi.mock("../bots/conversation-link-service", () => ({
  resolveWorkConversation: vi.fn(),
  exposeWorkConversation: vi.fn(),
  linkExistingConversation: vi.fn(),
  unlinkWorkConversation: vi.fn(),
  unlinkDeletingWorkConversation: vi.fn()
}))
vi.mock("../bots/conversation-transition", () => ({
  listenBotConversationTransitions: fixture.listenConversationTransitions,
  finishBotConversationTransition: fixture.finishConversationTransition
}))
vi.mock("../services/im/withheld-text-notices", () => ({ conversationSwitchedToText: () => false }))
vi.mock("../db", () => ({
  getThreadCore: fixture.getThread,
  getThreadMessagesByIds: fixture.getThreadMessagesByIds,
  getDb: vi.fn(),
  saveToDisk: vi.fn(),
  flushStrict: vi.fn()
}))
vi.mock("../bots/runtime-adapter", () => ({ prepareBotThread: vi.fn() }))
vi.mock("./bot-files", () => ({ registerBotFileHandlers: vi.fn() }))
import { registerBotHandlers } from "./bots"

function register(
  deleteThread?: Parameters<typeof registerBotHandlers>[1],
  event: unknown = {},
  im?: Parameters<typeof registerBotHandlers>[2]
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerBotHandlers(
    {
      handle: (channel, listener) => handlers.set(channel, listener)
    } as unknown as IpcMain,
    deleteThread,
    im
  )
  return (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
}
beforeEach(() => {
  vi.clearAllMocks()
  fixture.getHost.mockImplementation(() => fixture)
})
it("keeps surviving historical card summaries when an unlinked work's native conversation is deleted", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Desk", instructions: "", color: "#abcdef", modelRef: null })
  const peer = store.create({ name: "Peer", instructions: "", color: "#123456", modelRef: null })
  const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
  fixture.getHost.mockReturnValue(host)
  const call = register(), channel = "bots:work:summaries"
  try {
    const conversation = { kind: "local_thread", threadId: "linked-thread",
      incarnation: { token: "original", legacyCreatedAt: 1 } } as const
    const prepared = store.conversations.prepare({ botId: bot.id, operationId: "link", title: "Original", goal: "Review", conversation })
    const linked = store.conversations.bound(bot.id, prepared.id, conversation)
    store.conversations.beginDetach(bot.id, linked.id, linked.version)
    store.conversations.detached(bot.id, linked.id)
    const create = (botId: string, title: string) => store.createWork({ botId, operationId: title, title, goal: "Review" }).work.id
    const surviving = create(bot.id, "Surviving"), unrelated = create(peer.id, "Unrelated")
    const selected = [linked.id, surviving]
    expect(call(channel, "local", bot.id, selected)).toHaveLength(2)
    expect(deleteBotThreadHistory(db, [conversation.threadId])).toBe(true)
    expect(() => call(channel, "local", bot.id, selected)).toThrow("工作摘要不属于当前 Bot")
    expect(call(channel, "local", bot.id, [...selected, unrelated], true))
      .toMatchObject([{ id: surviving, botId: bot.id, title: "Surviving" }])
    expect(call(channel, "local", bot.id, [unrelated], true)).toEqual([])
    expect(() => call(channel, "local", bot.id, [surviving], "true")).toThrow("工作摘要批次无效")
  } finally {
    await host.stop()
    db.close()
  }
})
it("validates a selected skill workspace without creating work, only from the desktop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-skill-workspace-"))
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Desk", instructions: "", color: "#abcdef", modelRef: null })
  const validateSkillSelection = vi.fn(async () => {})
  const host = new LocalBotHost(store, {
    acquire: () => null, onAvailable: () => () => {}, workspaces: localBotWorkspaces, validateSkillSelection
  })
  fixture.getHost.mockReturnValue(host)
  const frame = {}
  const event = { senderFrame: frame, sender: { mainFrame: frame } }
  const channel = "bots:work:validate-skill-workspace"
  const target = { kind: "directory", path: directory }
  try {
    const call = register(undefined, event)
    expect(() => register()(channel, "local", bot.id, target)).toThrow("仅支持本机桌面窗口")
    expect(() => call(channel, "local", bot.id, { ...target, unrelated: true })).toThrow("请选择目录")
    await expect(call(channel, "local", bot.id, { ...target, path: join(directory, "missing") }))
      .rejects.toThrow("不存在")
    await expect(call(channel, "local", bot.id, target)).resolves.toBeUndefined()
    expect(store.listWorks(bot.id).items).toEqual([])
    expect(store.recentTasks()).toEqual([])

    const input = { botId: bot.id, operationId: "original-skill-draft", title: "Original work",
      goal: "Check the sample", explicitSkill: { name: "review", path: "/skills/review/SKILL.md" },
      workspace: target }
    const original = await call("bots:work:create", "local", input) as Awaited<ReturnType<LocalBotHost["createWork"]>>
    expect(validateSkillSelection).toHaveBeenCalledExactlyOnceWith(input.explicitSkill)
    validateSkillSelection.mockRejectedValue(new Error("原技能已不可用"))
    await expect(call("bots:work:create", "local", input)).resolves.toEqual(original)
    expect(validateSkillSelection).toHaveBeenCalledTimes(1)
    await expect(call("bots:work:create", "local", { ...input, operationId: "unreceived-skill-draft" }))
      .rejects.toThrow("原技能已不可用")
    expect(validateSkillSelection).toHaveBeenCalledTimes(2)
    const existing = { kind: "work", workId: original.work.id, threadId: original.work.threadId }
    await expect(call(channel, "local", bot.id, existing)).resolves.toBeUndefined()
    expect(fixture.getThread).not.toHaveBeenCalled()
    await expect(call(channel, "local", bot.id, { ...existing, threadId: "other-thread" })).rejects.toThrow("所选任务")
    expect(() => call(channel, "local", bot.id, { ...existing, path: directory })).toThrow("技能任务目标无效")
    renameSync(directory, `${directory}-moved`)
    await expect(call(channel, "local", bot.id, existing)).rejects.toThrow("不存在")
    const { execution, ...persisted } = host.getWork(bot.id, original.work.id)
    expect(persisted).toEqual(original.work)
    expect(execution?.phase).toBeDefined()
    await expect(call("bots:work:create", "local", input)).resolves.toEqual(original)
    expect(store.listWorks(bot.id).items).toHaveLength(1)
    expect(store.recentTasks()).toHaveLength(1)
  } finally {
    await host.stop()
    db.close()
    rmSync(directory, { recursive: true, force: true })
    rmSync(`${directory}-moved`, { recursive: true, force: true })
  }
})
it("checks the original linked skill target's incarnation and actual directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-linked-skill-workspace-"))
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Desk", instructions: "", color: "#abcdef", modelRef: null })
  const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
  fixture.getHost.mockReturnValue(host)
  const frame = {}, call = register(undefined, { senderFrame: frame, sender: { mainFrame: frame } })
  const channel = "bots:work:validate-skill-workspace"
  try {
    const conversation = { kind: "local_thread", threadId: "linked-thread",
      incarnation: { token: "original", legacyCreatedAt: 1 } } as const
    const prepared = store.conversations.prepare({ botId: bot.id, operationId: "link", title: "Original", goal: "Review", conversation })
    const work = store.conversations.bound(bot.id, prepared.id, conversation)
    const target = { kind: "work", workId: work.id, threadId: work.threadId }
    const row = (token: string) => ({ created_at: 1, metadata: JSON.stringify({
      cmb_thread_incarnation: token, botHostId: "local", botId: bot.id, botWorkId: work.id,
      botLocalConversation: true, botAudienceKey: "desktop", botWorkOrigin: "existing", workspacePath: directory
    }) })
    fixture.getThread.mockReturnValueOnce(row("recreated"))
    await expect(call(channel, "local", bot.id, target)).rejects.toThrow("身份不一致")
    fixture.getThread.mockReturnValueOnce(row("original"))
    await expect(call(channel, "local", bot.id, target)).resolves.toBeUndefined()
    renameSync(directory, `${directory}-moved`)
    fixture.getThread.mockReturnValueOnce(row("original"))
    await expect(call(channel, "local", bot.id, target)).rejects.toThrow("不存在")
    expect(store.getWork(bot.id, work.id)).toEqual(work)
    expect(store.recentTasks()).toEqual([])
  } finally {
    await host.stop()
    db.close()
    rmSync(directory, { recursive: true, force: true })
    rmSync(`${directory}-moved`, { recursive: true, force: true })
  }
})
it("validates ordinary history citations at the desktop IPC boundary before resolving a target", async () => {
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame } }
  const call = register(undefined, event)
  const source = { conversation: { kind: "local_thread", threadId: "original",
    incarnation: { token: "identity", legacyCreatedAt: 1 } }, messageId: "message-1" }
  fixture.resolveOrdinaryThreadSource.mockResolvedValue({ threadId: "original", messageId: "message-1", ordinal: 2 })
  await expect(call("bots:conversation:resolve-history", "local", "bot", source)).resolves.toMatchObject({ threadId: "original" })
  expect(fixture.resolveOrdinaryThreadSource).toHaveBeenCalledWith("bot", source)
  fixture.resolveOrdinaryThreadSource.mockClear()
  for (const invalid of [null, { ...source, messageId: 1 }, { ...source, messageId: "x".repeat(513) },
    { ...source, conversation: { kind: "cloud_session" } },
    { ...source, conversation: { ...source.conversation, incarnation: null } }])
    expect(() => call("bots:conversation:resolve-history", "local", "bot", invalid)).toThrow()
  const foreignFrame = register(undefined, { senderFrame: {}, sender: { mainFrame: {} } })
  expect(() => foreignFrame("bots:conversation:resolve-history", "local", "bot", source)).toThrow()
  expect(fixture.resolveOrdinaryThreadSource).not.toHaveBeenCalled()
})
it("revalidates only the original detached native user quote against its Bot input decision", () => {
  const frame = {}, call = register(undefined, { senderFrame: frame, sender: { mainFrame: frame } })
  const channel = "bots:conversation:revalidate-draft-reply"
  const ref = { kind: "local_thread", threadId: "original",
    incarnation: { token: "identity", legacyCreatedAt: 1 } } as const
  const row = { thread_id: ref.threadId, created_at: 1, metadata: '{"cmb_thread_incarnation":"identity"}' }
  const saved = { id: "old-user-message", ordinal: 4, role: "user", text: "Not approved", preview: "Not approved" }
  const durable = { ...saved, content: saved.text }
  const inputs = vi.fn()
  setBotHistoryInputSource({
    works: () => [{ id: "detached-work", botId: "old-owner", threadId: ref.threadId, audienceKey: "desktop",
      conversation: { ref, origin: "existing", state: "detached" } }],
    inputs
  })
  try {
    fixture.getThread.mockReturnValueOnce(row)
    fixture.getThreadMessagesByIds.mockReturnValueOnce([durable])
    inputs.mockReturnValueOnce(new Map([[saved.id, "Approved summary"]]))
    const projected = call(channel, "local", ref, saved) as Parameters<typeof formatBotMessageReply>[1]
    expect(projected).toEqual({
      id: saved.id, ordinal: saved.ordinal, role: saved.role, text: "Approved summary"
    })
    expect(formatBotMessageReply("请继续任务", projected, "workbench")).not.toContain(saved.text)
    expect(formatBotMessageReply("我重新写了 Not approved", projected, "workbench"))
      .toMatch(/\n> Approved summary\n\n我重新写了 Not approved$/)
    expect(inputs).toHaveBeenCalledWith("old-owner", ref.threadId, [saved.id], ["detached-work"], "reply")
    expect(durable.content).toBe("Not approved")

    fixture.getThread.mockReturnValueOnce(row)
    fixture.getThreadMessagesByIds.mockReturnValueOnce([durable])
    inputs.mockReturnValueOnce(new Map([[saved.id, null]]))
    expect(() => call(channel, "local", ref, saved)).toThrow("取消回复")

    fixture.getThread.mockReturnValueOnce(row)
    fixture.getThreadMessagesByIds.mockReturnValueOnce([durable])
    inputs.mockReturnValueOnce(new Map([[saved.id, ""]]))
    expect(() => call(channel, "local", ref, saved)).toThrow("取消回复")

    fixture.getThread.mockReturnValueOnce(row)
    fixture.getThreadMessagesByIds.mockReturnValueOnce([durable])
    inputs.mockReturnValueOnce(new Map())
    expect(call(channel, "local", ref, saved)).toEqual(saved)

    inputs.mockClear()
    fixture.getThread.mockReturnValueOnce({ ...row, metadata: '{"cmb_thread_incarnation":"recreated"}' })
    expect(() => call(channel, "local", ref, saved)).toThrow("会话身份")
    fixture.getThread.mockReturnValueOnce(row)
    fixture.getThreadMessagesByIds.mockReturnValueOnce([{ ...durable, ordinal: 5 }])
    expect(() => call(channel, "local", ref, saved)).toThrow("取消回复")
    expect(() => call(channel, "local", ref, { ...saved, role: "assistant" })).toThrow("引用")
    expect(() => register()(channel, "local", ref, saved)).toThrow("本机桌面")
    expect(inputs).not.toHaveBeenCalled()
  } finally {
    setBotHistoryInputSource(undefined)
  }
})
describe("Bot IPC boundaries", () => {
  it("allows reading and answering an exact work question only from the desktop main frame", () => {
    const frame = {}
    const call = register(undefined, { senderFrame: frame, sender: { mainFrame: frame } })
    const foreign = register(undefined, { senderFrame: {}, sender: { mainFrame: frame } })
    const response = { requestId: "question", answers: {}, ignored: true }
    expect(() => foreign("bots:work:pending-questions", "local", "bot")).toThrow("本机桌面")
    expect(() => foreign("bots:work:answer-question", "local", "bot", "task", response)).toThrow("本机桌面")
    expect(() => call("bots:work:answer-question", "local", "bot", "task", { ...response, answers: null })).toThrow("答复无效")
    expect(() => call("bots:work:answer-question", "local", "bot", "task", { ...response, requestId: "../other" })).toThrow("标识")
    expect(fixture.pendingWorkQuestions).not.toHaveBeenCalled()
    expect(fixture.answerWorkQuestion).not.toHaveBeenCalled()
    call("bots:work:pending-questions", "local", "bot")
    call("bots:work:answer-question", "local", "bot", "task", response)
    expect(fixture.pendingWorkQuestions).toHaveBeenCalledExactlyOnceWith("bot")
    expect(fixture.answerWorkQuestion).toHaveBeenCalledExactlyOnceWith("bot", "task", response)
  })
  it("accepts typed Bot skill selection only from the desktop frame", () => {
    const frame = {}
    const call = register(undefined, { senderFrame: frame, sender: { mainFrame: frame } })
    const foreign = register(undefined, { senderFrame: {}, sender: { mainFrame: frame } })
    const explicitSkill = { name: "review", path: "/registered/review/SKILL.md" }
    const input = { botId: "bot", requestId: "request", workId: "work", message: "Review", explicitSkill,
      skillDraftFromMain: true, skillDraftSourceThreadId: "bot-main" }
    const mentions = [{ botId: "peer", start: 0, end: 5, label: "Peer" }]
    const create = { botId: "bot", operationId: "request", title: "Review", goal: "@Peer Review", explicitSkill, mentions }
    expect(() => foreign("bots:send", "local", input)).toThrow("本机桌面")
    expect(() => foreign("bots:work:create", "local", create)).toThrow("本机桌面")
    expect(() => call("bots:send", "local", { ...input, explicitSkill: undefined })).toThrow("技能草稿")
    expect(() => call("bots:send", "local", { ...input, skillDraftSourceThreadId: undefined })).toThrow("技能草稿")
    expect(() => call("bots:send", "local", { ...input, skillDraftFromMain: undefined })).toThrow("技能草稿")
    expect(() => call("bots:send", "local", { ...input, explicitSkill: { ...explicitSkill, allowedTools: ["*"] } })).toThrow("技能选择")
    expect(() => call("bots:work:create", "local", { ...create, explicitSkill: undefined })).toThrow("桌面技能草稿")
    expect(() => call("bots:work:create", "local", { ...create, goal: "@Different Review" })).toThrow("提及与原消息")
    expect(fixture.sendDesktopMessage).not.toHaveBeenCalled()
    expect(fixture.createWork).not.toHaveBeenCalled()
    call("bots:send", "local", input)
    call("bots:work:create", "local", create)
    expect(fixture.sendDesktopMessage).toHaveBeenCalledExactlyOnceWith(input)
    expect(fixture.createWork).toHaveBeenCalledExactlyOnceWith(create)
  })
  it("requires completed takeover for direct desktop work sends, including skill and retry requests", async () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const store = new BotStore(db)
    const bot = store.create({ name: "Desk", instructions: "", color: "#abcdef", modelRef: null })
    const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
    fixture.getHost.mockReturnValue(host)
    const frame = {}
    const call = register(undefined, { senderFrame: frame, sender: { mainFrame: frame } })
    const foreign = register(undefined, { senderFrame: {}, sender: { mainFrame: frame } })
    try {
      const { work, task: start } = await host.createWork({ botId: bot.id, operationId: "create-work",
        title: "Review", goal: "Review the report" })
      const input = { botId: bot.id, workId: work.id, requestId: "manual-input", message: "Make a correction" }
      const skill = { ...input, requestId: "manual-skill", explicitSkill: { name: "review", path: "/registered/review/SKILL.md" } }
      const queued = () => store.recentTasks().map(task => task.id)
      expect(() => foreign("bots:send", "local", input)).toThrow("本机桌面")
      expect(() => call("bots:send", "local", input)).toThrow("先获取控制权")
      expect(() => call("bots:send", "local", skill)).toThrow("先获取控制权")
      expect(() => call("bots:send", "local", { ...skill, skillDraftFromMain: true })).toThrow("技能草稿")
      expect(() => call("bots:send", "local", { ...skill, skillDraftFromMain: true,
        skillDraftSourceThreadId: work.threadId })).toThrow("主对话来源或任务目标已变化")
      expect(queued()).toEqual([start.id])
      expect(call("bots:send", "local", { botId: bot.id, requestId: "main-user", message: "Continue the review" }))
        .toMatchObject({ botId: bot.id, threadId: bot.threadId })
      const mainSkill = { ...skill, requestId: "main-selected-skill", skillDraftFromMain: true,
        skillDraftSourceThreadId: bot.threadId }
      expect(await call("bots:send", "local", mainSkill))
        .toMatchObject({ workId: work.id, threadId: work.threadId, origin: { explicitSkill: skill.explicitSkill } })
      const workAttachment = host.retainInputFile(bot.id, {
        filename: "sample.txt", filePath: "/selected/sample.txt", content: "sample",
        mimeType: "text/plain", size: 6, truncated: false
      }, "/snapshots/.bot-deliveries/" + "a".repeat(64) + "/sample.txt", work.id)
      await expect(call("bots:send", "local", { ...mainSkill, requestId: "wrong-main-attachment",
        inputFileIds: [workAttachment.botInputId] })).rejects.toThrow("不属于此会话的本机输入")
      const selectedCreation = await call("bots:work:create", "local", { botId: bot.id, operationId: "main-skill-create",
        title: "New skill task", goal: "Review another report", explicitSkill: skill.explicitSkill })
      expect(selectedCreation).toMatchObject({ task: { origin: { kind: "user", explicitSkill: skill.explicitSkill } } })
      const taken = host.changeWorkControl({ botId: bot.id, workId: work.id, expectedVersion: host.getWork(bot.id, work.id).version,
        operationId: "take", action: "take" })
      expect(taken.userControl?.settling).toBe(false)
      const accepted = call("bots:send", "local", input)
      expect(accepted).toMatchObject({ workId: work.id, threadId: work.threadId })
      expect(call("bots:send", "local", input)).toEqual(accepted)
      expect(await call("bots:send", "local", skill)).toMatchObject({ workId: work.id, origin: { explicitSkill: skill.explicitSkill } })
      const held = host.workControlPending(bot.id, work.id)
      host.changeWorkControl({ botId: bot.id, workId: work.id, expectedVersion: held.version,
        operationId: "return", action: "return", confirmedTaskIds: held.items.map(item => item.taskId) })
      const beforeRetry = queued()
      expect(() => call("bots:send", "local", input)).toThrow("先获取控制权")
      expect(() => call("bots:send", "local", skill)).toThrow("先获取控制权")
      expect(queued()).toEqual(beforeRetry)
      expect(host.requestReceipts(bot.id, [{ requestId: input.requestId,
        messageHash: createHash("sha256").update(input.message).digest("hex") }], work.id))
        .toMatchObject([{ requestId: input.requestId, state: "accepted" }])
      expect(await call("bots:send", "local", mainSkill))
        .toMatchObject({ requestId: mainSkill.requestId, workId: work.id })
    } finally {
      await host.stop()
      db.close()
    }
  })
  it("requires the actual desktop frame for creating or managing a desktop-only routine", () => {
    const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame } }
    const call = register(undefined, event)
    const foreign = register(undefined, { senderFrame: {}, sender: { mainFrame: frame } })
    const input = { name: "Progress", message: "Report progress", enabled: true,
      frequency: "daily", runAtTime: "14:25" }
    const binding = { workId: "work", operationId: "save-once" }
    expect(() => foreign("bots:schedule:save", "local", "bot", input, undefined, binding)).toThrow("本机桌面")
    expect(fixture.saveSchedule).not.toHaveBeenCalled()
    call("bots:schedule:save", "local", "bot", input, undefined, binding)
    expect(fixture.saveSchedule).toHaveBeenCalledWith("bot", expect.objectContaining(input), undefined, undefined, binding)
    fixture.saveSchedule.mockClear()
    for (const protection of [
      { desktopWork: true, workId: "work" },
      { workMonitor: { workId: "work", mode: "new_result", generation: 1 } },
      { fixedReminder: { kind: "fixed_reminder" } }
    ]) {
      fixture.snapshot.mockImplementationOnce(() => ({ revision: 1, schedules: [{ id: "routine", ...protection }] }))
      expect(() => foreign("bots:schedule:save", "local", "bot", input, { id: "routine", version: 1 })).toThrow("本机桌面")
      fixture.snapshot.mockImplementationOnce(() => ({ revision: 1, schedules: [{ id: "routine", ...protection }] }))
      expect(() => foreign("bots:schedule:remove", "local", "routine", 1)).toThrow("本机桌面")
    }
    expect(fixture.saveSchedule).not.toHaveBeenCalled()
    expect(fixture.removeSchedule).not.toHaveBeenCalled()
    for (const invalid of [null, {}, { workId: "work" }, { ...binding, sourceTaskId: "forged" }])
      expect(() => call("bots:schedule:save", "local", "bot", input, undefined, invalid)).toThrow()
    expect(fixture.saveSchedule).not.toHaveBeenCalled()
    // Existing ordinary routine creation retains its original entry semantics.
    foreign("bots:schedule:save", "local", "bot", input)
    expect(fixture.saveSchedule).toHaveBeenCalledWith("bot", expect.objectContaining(input), undefined, undefined, undefined)
  })
  it("passes only the normalized desktop deadline or exact occurrence from a routine card", () => {
    const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame } }
    const call = register(undefined, event)
    const foreign = register(undefined, { senderFrame: {}, sender: { mainFrame: frame } })
    const input = { name: "Progress", message: "Report progress", enabled: false, frequency: "daily", runAtTime: "14:25" }
    const identity = { id: "routine", version: 2 }
    const expiry = { ...identity, expiresAt: "2099-11-01T09:30:00+08:00" }
    const withdraw = { ...identity, withdrawTaskId: "occurrence" }
    const save = (invoke: typeof call, edit: object) => invoke("bots:schedule:save", "local", "bot", input, edit)
    expect(() => save(foreign, expiry)).toThrow("本机桌面")
    expect(() => save(foreign, withdraw)).toThrow("本机桌面")
    expect(() => save(call, { ...expiry, ...withdraw })).toThrow("分别")
    expect(() => save(call, { ...expiry, expiresAt: "2099-11-01T09:30:00" })).toThrow("时区")
    expect(fixture.saveSchedule).not.toHaveBeenCalled()
    call("bots:schedule:save", "local", "bot", input, { ...expiry, pauseRequested: true, sourceTaskId: "spoof" })
    expect(fixture.saveSchedule).toHaveBeenLastCalledWith("bot", input,
      { ...identity, expiresAt: "2099-11-01T01:30:00.000Z" }, undefined, undefined)
    save(call, withdraw)
    expect(fixture.saveSchedule).toHaveBeenLastCalledWith("bot", input, withdraw, undefined, undefined)
    const monitor = { ...identity, workMonitor: { workId: "existing-work", mode: "new_result" } }
    expect(() => save(foreign, monitor)).toThrow("本机桌面")
    expect(() => save(call, { ...withdraw, ...monitor })).toThrow("分别")
    expect(() => save(call, { ...monitor, workMonitor: { ...monitor.workMonitor, sourceTaskId: "forged" } }))
      .toThrow("配置无效")
    save(call, monitor)
    expect(fixture.saveSchedule).toHaveBeenLastCalledWith("bot", input, monitor, undefined, undefined)
  })
  it("accepts transition acknowledgments only from the local desktop with a bounded result", () => {
    const frame = {}
    const sender = { id: 7, mainFrame: frame }
    const call = register(undefined, { senderFrame: frame, sender })
    call("bots:conversation:listen", "local", true)
    expect(fixture.listenConversationTransitions).toHaveBeenCalledExactlyOnceWith(sender, true)
    call("bots:conversation:finish-transition", "local", "request-1", "x".repeat(1000))
    expect(fixture.finishConversationTransition).toHaveBeenCalledExactlyOnceWith(
      7, "request-1", "x".repeat(1000), { senderFrame: frame, sender }
    )

    fixture.listenConversationTransitions.mockClear()
    fixture.finishConversationTransition.mockClear()
    expect(() => call("bots:conversation:listen", "local", "true")).toThrow()
    expect(() => call("bots:conversation:listen", "foreign", true)).toThrow()
    for (const invalid of [{ threadId: "target", action: "link" }, null, "x".repeat(1001)]) {
      expect(() => call("bots:conversation:finish-transition", "local", "request-1", invalid)).toThrow()
    }
    expect(() => call("bots:conversation:finish-transition", "local", "../request")).toThrow()
    const foreignFrame = register(undefined, { senderFrame: {}, sender })
    expect(() => foreignFrame("bots:conversation:listen", "local", true)).toThrow()
    expect(() => foreignFrame("bots:conversation:finish-transition", "local", "request-1")).toThrow()
    expect(fixture.listenConversationTransitions).not.toHaveBeenCalled()
    expect(fixture.finishConversationTransition).not.toHaveBeenCalled()
  })

  it("accepts task control only from the local desktop with a versioned narrow request", () => {
    const frame = {}, call = register(undefined, { senderFrame: frame, sender: { mainFrame: frame } })
    const input = { botId: "a", workId: "work", expectedVersion: 1, operationId: "take", action: "take" }
    call("bots:work:control", "local", input)
    expect(fixture.changeWorkControl).toHaveBeenCalledExactlyOnceWith(input)
    call("bots:work:control", "local", { ...input, action: "stop_and_take" })
    expect(fixture.changeWorkControl).toHaveBeenLastCalledWith({ ...input, action: "stop_and_take" })
    const returning = { ...input, action: "return", confirmedTaskIds: ["pending-task"] }
    call("bots:work:control", "local", returning)
    expect(fixture.changeWorkControl).toHaveBeenLastCalledWith(returning)
    fixture.changeWorkControl.mockClear()
    for (const invalid of [null, { ...input, expectedVersion: 0 }, { ...input, action: "run" },
      { ...input, workId: "../work" }, { ...input, operationId: "x".repeat(129) },
      { ...input, sourceTaskId: "pretend-user" }, { ...input, heldTaskIds: [] },
      { ...input, confirmedTaskIds: [] }, { ...returning, confirmedTaskIds: ["../foreign"] },
      { ...returning, confirmedTaskIds: ["duplicate", "duplicate"] },
      { ...returning, confirmedTaskIds: Array.from({ length: 501 }, (_, i) => `task-${i}`) }])
      expect(() => call("bots:work:control", "local", invalid)).toThrow()
    expect(() => call("bots:work:control", "remote", input)).toThrow()
    expect(() => register()("bots:work:control", "local", input)).toThrow("本机桌面")
    expect(fixture.changeWorkControl).not.toHaveBeenCalled()
  })
  it("bounds sidebar ownership reads to validated desktop requests", () => {
    const frame = {}, call = register(undefined, { senderFrame: frame, sender: { mainFrame: frame } })
    expect(call("bots:conversation:owners", "local", ["thread-one"])).toEqual([])
    expect(fixture.workOwnerCandidates).toHaveBeenCalledWith(["thread-one"])
    fixture.workOwnerCandidates.mockClear()
    for (const input of [null, ["same", "same"], [""], [123], Array.from({ length: 65 }, (_, i) => `thread-${i}`)])
      expect(() => call("bots:conversation:owners", "local", input)).toThrow()
    expect(() => register()("bots:conversation:owners", "local", ["thread-one"])).toThrow("本机桌面")
    expect(fixture.workOwnerCandidates).not.toHaveBeenCalled()
  })
  it.each(["deleted", "left"])("keeps retained group memories manageable after the group is %s", async (action) => {
    const root = mkdtempSync(join(tmpdir(), "cmb-memory-management-"))
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const host = new LocalBotHost(new BotStore(db), { acquire: () => null, onAvailable: () => () => {} })
    const memory = new BotMemoryService(root)
    const profile = { name: "Owner", instructions: "", color: "#123456", modelRef: null }
    const bot = host.create(profile), other = host.create({ ...profile, name: "Other" })
    const group = host.saveGroup({ name: "Old group", memberIds: [bot.id, other.id] })
    const current = host.saveGroup({ name: "Current group", memberIds: [bot.id, other.id] })
    fixture.getHost.mockReturnValue(host)
    fixture.getThread.mockReturnValue(undefined)
    fixture.listMemory.mockImplementation(memory.list.bind(memory))
    fixture.write.mockImplementation(memory.write.bind(memory))
    fixture.remove.mockImplementation(memory.remove.bind(memory))
    const call = register(async () => {})
    try {
      for (let i = 0; i < 200; i++) call("bots:memory:write", "local", bot.id, {
        name: `Retained ${i}`, content: `Fact ${i}`, scope: { kind: "group", groupId: group.id }
      })
      if (action === "deleted") await call("bots:group:remove", "local", group.id, group.version)
      else call("bots:group:save", "local", { name: group.name, memberIds: [other.id] }, {
        id: group.id, version: group.version
      })
      expect(() => call("bots:memory:list", "local", bot.id, group.id)).toThrow()
      expect(call("bots:memory:list", "local", bot.id, current.id)).toEqual([])
      expect(memory.forPrompt(bot.id)).toEqual([])
      expect(memory.forPrompt(bot.id, { groupId: current.id })).toEqual([])
      expect(() => memory.write(bot.id, { name: "New", content: "New" })).toThrow("上限")
      const retained = call("bots:memory:list", "local", bot.id) as ReturnType<BotMemoryService["list"]>
      expect(retained).toHaveLength(200)
      expect(call("bots:memory:list", "local", other.id)).toEqual([])
      const entry = retained[0]
      const updated = call("bots:memory:write", "local", bot.id, {
        id: entry.id, expectedVersion: entry.version, name: entry.name, content: "Updated"
      }) as ReturnType<BotMemoryService["write"]>
      expect(updated.scope).toEqual({ kind: "group", groupId: group.id })
      expect(memory.forPrompt(bot.id)).toEqual([])
      expect(() => call("bots:memory:write", "local", bot.id, {
        name: "Invalid", content: "Invalid", scope: { kind: "group", groupId: group.id }
      })).toThrow()
      expect(() => call("bots:memory:remove", "local", bot.id, entry.id, entry.version)).toThrow("更新")
      call("bots:memory:remove", "local", bot.id, updated.id, updated.version)
      call("bots:memory:write", "local", bot.id, { name: "New private", content: "Allowed" })
      expect(memory.forPrompt(bot.id).map((item) => item.name)).toEqual(["New private"])
      expect(memory.list(bot.id)).toHaveLength(200)
    } finally {
      fixture.listMemory.mockReset(); fixture.write.mockReset(); fixture.remove.mockReset()
      await host.stop(); await memory.close(); db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  it.each(["binding:synthetic", "b".repeat(128)])(
    "manages a wire-valid opaque binding %s through the actual IM service",
    async (bindingId) => {
      const db = new NativeSqliteAdapter(new DatabaseSync(":memory:")),
        store = new BotStore(db),
        host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} }),
        bot = store.create({ name: "IM", instructions: "", color: "#123456", modelRef: null }),
        other = store.create({ name: "Other", instructions: "", color: "#123456", modelRef: null })
      let binding: BotImBinding = {
        id: bindingId,
        botId: bot.id,
        kind: "group",
        label: "Synthetic",
        version: 1,
        state: "active",
        conversationKey: "conversation:synthetic",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90000).toISOString()
      }
      const client = {
        getStatus: () => ({ principalId: "owner" }) as ReturnType<BotImGatewayClient["getStatus"]>,
        supportsBotChannel: () => true,
        botBindingCommand: vi.fn<BotImGatewayClient["botBindingCommand"]>(async (command) => {
          if (command.action === "list") return { items: [binding], before: null }
          if (command.action !== "revoke") throw new Error("unexpected command")
          expect(command.bindingId).toBe(bindingId)
          binding = { ...binding, state: "revoked", version: command.expectedVersion + 1 }
          return binding
        }),
        sendAcknowledgement: vi.fn<BotImGatewayClient["sendAcknowledgement"]>(async () => {}),
        acquireBotPermit: vi.fn<BotImGatewayClient["acquireBotPermit"]>(async () => ({
          status: "granted",
          leaseId: "lease",
          expiresAt: new Date(Date.now() + 90000).toISOString()
        })),
        renewBotPermit: vi.fn<BotImGatewayClient["renewBotPermit"]>(),
        submitReply: vi.fn<BotImGatewayClient["submitReply"]>()
      } satisfies BotImGatewayClient
      const service = new BotImChannelService(client, "realm", () => host),
        manager = {
          setBotHostResolver: vi.fn(),
          botChannelStatus: () => ({ connected: true, available: true }),
          requireBotChannel: () => service
        },
        frame = {},
        event = { senderFrame: frame, sender: { mainFrame: frame } }
      fixture.getHost.mockReturnValue(host)
      try {
        assertBotImBinding(binding)
        const call = register(undefined, event, manager)
        expect(await call("bots:im:list", "local", bot.id)).toMatchObject({ items: [binding] })
        const input = {
          route: {
            bindingId,
            botId: bot.id,
            kind: binding.kind,
            label: binding.label,
            version: binding.version,
            senderId: "employee:42"
          },
          event: {
            schemaVersion: 1 as const,
            eventId: "event",
            platformMessageId: "message",
            principalId: "owner",
            conversationKey: binding.conversationKey!,
            conversationSeq: 1,
            message: { type: "text" as const, text: "Synthetic pending message" },
            occurredAt: new Date().toISOString(),
            lease: { id: "lease", expiresAt: new Date(Date.now() + 90000).toISOString() }
          }
        }
        assertBotImEvent(input)
        await service.receive(input)
        expect(call("bots:im:history", "local", bot.id, bindingId)).toMatchObject({
          items: [expect.objectContaining({ kind: "user", text: input.event.message.text })]
        })
        expect(() => call("bots:im:history", "local", other.id, bindingId)).toThrow("不属于")
        const localId = host.snapshot().imConversations![0].id
        call("bots:memory:list", "local", bot.id, localId)
        expect(fixture.listMemory).toHaveBeenLastCalledWith(bot.id, { groupId: localId })
        call("bots:memory:list", "local", bot.id)
        expect(fixture.listMemory).toHaveBeenLastCalledWith(bot.id, undefined)
        expect(() => call("bots:memory:list", "local", other.id, localId)).toThrow("不属于")
        expect(() =>
          call("bots:memory:write", "local", other.id, {
            name: "Fact",
            content: "No",
            scope: { kind: "group", groupId: localId }
          })
        ).toThrow("不属于")
        call("bots:memory:write", "local", bot.id, {
          name: "Fact",
          content: "Yes",
          scope: { kind: "group", groupId: localId }
        })
        expect(fixture.write).toHaveBeenLastCalledWith(bot.id, {
          name: "Fact",
          content: "Yes",
          scope: { kind: "group", groupId: localId }
        })
        expect(call("bots:im:conversation-history", "local", bot.id, localId)).toMatchObject({
          items: [expect.objectContaining({ text: input.event.message.text })]
        })
        expect(call("bots:im:conversation-works", "local", bot.id, localId)).toMatchObject({
          items: []
        })
        expect(() => call("bots:im:conversation-history", "local", other.id, localId)).toThrow(
          "不存在"
        )
        expect(() => call("bots:im:conversation-works", "remote", bot.id, localId)).toThrow("本机")
        expect(() => call("bots:im:conversation-stop", "remote", bot.id, localId)).toThrow("本机")
        expect(() => call("bots:im:conversation-stop", "local", other.id, localId)).toThrow(
          "不存在"
        )
        expect(() => call("bots:im:conversation-stop", "local", bot.id, "../invalid")).toThrow(
          "标识"
        )
        expect(() =>
          register(undefined, { ...event, senderFrame: {} }, manager)(
            "bots:im:conversation-stop",
            "local",
            bot.id,
            localId
          )
        ).toThrow("桌面")
        expect(() => call("bots:im:conversation-history", "local", bot.id, localId, "bad")).toThrow(
          "游标"
        )
        expect(() =>
          register(undefined, { ...event, senderFrame: {} }, manager)(
            "bots:im:conversation-history",
            "local",
            bot.id,
            localId
          )
        ).toThrow("桌面")
        expect(() => call("bots:im:history", "remote", bot.id, bindingId)).toThrow("本机")
        expect(() => call("bots:im:history", "local", "bot:invalid", bindingId)).toThrow("标识")
        expect(() => call("bots:im:create", "local", bot.id, "group", "operation:invalid")).toThrow(
          "标识"
        )
        for (const replace of [
          null,
          {},
          [],
          { botId: bot.id, bindingId, version: 0 },
          { botId: bot.id, bindingId, version: 1, realm: "untrusted" }
        ]) {
          expect(() =>
            call("bots:im:create", "local", other.id, "group", "replace", replace)
          ).toThrow("换绑目标无效")
        }
        expect(() =>
          call("bots:im:create", "local", other.id, "group", "replace", {
            botId: bot.id,
            bindingId: "../invalid",
            version: 1
          })
        ).toThrow("标识")
        expect(() => call("bots:im:replacement-targets", "remote", "dm")).toThrow("本机")
        expect(() => call("bots:im:replacement-targets", "local", "invalid")).toThrow("受众")
        expect(() => call("bots:im:revoke", "local", bot.id, bindingId, 0)).toThrow("版本")
        expect(() => call("bots:im:history", "local", bot.id, bindingId, "x".repeat(1025))).toThrow(
          "游标"
        )
        expect(() =>
          register(undefined, { ...event, senderFrame: {} }, manager)(
            "bots:im:history",
            "local",
            bot.id,
            bindingId
          )
        ).toThrow("桌面")
        for (const invalid of [
          undefined,
          null,
          {},
          [],
          "",
          "../binding",
          "binding/path",
          "binding.id",
          "b".repeat(129),
          "binding\n"
        ]) {
          expect(() => call("bots:im:history", "local", bot.id, invalid)).toThrow("标识")
          expect(() => call("bots:im:revoke", "local", bot.id, invalid, 1)).toThrow("标识")
          expect(() => call("bots:im:remove", "local", bot.id, invalid)).toThrow("标识")
        }
        expect(client.botBindingCommand).toHaveBeenCalledTimes(1)
        expect(await call("bots:im:revoke", "local", bot.id, bindingId, 1)).toMatchObject({
          id: bindingId,
          version: 2,
          state: "revoked"
        })
        expect(store.recentTasks()).toEqual([expect.objectContaining({ state: "cancelled" })])
        expect(call("bots:im:history", "local", bot.id, bindingId)).toMatchObject({
          items: [expect.objectContaining({ kind: "user", state: "cancelled" })]
        })
        expect(() => call("bots:im:remove", "remote", bot.id, bindingId)).toThrow("本机")
        expect(() => call("bots:im:remove", "local", other.id, bindingId)).toThrow("不属于")
        call("bots:im:remove", "local", bot.id, bindingId)
        expect(call("bots:im:history", "local", bot.id, bindingId)).toMatchObject({
          items: [expect.objectContaining({ kind: "user", state: "cancelled" })]
        })
        service.disconnected()
        expect(call("bots:im:conversation-history", "local", bot.id, localId)).toMatchObject({
          items: [expect.objectContaining({ kind: "user", state: "cancelled" })]
        })
      } finally {
        service.stop()
        await host.stop()
        db.close()
      }
    }
  )

  it("renames only an authoritative existing empty group through validation, Host and Store", async () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const store = new BotStore(db)
    const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
    fixture.getHost.mockReturnValue(host)
    try {
      const call = register()
      const bot = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
      const active = call("bots:group:save", "local", {
        name: "Active",
        memberIds: [bot.id]
      }) as ReturnType<BotStore["saveGroup"]>
      const emptyInput = { name: "Empty", memberIds: [] }
      expect(() => parseGroup(emptyInput)).toThrow("1 至 8")
      expect(() => call("bots:group:save", "local", emptyInput)).toThrow("1 至 8")
      expect(() => store.saveGroup(emptyInput)).toThrow("1 至 8")
      expect(() =>
        call(
          "bots:group:save",
          "local",
          { ...emptyInput, allowEmptyMembers: true },
          { ...active, allowEmptyMembers: true }
        )
      ).toThrow("1 至 8")
      expect(store.getGroup(active.id)).toEqual(active)

      const renamed = call(
        "bots:group:save",
        "local",
        { ...active, name: "Normal rename" },
        active
      ) as typeof active
      expect(renamed).toMatchObject({
        name: "Normal rename",
        memberIds: [bot.id],
        version: active.version + 1
      })
      store.beginDeletion(bot.id, bot.version)
      store.finishDeletion(bot.id)
      const empty = store.getGroup(active.id)
      expect(empty.memberIds).toEqual([])
      const revision = store.revision()
      for (const input of [
        { ...emptyInput, memberIds: "not-an-array" },
        { ...emptyInput, memberIds: ["../invalid"] },
        { ...emptyInput, memberIds: ["same", "same"] },
        { ...emptyInput, memberIds: Array.from({ length: 9 }, (_, i) => `bot-${i}`) }
      ])
        expect(() => call("bots:group:save", "local", input, empty)).toThrow()
      expect(() =>
        call("bots:group:save", "local", emptyInput, { id: empty.id, version: 0 })
      ).toThrow("版本")
      expect(() => call("bots:group:save", "local", emptyInput, renamed)).toThrow("刷新")
      expect(() =>
        call("bots:group:save", "local", emptyInput, { id: "missing", version: 1 })
      ).toThrow("不存在")
      expect(() => call("bots:group:save", "remote", emptyInput, empty)).toThrow("本机")
      expect(store.revision()).toBe(revision)
      expect(store.getGroup(empty.id)).toEqual(empty)

      const saved = call(
        "bots:group:save",
        "local",
        { name: "Retained history", memberIds: [] },
        empty
      ) as typeof empty
      expect(saved).toMatchObject({
        id: empty.id,
        name: "Retained history",
        memberIds: [],
        version: empty.version + 1
      })
      const peer = store.create({ name: "B", instructions: "", color: "#123456", modelRef: null })
      expect(() =>
        call("bots:group:save", "local", { ...saved, memberIds: ["missing-bot"] }, saved)
      ).toThrow("不存在")
      const joined = call(
        "bots:group:save",
        "local",
        { ...saved, memberIds: [peer.id] },
        saved
      ) as typeof saved
      expect(joined.memberIds).toEqual([peer.id])
      expect(() => call("bots:group:save", "local", emptyInput, joined)).toThrow("1 至 8")
      store.beginDeletion(peer.id, peer.version)
      store.finishDeletion(peer.id)
      const emptyAgain = store.getGroup(saved.id)
      store.beginGroupDeletion(emptyAgain.id, emptyAgain.version)
      expect(() => call("bots:group:save", "local", emptyInput, emptyAgain)).toThrow("删除")
    } finally {
      await host.stop()
      db.close()
    }
  })

  it("validates scoped reaction identity, full catalog emoji and explicit idempotent state", () => {
    const call = register(),
      target = { kind: "bot", botId: "a", workId: "work-a" }
    call("bots:message-reactions", "local", target, ["native:assistant.1"])
    expect(fixture.messageReactions).toHaveBeenCalledWith(target, ["native:assistant.1"])
    call("bots:set-message-reaction", "local", target, "native:assistant.1", "❤", false)
    expect(fixture.setMessageReaction).toHaveBeenCalledWith(
      target,
      "native:assistant.1",
      "❤️",
      false
    )
    fixture.setMessageReaction.mockClear()
    for (const [scope, id, emoji, present] of [
      [{ ...target, groupId: "group" }, "m", "👍", true],
      [{ kind: "group", groupId: "g", threadId: "other" }, "m", "👍", true],
      [target, "trim ", "👍", true],
      [target, "m", "👍👍", true],
      [target, "m", "👍", "false"]
    ])
      expect(() => call("bots:set-message-reaction", "local", scope, id, emoji, present)).toThrow()
    expect(() => call("bots:message-reactions", "local", target, Array(101).fill("m"))).toThrow()
    expect(() => call("bots:set-message-reaction", "remote", target, "m", "👍", true)).toThrow(
      "本机"
    )
    expect(fixture.setMessageReaction).not.toHaveBeenCalled()
  })
  it("keeps IM access in the top-level local desktop window", () => {
    const frame = {},
      event = { senderFrame: frame, sender: { mainFrame: frame } }
    const call = register(undefined, event)
    expect(call("bots:im:status", "local")).toEqual({ connected: false, available: false })
    expect(() =>
      register(undefined, { ...event, senderFrame: {} })("bots:im:status", "local")
    ).toThrow("桌面")
    fixture.windowFor.mockReturnValueOnce(null as any)
    expect(() => call("bots:im:status", "local")).toThrow("桌面")
    expect(() => call("bots:im:status", "remote")).toThrow("本机")
    expect(() => call("bots:im:conversation-history", "local", "a", "b", "x".repeat(1025))).toThrow(
      "游标"
    )
  })
  it("accepts only bounded local work controls and never renderer authority or conversation paths", () => {
    const call = register(),
      input = { botId: "a", operationId: "create", title: "Draft", goal: "Prepare" }
    for (const invalid of [
      { ...input, threadId: "owner" },
      { ...input, sourceTaskId: "task" },
      { ...input, audienceKey: "desktop" },
      { ...input, imConversationId: "../group" },
      { ...input, desktopWorkId: "forged" },
      { ...input, workspacePath: "/private" },
      { ...input, contextMessageIds: ["m", "m"] },
      { ...input, contextMessageIds: Array.from({ length: 13 }, (_, i) => `m${i}`) }
    ])
      expect(() => call("bots:work:create", "local", invalid)).toThrow()
    expect(() => call("bots:work:create", "remote", input)).toThrow()
    expect(() => call("bots:work:create", "local", { ...input, imConversationId: "group" })).toThrow("桌面")
    expect(fixture.createWork).not.toHaveBeenCalled()
    call("bots:work:create", "local", input)
    expect(fixture.createWork).toHaveBeenCalledWith(input)
    const frame = {}
    const desktop = register(undefined, { senderFrame: frame, sender: { mainFrame: frame } })
    desktop("bots:work:create", "local", { ...input, imConversationId: "group" })
    expect(fixture.createWork).toHaveBeenCalledWith({ ...input, imConversationId: "group" })
    for (const ids of ["work", Array(41).fill("w"), ["w", "w"], ["../w"]])
      expect(() => call("bots:work:summaries", "local", "a", ids)).toThrow()
    expect(() => call("bots:work:get", "local", "a", "../w")).toThrow()
    expect(() => call("bots:work:mark-all-read", "local", "a", 0)).toThrow()
    const lifecycle = {
      botId: "a",
      workId: "w",
      expectedVersion: 1,
      operationId: "done",
      action: "complete"
    }
    expect(() => call("bots:work:lifecycle", "local", { ...lifecycle, actor: "owner" })).toThrow()
    expect(() => call("bots:work:lifecycle", "local", { ...lifecycle, action: "replay" })).toThrow()
    call("bots:work:lifecycle", "local", lifecycle)
    expect(fixture.changeWork).toHaveBeenCalledWith("a", "w", 1, "done", "complete")
    call(
      "bots:request-receipts",
      "local",
      "a",
      [{ requestId: "r", messageHash: "a".repeat(64) }],
      "w"
    )
    expect(fixture.requestReceipts).toHaveBeenLastCalledWith("a", expect.any(Array), "w")
    expect(() => call("bots:stop-conversation", "local", "a", undefined, "../w")).toThrow()
    call("bots:stop-conversation", "local", "a", undefined, "w")
    expect(fixture.stopConversation).toHaveBeenLastCalledWith("a", undefined, "w")
    expect(fixture.stopWork).not.toHaveBeenCalled()
  })
  it("routes explicit work Stop only from a local desktop window to the exact work", () => {
    const frame = {}
    const call = register(undefined, { senderFrame: frame, sender: { mainFrame: frame } })
    expect(() => register()("bots:work:stop", "local", "a", "w")).toThrow("桌面")
    expect(() => call("bots:work:stop", "remote", "a", "w")).toThrow("本机")
    expect(() => call("bots:work:stop", "local", "../a", "w")).toThrow()
    expect(() => call("bots:work:stop", "local", "a", "../w")).toThrow()
    expect(fixture.stopWork).not.toHaveBeenCalled()
    call("bots:work:stop", "local", "a", "w")
    expect(fixture.stopWork).toHaveBeenCalledExactlyOnceWith("a", "w")
    expect(fixture.stopConversation).not.toHaveBeenCalled()
  })
  it("validates private quote host and both identities before domain access", () => {
    const call = register()
    expect(() => call("bots:message-reply", "remote", "bot", "message")).toThrow()
    expect(() => call("bots:message-reply", "local", "../bot", "message")).toThrow()
    for (const message of ["", " message", "message\n", "message\u0085", "m".repeat(1025), {}])
      expect(() => call("bots:message-reply", "local", "bot", message)).toThrow()
    expect(() => call("bots:message-reply", "local", "bot", "message", "../work")).toThrow()
    expect(fixture.messageReply).not.toHaveBeenCalled()
    call("bots:message-reply", "local", "bot", "message")
    expect(fixture.messageReply).toHaveBeenCalledWith("bot", "message", undefined)
    const providerId = "provider/response:segment::cmb-same-role-duplicate:assistant:2"
    call("bots:message-reply", "local", "bot", providerId, "work")
    expect(fixture.messageReply).toHaveBeenLastCalledWith("bot", providerId, "work")
  })

  it("validates exact same-group history targets and retains numeric backward cursors", () => {
    const call = register()
    for (const cursor of [
      0,
      -1,
      NaN,
      Infinity,
      "40",
      {},
      [],
      { targetMessageId: "../message" },
      { targetMessageId: "" },
      { targetMessageId: "message", before: 40 }
    ]) {
      expect(() => call("bots:group:messages", "local", "group", cursor)).toThrow()
    }
    expect(() =>
      call("bots:group:messages", "remote", "group", { targetMessageId: "message" })
    ).toThrow()
    expect(() => call("bots:group:messages", "local", "../group", 40)).toThrow()
    expect(fixture.groupMessages).not.toHaveBeenCalled()
    call("bots:group:messages", "local", "group", { targetMessageId: "message" })
    call("bots:group:messages", "local", "group", 40)
    call("bots:group:messages", "local", "group")
    expect(fixture.groupMessages.mock.calls).toEqual([
      ["group", { targetMessageId: "message" }],
      ["group", 40],
      ["group", undefined]
    ])
  })
  it("introduces only the validated local Bot when opening its conversation", () => {
    const call = register()
    expect(() => call("bots:open", "remote", "a")).toThrow()
    expect(() => call("bots:open", "local", "../a")).toThrow()
    expect(fixture.introduce).not.toHaveBeenCalled()
    call("bots:open", "local", "a")
    expect(fixture.introduce).toHaveBeenCalledExactlyOnceWith("a")
  })
  it("validates the host and private conversation identity before stopping work", () => {
    const call = register()
    expect(() => call("bots:stop-conversation", "remote", "a")).toThrow()
    expect(() => call("bots:stop-conversation", "local", "../a")).toThrow()
    expect(() => call("bots:stop-conversation", "local", "a", "../g")).toThrow()
    expect(fixture.stopConversation).not.toHaveBeenCalled()
    call("bots:stop-conversation", "local", "a")
    expect(fixture.stopConversation).toHaveBeenCalledExactlyOnceWith("a", undefined, undefined)
    call("bots:stop-conversation", "local", "a", "g")
    expect(fixture.stopConversation).toHaveBeenLastCalledWith("a", "g", undefined)
  })
  it("validates whole-group stop at the local Host boundary", () => {
    const call = register()
    expect(() => call("bots:stop-group", "remote", "g")).toThrow()
    expect(() => call("bots:stop-group", "local", "../g")).toThrow()
    expect(() => call("bots:stop-group", "local", undefined)).toThrow()
    expect(fixture.stopGroup).not.toHaveBeenCalled()
    call("bots:stop-group", "local", "g")
    expect(fixture.stopGroup).toHaveBeenCalledExactlyOnceWith("g")
  })
  it("validates bounded private receipt queries before accessing the Host", () => {
    const call = register()
    const valid = [{ requestId: "request-1", messageHash: "a".repeat(64) }]
    call("bots:request-receipts", "local", "bot-1", valid)
    expect(fixture.requestReceipts).toHaveBeenCalledWith("bot-1", valid, undefined)
    fixture.requestReceipts.mockClear()
    for (const checks of [
      null,
      {},
      [{ requestId: "../other", messageHash: "a".repeat(64) }],
      [{ requestId: "r", messageHash: "short" }],
      [...valid, ...valid],
      Array.from({ length: 33 }, (_, i) => ({ requestId: `r-${i}`, messageHash: "b".repeat(64) }))
    ])
      expect(() => call("bots:request-receipts", "local", "bot-1", checks)).toThrow()
    expect(() => call("bots:request-receipts", "remote", "bot-1", valid)).toThrow()
    expect(() => call("bots:request-receipts", "local", "../bot", valid)).toThrow()
    expect(fixture.requestReceipts).not.toHaveBeenCalled()
  })
  it("validates the observed browser control generation before handing it back", () => {
    const call = register()
    for (const generation of [-1, 1.5, Number.NaN, "1", null, Number.MAX_SAFE_INTEGER + 1])
      expect(() => call("bots:browser:give-back", "local", "a", generation)).toThrow("版本")
    expect(fixture.giveBack).not.toHaveBeenCalled()
    call("bots:browser:give-back", "local", "a", 3)
    expect(fixture.giveBack).toHaveBeenCalledWith("a", 3)
    fixture.giveBack.mockClear()
    for (const outcome of [null, true, "done", "dismissed", {}, []])
      expect(() => call("bots:browser:give-back", "local", "a", 3, outcome)).toThrow("方式")
    expect(fixture.giveBack).not.toHaveBeenCalled()
    expect(() => call("bots:browser:give-back", "local", "a", undefined, "skipped")).toThrow(
      "控制版本"
    )
    call("bots:browser:give-back", "local", "a", 3, "skipped")
    expect(fixture.giveBack).toHaveBeenCalledWith("a", 3, "skipped")
  })
  it("validates human browser operations and their exact scope, target and lease before forwarding", () => {
    const call = register()
    const reload = { action: "reload", pageId: "page-a" }
    for (const generation of [
      undefined,
      null,
      -1,
      1.5,
      NaN,
      Infinity,
      "3",
      Number.MAX_SAFE_INTEGER + 1
    ])
      expect(() => call("bots:browser:operate", "local", "a", reload, generation)).toThrow("版本")
    for (const input of [
      undefined,
      null,
      [],
      "reload",
      {},
      { action: "execute", pageId: "page-a" },
      { action: "reload" },
      { action: "reload", pageId: null },
      { action: "reload", pageId: "../../private" },
      { action: "new", pageId: "page-a" },
      { ...reload, url: "https://example.test" },
      { ...reload, generation: 3 },
      { ...reload, botId: "other" }
    ])
      expect(() => call("bots:browser:operate", "local", "a", input, 3)).toThrow()
    expect(() => call("bots:browser:operate", "remote", "a", reload, 3)).toThrow("本机")
    expect(() => call("bots:browser:operate", "local", "../a", reload, 3)).toThrow()
    expect(() => call("bots:browser:operate", "local", "group-missing--a", reload, 3)).toThrow(
      "不存在"
    )
    expect(fixture.operateBrowser).not.toHaveBeenCalled()
    for (const action of ["back", "forward", "reload", "close"])
      call("bots:browser:operate", "local", "group-g--a", { action, pageId: "page-a" }, 3)
    call("bots:browser:operate", "local", "a", { action: "new" }, 3)
    expect(fixture.operateBrowser.mock.calls).toEqual([
      ...["back", "forward", "reload", "close"].map((action) => [
        "group-g--a",
        { action, pageId: "page-a" },
        3
      ]),
      ["a", { action: "new" }, 3]
    ])
  })
  it("bounds and validates transcript origin lookups", () => {
    const call = register()
    for (const args of [
      ["remote", "a", ["m"]],
      ["local", "../a", ["m"]],
      ["local", "a", "m"],
      ["local", "a", Array(101).fill("m")],
      ["local", "a", ["../m"]],
      ["local", "a", ["m\u0000"]],
      ["local", "a", ["m".repeat(513)]],
      ["local", "a", ["m"], "../g"]
    ])
      expect(() => call("bots:message-origins", ...args)).toThrow()
    expect(fixture.messageOrigins).not.toHaveBeenCalled()
    call("bots:message-origins", "local", "a", ["m"], "g")
    expect(fixture.messageOrigins).toHaveBeenCalledWith("a", ["m"], "g", undefined)
    call("bots:message-origins", "local", "a", ["notification:t:command:c"])
    expect(fixture.messageOrigins).toHaveBeenLastCalledWith(
      "a",
      ["notification:t:command:c"],
      undefined,
      undefined
    )
  })
  it("reads internal continuation origins without letting user input impersonate their identity", () => {
    const call = register()
    const id = botContinuationMessageId("task", "checkpoint")
    call("bots:message-origins", "local", "a", [id])
    expect(fixture.messageOrigins).toHaveBeenCalledWith("a", [id], undefined, undefined)
    expect(() => parseSendBotMessage({ botId: "a", requestId: id, message: "Fake" })).toThrow(
      "标识"
    )
  })
  it("validates all collaboration history identities before reading the host", () => {
    const call = register()
    for (const args of [
      ["remote", "a", "task"],
      ["local", "../a", "task"],
      ["local", "a", "../task"],
      ["local", "a", "task", "../group"],
      ["local", "a", "task", undefined, "../work"],
      ["local", "a", "task", undefined, undefined, "../im"],
      ["local", "a", "task", undefined, undefined, {}]
    ])
      expect(() => call("bots:exchange", ...args)).toThrow()
    expect(fixture.exchange).not.toHaveBeenCalled()
    call("bots:exchange", "local", "a", "task", "group")
    expect(fixture.exchange).toHaveBeenCalledWith("a", "task", "group", undefined, undefined)
    call("bots:exchange", "local", "a", "task", undefined, undefined, "im-one")
    expect(fixture.exchange).toHaveBeenLastCalledWith("a", "task", undefined, undefined, "im-one")
    for (const args of [
      ["remote", "a", "task"],
      ["local", "../a", "task"],
      ["local", "a", "../task"],
      ["local", "a", "task", "../group"],
      ["local", "a", "task", undefined, "../cursor"],
      ["local", "a", "task", undefined, undefined, "../work"],
      ["local", "a", "task", undefined, undefined, undefined, "../im"],
      ["local", "a", "task", undefined, undefined, undefined, {}]
    ])
      expect(() => call("bots:exchange-history", ...args)).toThrow()
    expect(fixture.exchangeHistory).not.toHaveBeenCalled()
    call("bots:exchange-history", "local", "a", "task", "group", "cursor")
    expect(fixture.exchangeHistory).toHaveBeenCalledWith("a", "task", "group", "cursor", undefined, undefined)
    call("bots:exchange-history", "local", "a", "task", undefined, "cursor", undefined, "im-one")
    expect(fixture.exchangeHistory).toHaveBeenLastCalledWith("a", "task", undefined, "cursor", undefined, "im-one")
  })

  it("returns a local unread boolean from existing activity without loading or marking conversations", () => {
    const unread = { bot: false, group: false, work: false, im: false }
    fixture.getHost.mockReturnValue({
      ...fixture,
      hasUnread: LocalBotHost.prototype.hasUnread,
      store: {
        hasUnread: () => Object.values(unread).some(Boolean)
      }
    })
    const call = register()
    expect(() => call("bots:has-unread", "remote")).toThrow("仅支持本机")
    expect(call("bots:has-unread", "local")).toBe(false)
    for (const source of ["bot", "group", "work", "im"] as const) {
      unread[source] = true
      expect(call("bots:has-unread", "local"), source).toBe(true)
      unread[source] = false
    }
    expect(call("bots:has-unread", "local")).toBe(false)
    expect(fixture.snapshot).not.toHaveBeenCalled()
    expect(fixture.markRead).not.toHaveBeenCalled()
  })

  it("validates manual unread requests before mutating a host", () => {
    const call = register()
    expect(() => call("bots:mark-unread", "remote", "bot", "a")).toThrow()
    expect(() => call("bots:mark-unread", "local", "thread", "a")).toThrow()
    expect(() => call("bots:mark-unread", "local", "bot", "../a")).toThrow()
    expect(fixture.markUnread).not.toHaveBeenCalled()
    call("bots:mark-unread", "local", "group", "a")
    expect(fixture.markUnread).toHaveBeenCalledWith("group", "a")
  })

  it("resolves existing group browser scopes before forwarding page requests", () => {
    const call = register()
    expect(() => call("bots:browser:preview", "local", "group-missing--a")).toThrow("不存在")
    expect(() => call("bots:browser:preview", "local", "group-../private")).toThrow()
    expect(fixture.preview).not.toHaveBeenCalled()
    call("bots:browser:preview", "local", "group-g--a")
    expect(fixture.preview).toHaveBeenCalledWith("group-g--a", undefined)
  })
  it("rejects invalid read cursors and host identities before changing read state", () => {
    const call = register()
    for (const version of [0, -1, 0.5, "1", NaN, Infinity])
      expect(() => call("bots:mark-read", "local", "bot", "a", version)).toThrow()
    expect(() => call("bots:mark-read", "remote", "bot", "a", 1)).toThrow()
    expect(() => call("bots:mark-read", "local", "thread", "a", 1)).toThrow()
    expect(() => call("bots:mark-read", "local", "bot", "../a", 1)).toThrow()
    expect(fixture.markRead).not.toHaveBeenCalled()
    call("bots:mark-read", "local", "group", "a", 2)
    expect(fixture.markRead).toHaveBeenCalledWith("group", "a", 2)
  })
  it("rejects unknown hosts, unsafe identities and unversioned memory mutations before side effects", () => {
    const call = register()
    expect(() => call("bots:create", "remote", {})).toThrow("仅支持本机")
    expect(() => call("bots:memory:share", "local", "a", "../fact", "a".repeat(64), "b")).toThrow()
    expect(() => call("bots:memory:share", "local", "a", "fact", "invalid", "b")).toThrow()
    expect(() =>
      call("bots:memory:share", "local", "a", "fact", "a".repeat(64), "archived")
    ).toThrow("恢复")
    expect(() =>
      call("bots:memory:write", "local", "a", { id: "fact", name: "N", content: "C" })
    ).toThrow()
    expect(() => call("bots:browser:preview", "local", "a", "../../target")).toThrow()
    expect(fixture.share).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled()
    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.preview).not.toHaveBeenCalled()
    call("bots:memory:share", "local", "a", "fact", "a".repeat(64), "b")
    expect(fixture.share).toHaveBeenCalledWith("a", "fact", "a".repeat(64), "b")
  })
  it("validates deletion ownership before reusing thread teardown and supports partial-cleanup retries", async () => {
    const deleteThread = vi.fn(async () => {})
    const call = register(deleteThread)
    fixture.remove.mockImplementation((_id, _version, cleanup) =>
      cleanup(["private-thread", "already-gone"])
    )
    fixture.getThread.mockImplementation((id) =>
      id === "already-gone"
        ? null
        : { metadata: JSON.stringify({ botId: "b", botHostId: "local" }) }
    )
    expect(() => call("bots:remove", "remote", "a", 1)).toThrow("仅支持本机")
    expect(() => call("bots:remove", "local", "../a", 1)).toThrow()
    expect(() => call("bots:remove", "local", "a", 0)).toThrow()
    await expect(call("bots:remove", "local", "a", 1)).rejects.toThrow("归属")
    expect(deleteThread).not.toHaveBeenCalled()
    expect(fixture.removeBot).not.toHaveBeenCalled()
    fixture.getThread.mockImplementation((id) =>
      id === "already-gone"
        ? null
        : { metadata: JSON.stringify({ botId: "a", botHostId: "local" }) }
    )
    await call("bots:remove", "local", "a", 1)
    expect(deleteThread).toHaveBeenCalledTimes(1)
    expect(deleteThread).toHaveBeenCalledWith({}, "private-thread", { requireIdle: true })
    expect(fixture.removeBot).toHaveBeenCalledTimes(2)
  })
  it("refuses to delete a private thread through the group cleanup route", async () => {
    const deleteThread = vi.fn(async () => {})
    const call = register(deleteThread)
    fixture.removeGroup.mockImplementation((_id, _version, cleanup) => cleanup(["member-thread"]))
    fixture.getThread.mockReturnValue({
      metadata: JSON.stringify({ botId: "a", botHostId: "local" })
    })
    await expect(call("bots:group:remove", "local", "g", 1)).rejects.toThrow("归属")
    expect(deleteThread).not.toHaveBeenCalled()
    fixture.getThread.mockReturnValue({
      metadata: JSON.stringify({ botId: "a", botHostId: "local", botGroupId: "g" })
    })
    await call("bots:group:remove", "local", "g", 1)
    expect(deleteThread).toHaveBeenCalledWith({}, "member-thread", { requireIdle: true })
    expect(fixture.removeBrowserGroup).toHaveBeenCalledWith("g")
  })
  it("keeps existing app registration alive when the optional Bot database cannot open", () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
    fixture.getHost.mockImplementation(() => {
      throw new Error("database unavailable")
    })
    try {
      const call = register()
      expect(() => call("bots:snapshot", "local")).toThrow("database unavailable")
      fixture.getHost.mockImplementation(() => fixture)
      expect(call("bots:snapshot", "local")).toEqual({ revision: 1 })
      expect(fixture.subscribe).toHaveBeenCalledTimes(1)
      call("bots:snapshot", "local")
      expect(fixture.subscribe).toHaveBeenCalledTimes(1)
    } finally {
      diagnostic.mockRestore()
    }
  })
})

it.each([false, true])("accepts real IM browser scopes through every IPC (tool-created=%s)", async (toolCreated) => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const owner = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const task = store.enqueue({ botId: owner.id, requestId: "create-peer", message: "Create a teammate" })
  store.transition(task.id, "running")
  const teammate = toolCreated
    ? store.createTeammate(task.id, "peer", { name: "Peer", instructions: "Research" })
    : store.create({ name: "Peer", instructions: "Research", color: "#123456", modelRef: null })
  store.settle(task.id, "completed", null, "Created")
  const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
  try {
    const route = host.imGateway.register("realm", "principal", {
      id: "binding", botId: teammate.id, kind: "group", label: "Research", version: 1,
      state: "active", conversationKey: "conversation", expiresAt: "2099-01-01T00:00:00Z",
      createdAt: "2026-11-01T00:00:00Z"
    })
    fixture.getHost.mockReturnValue(host)
    const invoke = register()
    const scopes = [
      botImBrowserScope(route.id, teammate.id),
      botImBrowserScope(route.id, teammate.id, owner.id),
      botImBrowserScope(route.id, teammate.id, owner.id, `im-peer-${task.id}-${owner.id}`)
    ]
    expect(scopes[0].length).toBe(toolCreated ? 144 : 108)
    for (const scope of scopes) {
      invoke("bots:browser:preview", "local", scope, "page")
      expect(fixture.preview).toHaveBeenLastCalledWith(scope, "page")
      invoke("bots:browser:takeover", "local", scope, "page")
      expect(fixture.takeOver).toHaveBeenLastCalledWith(scope, "page")
      invoke("bots:browser:give-back", "local", scope, 2)
      expect(fixture.giveBack).toHaveBeenLastCalledWith(scope, 2)
      invoke("bots:browser:navigate", "local", scope, "page", "https://example.invalid")
      expect(fixture.navigate).toHaveBeenLastCalledWith(scope, "page", "https://example.invalid")
      invoke("bots:browser:operate", "local", scope, { action: "reload", pageId: "page" }, 2)
      expect(fixture.operateBrowser).toHaveBeenLastCalledWith(scope, { action: "reload", pageId: "page" }, 2)
    }
    const calls = fixture.preview.mock.calls.length
    for (const invalid of [
      botImBrowserScope(route.id, owner.id), // Existing binding, wrong owner.
      botImBrowserScope("missing-binding", teammate.id),
      botImBrowserScope(route.id, teammate.id, "deleted-peer"),
      `${scopes[0]}--${owner.id}--im-peer-root-wrong-executor`,
      `${scopes[0]}--${owner.id}--im-peer-root-${owner.id}--extra`
    ]) expect(() => invoke("bots:browser:preview", "local", invalid)).toThrow()
    expect(() => invoke("bots:browser:preview", "local", scopes[0], "p".repeat(129))).toThrow()
    expect(fixture.preview).toHaveBeenCalledTimes(calls)
  } finally { await host.stop(); db.close() }
})

it("checks only the exact bound or initialized native desktop work's browser scope before unlink", () => {
  const mainFrame = {}
  const sender = { mainFrame }
  const invoke = register(undefined, { sender, senderFrame: mainFrame })
  const work = { id: "work", botId: "a", audienceKey: "desktop", conversation: { state: "bound" } }
  fixture.getWork.mockReturnValue(work)
  fixture.hasOpenPages.mockReturnValue(true)
  const channel = "bots:conversation:unlink-has-open-pages"
  expect(invoke(channel, "local", "a", "work")).toBe(true)
  expect(fixture.getWork).toHaveBeenCalledWith("a", "work")
  expect(fixture.hasOpenPages).toHaveBeenCalledWith("work-work--a")
  expect(fixture.preview).not.toHaveBeenCalled()
  fixture.getWork.mockReturnValue({ ...work, conversation: { state: "detached" } })
  expect(() => invoke(channel, "local", "a", "work")).toThrow("原任务关联已变化")
  const native = { ...work, conversation: undefined, threadId: "native", threadInitialized: true }
  const metadata = { botId: "a", botWorkId: "work", botHostId: "local", botAudienceKey: "desktop", workspacePath: "/native" }
  fixture.getWork.mockReturnValue(native)
  fixture.getThread.mockReturnValue({ thread_id: "native", metadata: JSON.stringify(metadata) })
  expect(invoke(channel, "local", "a", "work")).toBe(true)
  expect(fixture.hasOpenPages).toHaveBeenLastCalledWith("work-work--a")
  fixture.getThread.mockReturnValue({ thread_id: "native", metadata: JSON.stringify({ ...metadata, botWorkId: "other" }) })
  expect(() => invoke(channel, "local", "a", "work")).toThrow("归属不一致")
  fixture.getWork.mockReturnValue({ ...native, threadInitialized: false })
  expect(() => invoke(channel, "local", "a", "work")).toThrow("尚无可解除")
  const otherFrame = register(undefined, { sender, senderFrame: {} })
  expect(() => otherFrame(channel, "local", "a", "work")).toThrow()
  expect(fixture.hasOpenPages).toHaveBeenCalledTimes(2)
})
