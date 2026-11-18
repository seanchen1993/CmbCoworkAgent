import { DatabaseSync } from "node:sqlite"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import type { ThreadSummaryRow } from "../db"
const f = vi.hoisted(() => ({
  rows: new Map<string, ThreadSummaryRow>(),
  update: vi.fn(),
  busy: false,
  goal: false,
  approval: false,
  checkpoint: null as unknown,
  prepare: vi.fn(() => "/fixture"),
  normalizeModel: vi.fn((ref: string) => ref),
  threadGrant: vi.fn(),
  validateWorkspace: vi.fn<(path: unknown) => Promise<string>>(),
  check: vi.fn(),
  host: null as LocalBotHost | null
}))
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => ({}) },
  powerMonitor: { on: () => {} }
}))
vi.mock("./local-service", () => ({
  initializeBotNotificationDispatch: () => {},
  getLocalBotHost: () => f.host,
  getBotMemoryService: () => ({ removeBot: async () => {} }),
  getBotBrowserService: () => ({ removeBot: async () => {} })
}))
vi.mock("../agent/pending-notification-scheduler", () => ({
  pendingNotificationScheduler: { requestCheck: f.check }
}))
vi.mock("./runtime-adapter", () => ({ prepareBotThread: f.prepare }))
vi.mock("../models/registry", () => ({ normalizeModelRef: f.normalizeModel }))
vi.mock("../ipc/bot-files", () => ({ registerBotFileHandlers: () => {} }))
vi.mock("../agent/runtime", () => ({
  hasPendingApprovalForRuntimeThread: () => f.approval,
  withCheckpointer: (_id: string, body: (saver: unknown) => Promise<unknown>) =>
    body({ getTuple: async () => f.checkpoint })
}))
vi.mock("../db", () => ({
  getThreadCore: (id: string) => f.rows.get(id) ?? null,
  updateThread: f.update
}))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: {
    withThreadTransitionLease: (_id: string, body: () => Promise<unknown>) => body()
  }
}))
vi.mock("../services/thread-external-run-busy", () => ({
  isExternallyManagedThreadRunBusy: (id: string) => f.busy || Boolean(getLocalThreadRunLease(id))
}))
vi.mock("../services/im/remote-grant-store", () => ({
  imRemoteGrantStore: { getThreadGrant: f.threadGrant }
}))
vi.mock("../services/workspace-validation", async (load) => {
  const actual = await load<typeof import("../services/workspace-validation")>()
  const validate = (path: unknown) => path === "/original/workspace"
    ? Promise.resolve(path) : actual.validateWorkspaceDirectory(path)
  f.validateWorkspace.mockImplementation(validate)
  return { ...actual, validateWorkspaceDirectory: f.validateWorkspace }
})
vi.mock("../agent/goals/runtime", () => ({
  goalManager: { getActive: () => (f.goal ? {} : null) }
}))
import { registerBotHandlers } from "../ipc/bots"
import { createBotNotificationDispatcher } from "./notification-dispatch"
import {
  exposeWorkConversation,
  linkExistingConversation,
  resolveWorkConversation,
  unlinkWorkConversation
} from "./conversation-link-service"
import {
  assertScopedBotWorkThreadDeletion,
  assertWorkConversationEntry,
  setWorkConversationLookup
} from "./conversation-link-authority"
import { captureBotWorkDeletionTarget, removeBotWork } from "./work-deletion"
import { claimLocalThreadRunLease, getLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import type { BotConversationTransitionRequest } from "../../shared/bots/conversation"
import { botWorkBrowserScope } from "../../shared/bots/work"
import { createBotConversationTools, setBotConversationDeletionService } from "./conversation-tool-management"
import { protectedBotHistoryTitle } from "./history-input-projection"
import { finishBotConversationTransition, listenBotConversationTransitions } from "./conversation-transition"
const resources: Array<{ db: NativeSqliteAdapter; host: LocalBotHost }> = []
afterEach(async () => {
  await Promise.all(resources.map((r) => r.host.stop()))
  resources.splice(0).forEach((r) => r.db.close())
  setWorkConversationLookup(undefined)
  setBotConversationDeletionService(undefined)
  f.rows.clear()
  f.busy = false
  f.goal = false
  f.approval = false
  f.checkpoint = null
  f.update.mockReset()
  f.check.mockReset()
  f.threadGrant.mockReset()
  f.validateWorkspace.mockClear()
  f.normalizeModel.mockReset().mockImplementation((ref: string) => ref)
})
function fixture(desktopTools = false, waitForStop?: () => Promise<void>) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:")),
    store = new BotStore(db)
  const pending = vi.fn(async (_threads: readonly string[], _options?: { allowPendingCoordinatorNotifications?: boolean }) => false)
  const coordinatorPending = vi.fn((_threads: string[]) => false)
  const removeWorkBrowser = vi.fn(async (_scope: string) => {})
  const host = new LocalBotHost(
    store,
    {
      acquire: desktopTools ? () => ({
        release() {},
        execute: signal => new Promise(resolve => {
          const finish = () => { void Promise.resolve(waitForStop?.()).then(() => resolve({ state: "completed" })) }
          if (signal.aborted) finish()
          else signal.addEventListener("abort", finish, { once: true })
        })
      }) : () => null,
      onAvailable: () => () => {},
      hasPendingWork: pending,
      hasPendingCoordinator: coordinatorPending,
      removeWorkBrowser,
      ...(desktopTools ? { conversationTools: createBotConversationTools(() => f.host!) } : {})
    },
    2,
    () => {}
  )
  resources.push({ db, host })
  f.host = host
  const bot = store.create({
    name: "Expert",
    instructions: "Original role",
    color: "#123456",
    modelRef: "custom:bot-default"
  })
  const original = {
    workspacePath: "/original/workspace",
    model: "custom:original",
    agentMode: "normal",
    memoryEnabled: true,
    outputStyle: "normal",
    title: "Original title",
    cmb_thread_incarnation: "original-token"
  }
  const row = {
    thread_id: "original",
    created_at: 123,
    updated_at: 123,
    status: "idle",
    metadata: JSON.stringify(original),
    title: "Original title"
  } as ThreadSummaryRow
  f.rows.set(row.thread_id, row)
  f.update.mockImplementation((id: string, patch: Partial<ThreadSummaryRow>) => {
    f.rows.set(id, { ...f.rows.get(id)!, ...patch })
  })
  setWorkConversationLookup((id) => store.conversations.forThread(id))
  const input = {
    botId: bot.id,
    operationId: "associate",
    title: "Task title",
    goal: "Continue original",
    conversation: {
      kind: "local_thread" as const,
      threadId: row.thread_id,
      incarnation: captureThreadIncarnation(row)
    }
  }
  return { db, store, host, bot, original, row, input, pending, coordinatorPending, removeWorkBrowser }
}
describe("trusted local conversation handshake", () => {
  it.each([false, true])("keeps default protected Fork names out of model work context, explicit new name=%s", async explicit => {
    const x = fixture()
    f.rows.set(x.row.thread_id, { ...x.row, metadata: JSON.stringify({
      ...x.original, ...protectedBotHistoryTitle(x.row.title!)
    }) })
    const title = explicit ? "Explicit task name" : x.row.title!
    const input = { ...x.input, title }
    const work = await linkExistingConversation(x.host, input)
    const expected = explicit ? title : "原任务"
    expect(x.host.associatedWorks(x.bot.id).items[0]).toMatchObject({ title, goal: input.goal })
    expect(x.host.associatedWorks(x.bot.id, "model").items[0]).toMatchObject({ title: expected, goal: input.goal })
    expect(x.store.projectWorkForModel(work)).toMatchObject({ title: expected, goal: input.goal })
    expect(x.store.listWorks(x.bot.id, undefined, title, undefined, "model").items).toHaveLength(explicit ? 1 : 0)
    expect(x.store.listWorks(x.bot.id, undefined, title).items).toHaveLength(1)
    expect(f.rows.get("original")!.title).toBe(x.row.title)
    expect(x.store.recentTasks()).toHaveLength(0)
    expect((await linkExistingConversation(x.host, input)).id).toBe(work.id)
    const renamed = x.store.renameDesktopWork(work, "User renamed task")
    expect(x.store.projectWorkForModel(renamed)).toMatchObject({ title: renamed.title, goal: input.goal })
    expect(x.host.associatedWorks(x.bot.id, "model").items[0].title).toBe(renamed.title)
  })

  it("unlinks the exact initialized native work without exposing it and replays its original version", async () => {
    const x = fixture(true)
    const workspace = await mkdtemp(join(tmpdir(), "bot-unexposed-unlink-"))
    const originalFile = join(workspace, "result.md")
    await writeFile(originalFile, "original result")
    const { work, task } = x.store.createWork({
      botId: x.bot.id, operationId: "native", title: "Native result", goal: "Keep the original result"
    }, undefined, { kind: "default", path: workspace })
    const { threadId } = work
    const original = { ...x.original, workspacePath: workspace }
    const metadata = {
      ...original, botId: x.bot.id, botHostId: "local", botWorkId: work.id, botAudienceKey: "desktop"
    }
    const row = { ...x.row, thread_id: threadId, metadata: JSON.stringify(metadata) }
    f.rows.set(threadId, row)
    x.store.initializeWorkThread(x.bot.id, work.id)
    x.store.transition(task.id, "running")
    x.store.transition(task.id, "completed")
    const initial = x.store.getWork(x.bot.id, work.id)
    const current = x.host.send({ botId: x.bot.id, requestId: "unlink-user", message: "Unlink Native result" })
    const source = { taskId: current.id, callId: "unlink-native", key: "unlink-native" }
    const input = { workId: work.id, expectedVersion: initial.version }
    const controller = new AbortController()
    const requests: BotConversationTransitionRequest[] = []
    const window = Object.assign(new EventEmitter(), { id: 91, isDestroyed: () => false,
      send: (channel: string, request: BotConversationTransitionRequest) => {
        if (channel === "bots:conversation:transition") requests.push(request)
      }
    }) as unknown as WebContents
    listenBotConversationTransitions(window, true)
    try {
      await vi.waitFor(() => expect(x.host.workToolSource(current.id).id).toBe(current.id))
      const attempt = (signal = controller.signal) => x.host.unlinkWorkFromTool(source, input, signal)
      const unchanged = () => {
        expect(x.store.getWork(x.bot.id, work.id).version).toBe(initial.version)
        expect(x.store.conversations.record(work.id)).toBeUndefined()
        expect(x.db.exec("SELECT 1 FROM bot_work_commands WHERE tool_call_id=?", [source.callId])[0]?.values).toEqual([])
        expect(f.update).not.toHaveBeenCalled()
      }
      await expect(x.host.unlinkWorkFromTool(source, { ...input, expectedVersion: initial.version + 1 }, controller.signal))
        .rejects.toThrow("任务已变化")
      f.rows.set(threadId, { ...row, metadata: JSON.stringify({ ...metadata, botWorkId: "another-work" }) })
      await expect(attempt()).rejects.toThrow("归属不一致")
      f.rows.set(threadId, row)
      expect(requests).toHaveLength(0)
      unchanged()

      for (const [block, reason] of [
        ["busy", "会话执行"], ["approval", "审批"], ["pending", "后台执行"], ["incarnation", "会话身份"], ["cancel", "已停止"]
      ] as const) {
        const abort = new AbortController()
        const rejected = expect(attempt(abort.signal)).rejects.toThrow(reason)
        const request = requests.at(-1)!
        expect(request).toMatchObject({ action: "unlink", threadId,
          link: { work: { id: work.id } },
          unexposedRef: { kind: "local_thread", threadId, incarnation: captureThreadIncarnation(row) }
        })
        if (request.action === "unlink") expect(request.link.work.conversation).toBeUndefined()
        if (block === "busy" || block === "approval") f[block] = true
        if (block === "pending") x.pending.mockResolvedValueOnce(true)
        if (block === "incarnation")
          f.rows.set(threadId, { ...row, metadata: JSON.stringify({ ...metadata, cmb_thread_incarnation: "replacement" }) })
        if (block === "cancel") {
          abort.abort()
          await expect(finishBotConversationTransition(window.id, request.id)).rejects.toThrow("已失效")
        } else await expect(finishBotConversationTransition(window.id, request.id)).rejects.toThrow(reason)
        await rejected
        unchanged()
        f.busy = f.approval = false
        f.rows.set(threadId, row)
      }

      const linked = attempt()
      await finishBotConversationTransition(window.id, requests.at(-1)!.id)
      const detached = await linked
      expect(detached).toMatchObject({ workId: work.id, version: initial.version + 2, state: "detached" })
      const detachedMetadata = JSON.stringify({ ...original, ...protectedBotHistoryTitle(null) })
      expect(f.update).toHaveBeenCalledExactlyOnceWith(threadId, { metadata: detachedMetadata })
      expect(f.rows.get(threadId)).toMatchObject({ ...row, metadata: detachedMetadata })
      expect(x.store.getTask(task.id).state).toBe("completed")
      expect(x.store.conversations.forThread(threadId)).toBeNull()
      await expect(readFile(originalFile, "utf8")).resolves.toBe("original result")
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.validateWorkspace).not.toHaveBeenCalled()
      expect(x.removeWorkBrowser).not.toHaveBeenCalled()
      await expect(x.host.unlinkWorkFromTool({ ...source, callId: "retry-native" }, input, controller.signal)).resolves.toEqual(detached)
      expect(requests).toHaveLength(6)
      expect(f.update).toHaveBeenCalledOnce()
    } finally {
      listenBotConversationTransitions(window, false)
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("deletes the exact ordinary thread only after desktop confirmation and replays without repeating cleanup", async () => {
    const x = fixture(true)
    const requests: BotConversationTransitionRequest[] = []
    const window = Object.assign(new EventEmitter(), { id: 64, mainFrame: {}, isDestroyed: () => false,
      send: (channel: string, request: BotConversationTransitionRequest) => {
        if (channel === "bots:conversation:transition") requests.push(request)
      } }) as unknown as WebContents
    listenBotConversationTransitions(window, true)
    const event = { sender: window, senderFrame: window.mainFrame } as IpcMainInvokeEvent
    const service = vi.fn(async (_event, id: string) => {
      const row = f.rows.get(id)!
      expect(assertScopedBotWorkThreadDeletion(id, row, JSON.parse(row.metadata!))).toBe(true)
      f.rows.delete(id)
    })
    setBotConversationDeletionService(service)
    try {
      const task = x.host.send({ botId: x.bot.id, requestId: "delete ordinary", message: "Delete the original conversation" })
      await vi.waitFor(() => expect(x.host.workToolSource(task.id).id).toBe(task.id))
      const source = { taskId: task.id, callId: "delete-call", key: "delete-key" }
      const input = { conversation: x.input.conversation, expectedTitle: x.row.title! }
      f.rows.set("original", { ...x.row, metadata: JSON.stringify({ ...x.original, agentMode: "workflow" }) })
      await expect(x.host.deleteOrdinaryThreadFromTool(source, input, new AbortController().signal))
        .rejects.toThrow("待删除会话已变化")
      expect(requests).toHaveLength(0)
      f.rows.set("original", x.row)
      const result = x.host.deleteOrdinaryThreadFromTool(source, input, new AbortController().signal)
      expect(requests[0]).toMatchObject({ action: "delete", title: "Original title", threadId: "original" })
      expect(service).not.toHaveBeenCalled()
      expect(x.host.conversationLinks.ordinaryDeletion(x.bot.id, input, source)).toBeUndefined()
      await expect(finishBotConversationTransition(window.id, requests[0].id, undefined, event)).resolves.toEqual({ deletedThreadId: "original" })
      await expect(result).resolves.toEqual({ state: "deleted", deletedThreadId: "original" })
      await expect(x.host.deleteOrdinaryThreadFromTool({ ...source, callId: "retry-delete" }, input, new AbortController().signal))
        .resolves.toEqual({ state: "deleted", deletedThreadId: "original" })
      expect(service).toHaveBeenCalledTimes(1)
      expect(x.host.listWorks(x.bot.id).items).toEqual([])
      expect(x.store.recentTasks()).toHaveLength(1)
      await expect(x.host.deleteOrdinaryThreadFromTool(source, { ...input, expectedTitle: "Other" }, new AbortController().signal)).rejects.toThrow("其他内容")
      f.rows.set("original", { ...x.row, metadata: JSON.stringify({ ...x.original, cmb_thread_incarnation: "replacement" }) })
      await expect(x.host.deleteOrdinaryThreadFromTool(source, input, new AbortController().signal)).rejects.toThrow("原会话已变化")
      expect(service).toHaveBeenCalledTimes(1)
    } finally { listenBotConversationTransitions(window, false) }
  })

  it("rejects changed or cancelled deletion targets without stopping or deleting any thread", async () => {
    const x = fixture(true), requests: BotConversationTransitionRequest[] = []
    const window = Object.assign(new EventEmitter(), { id: 65, mainFrame: {}, isDestroyed: () => false,
      send: (channel: string, request: BotConversationTransitionRequest) => { if (channel === "bots:conversation:transition") requests.push(request) }
    }) as unknown as WebContents
    listenBotConversationTransitions(window, true)
    const event = { sender: window, senderFrame: window.mainFrame } as IpcMainInvokeEvent
    const service = vi.fn()
    setBotConversationDeletionService(service)
    try {
      const task = x.host.send({ botId: x.bot.id, requestId: "delete changed", message: "Delete original" })
      await vi.waitFor(() => expect(x.host.workToolSource(task.id).id).toBe(task.id))
      const source = { taskId: task.id, callId: "delete-call", key: "delete-key" }
      const input = { conversation: x.input.conversation, expectedTitle: x.row.title! }
      const result = x.host.deleteOrdinaryThreadFromTool(source, input, new AbortController().signal)
      const check = expect(result).rejects.toThrow("待删除会话已变化")
      f.rows.set("original", { ...x.row, title: "User renamed" })
      await expect(finishBotConversationTransition(window.id, requests[0].id, undefined, event)).rejects.toThrow("待删除会话已变化")
      await check
      expect(x.host.conversationLinks.ordinaryDeletion(x.bot.id, input, source)).toBeUndefined()
      f.rows.set("original", x.row)
      const controller = new AbortController()
      const cancelled = x.host.deleteOrdinaryThreadFromTool(source, input, controller.signal)
      const cancelledCheck = expect(cancelled).rejects.toThrow("原任务已停止")
      controller.abort()
      await cancelledCheck
      expect(service).not.toHaveBeenCalled()
      expect(f.rows.get("original")).toEqual(x.row)
    } finally { listenBotConversationTransitions(window, false) }
  })

  it("confirms deletion of one uninitialized work without creating a thread or stopping its caller", async () => {
    const x = fixture(true), requests: BotConversationTransitionRequest[] = []
    const window = Object.assign(new EventEmitter(), { id: 66, mainFrame: {}, isDestroyed: () => false,
      send: (channel: string, request: BotConversationTransitionRequest) => { if (channel === "bots:conversation:transition") requests.push(request) }
    }) as unknown as WebContents
    listenBotConversationTransitions(window, true)
    const event = { sender: window, senderFrame: window.mainFrame } as IpcMainInvokeEvent
    const service = vi.fn()
    setBotConversationDeletionService(service)
    try {
      const task = x.host.send({ botId: x.bot.id, requestId: "delete work", message: "Delete the pending work" })
      await vi.waitFor(() => expect(x.host.workToolSource(task.id).id).toBe(task.id))
      const created = await x.host.createWork({ botId: x.bot.id, operationId: "delete-pending", title: "Pending work", goal: "Pending" })
      const input = { workId: created.work.id, expectedVersion: created.work.version }
      const source = { taskId: task.id, callId: "work-delete-call", key: "work-delete-key" }
      const result = x.host.deleteWorkFromTool(source, input, new AbortController().signal)
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      expect(x.host.workDeletionRecord(x.bot.id, created.work.id)).toBeUndefined()
      await expect(finishBotConversationTransition(window.id, requests[0].id, undefined, event)).resolves.toEqual({ deletedWork: { botId: x.bot.id, workId: created.work.id } })
      await expect(result).resolves.toEqual({ botId: x.bot.id, workId: created.work.id, state: "deleted" })
      expect(service).not.toHaveBeenCalled()
      expect(x.host.workToolSource(task.id).state).toBe("running")
      expect(x.store.getTask(created.task.id).state).toBe("cancelled")
      await expect(x.host.deleteWorkFromTool({ ...source, callId: "retry-work-delete" }, input, new AbortController().signal)).resolves.toMatchObject({ state: "deleted" })
      expect(requests).toHaveLength(1)
    } finally { listenBotConversationTransitions(window, false) }
  })

  it("blocks opening an uninitialized work awaiting deletion and retries without creating a thread", async () => {
    const x = fixture()
    const first = await x.host.createWork({ botId: x.bot.id, operationId: "first", title: "First", goal: "Pending" })
    const second = await x.host.createWork({ botId: x.bot.id, operationId: "second", title: "Second", goal: "Pending" })
    const target = captureBotWorkDeletionTarget(x.host, x.bot.id, first.work.id, first.work.version)
    const deleteThread = vi.fn()
    expect(target.incarnation).toBeNull()
    x.removeWorkBrowser.mockRejectedValueOnce(new Error("temporary cleanup failure"))
    await expect(removeBotWork(x.host, target, deleteThread)).rejects.toThrow("重试删除")
    expect(x.host.getWork(x.bot.id, first.work.id)).toMatchObject({
      deletionPending: true, threadInitialized: false
    })
    expect(x.host.workDeletionRecord(x.bot.id, first.work.id)).toMatchObject({
      phase: "stopping", incarnation: null
    })
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerBotHandlers({ handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } as unknown as IpcMain)
    expect(() => handlers.get("bots:open")!({}, "local", x.bot.id, first.work.id)).toThrow("任务正在删除")
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.rows.has(first.work.threadId)).toBe(false)
    const retryTarget = captureBotWorkDeletionTarget(x.host, x.bot.id, first.work.id, first.work.version)
    expect(retryTarget).toMatchObject(target)
    await expect(removeBotWork(x.host, retryTarget, deleteThread)).resolves.toEqual({
      botId: x.bot.id, workId: first.work.id, state: "deleted"
    })
    expect(deleteThread).not.toHaveBeenCalled()
    expect(x.store.getTask(first.task.id).state).toBe("cancelled")
    expect(x.store.getTask(second.task.id).state).toBe("queued")
    expect(x.host.listWorks(x.bot.id).items.map(work => work.id)).toEqual([second.work.id])
    const summaries = x.host.workSummaries(x.bot.id, [first.work.id, second.work.id])
    expect(summaries).toHaveLength(2)
    expect(summaries.find(work => work.id === first.work.id)).toMatchObject({
      title: "First", deletionCommitted: true
    })
    expect(summaries.find(work => work.id === second.work.id)?.deletionCommitted).toBeUndefined()
    expect(x.host.getBot(x.bot.id).deleting).toBe(false)
    const stopped = x.host.getWork(x.bot.id, first.work.id)
    expect(stopped.deletionCommitted).toBe(true)
    expect(() => x.store.changeWork(x.bot.id, first.work.id, stopped.version, "reopen", "continue")).toThrow("删除")
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it("keeps a native binding until cleanup and exact physical deletion have both completed", async () => {
    const x = fixture()
    const { work } = await x.host.createWork({ botId: x.bot.id, operationId: "native", title: "Native", goal: "Pending" })
    f.rows.set(work.threadId, {
      ...x.row, thread_id: work.threadId,
      metadata: JSON.stringify({
        workspacePath: "/native", botId: work.botId, botWorkId: work.id,
        botAudienceKey: "desktop", botHostId: "local", cmb_thread_incarnation: "native-incarnation"
      })
    })
    // Ordinary sidebar deletion must also recognize this ownership before exposure.
    expect(x.host.conversationLinks.forThread(work.threadId)?.id).toBe(work.id)
    const unexposed = captureBotWorkDeletionTarget(x.host, work.botId, work.id, work.version)
    expect(unexposed.incarnation?.token).toBe("native-incarnation")
    f.validateWorkspace.mockResolvedValueOnce("/native")
    const bound = await exposeWorkConversation(x.host, work.botId, work.id)
    const target = captureBotWorkDeletionTarget(x.host, bound.botId, bound.id, bound.version)
    const deleteThread = vi.fn(async (id: string) => {
      const row = f.rows.get(id)!
      const metadata = JSON.parse(row.metadata!)
      expect(assertScopedBotWorkThreadDeletion(id, row, metadata)).toBe(true)
      expect(metadata.botLocalConversation).toBe(true)
      expect(x.host.conversationLinks.forThread(id)?.conversation?.state).toBe("bound")
      expect(() => assertScopedBotWorkThreadDeletion(id, {
        ...row, metadata: JSON.stringify({ ...metadata, cmb_thread_incarnation: "replacement" })
      }, metadata)).toThrow("原会话身份已变化")
      f.rows.delete(id)
    })
    x.pending.mockResolvedValueOnce(true)
    await expect(removeBotWork(x.host, target, deleteThread)).rejects.toThrow("后台工作")
    expect(deleteThread).not.toHaveBeenCalled()
    expect(x.host.workDeletionRecord(work.botId, work.id)?.phase).toBe("stopping")
    const stopping = x.host.getWork(work.botId, work.id)
    expect(stopping).toMatchObject({ deletionPending: true, conversation: { state: "bound" } })
    expect(stopping.deletionCommitted).toBeUndefined()
    expect(x.host.listWorks(work.botId).items).toMatchObject([{ id: work.id, deletionPending: true }])
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerBotHandlers({ handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } as unknown as IpcMain)
    const beforeOpen = f.rows.get(work.threadId)
    expect(() => handlers.get("bots:open")!({}, "local", work.botId, work.id)).toThrow("任务正在删除")
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.rows.get(work.threadId)).toBe(beforeOpen)
    await expect(removeBotWork(x.host, target, deleteThread)).resolves.toMatchObject({
      state: "deleted", deletedThreadId: work.threadId
    })
    expect(deleteThread).toHaveBeenCalledTimes(1)
    expect(x.host.conversationLinks.forThread(work.threadId)).toBeNull()
    const deleted = x.host.getWork(work.botId, work.id)
    expect(deleted.deletionPending).toBeUndefined()
    expect(deleted).toMatchObject({ deletionCommitted: true, conversation: { state: "bound" } })
  })

  it("waits for an unexposed native run to exit before starting physical deletion", async () => {
    let stopped = false
    let release!: () => void
    const settling = new Promise<void>(resolve => { release = resolve })
    const x = fixture(true, () => { stopped = true; return settling })
    try {
      const { work, task } = await x.host.createWork({ botId: x.bot.id, operationId: "running", title: "Native", goal: "Live" })
      f.rows.set(work.threadId, {
        ...x.row, thread_id: work.threadId,
        metadata: JSON.stringify({
          workspacePath: "/native", botId: work.botId, botWorkId: work.id,
          botAudienceKey: "desktop", botHostId: "local", cmb_thread_incarnation: "native-incarnation"
        })
      })
      await vi.waitFor(() => expect(x.store.getTask(task.id).state).toBe("running"))
      const current = x.host.getWork(work.botId, work.id)
      const target = captureBotWorkDeletionTarget(x.host, work.botId, work.id, current.version)
      const deleteThread = vi.fn(async (id: string) => {
        const row = f.rows.get(id)!
        expect(assertScopedBotWorkThreadDeletion(id, row, JSON.parse(row.metadata!))).toBe(true)
        expect(x.host.conversationLinks.forThread(id)?.conversation).toBeUndefined()
        expect(x.store.getTask(task.id).state).toBe("cancelled")
        f.rows.delete(id)
      })
      const deletion = removeBotWork(x.host, target, deleteThread)
      await vi.waitFor(() => expect(stopped).toBe(true))
      expect(deleteThread).not.toHaveBeenCalled()
      release()
      await expect(deletion).resolves.toMatchObject({ state: "deleted", deletedThreadId: work.threadId })
      expect(deleteThread).toHaveBeenCalledTimes(1)
    } finally {
      release()
    }
  })

  it("keeps the original claim when an existing conversation's physical deletion fails, then retries only that phase", async () => {
    const x = fixture()
    const work = await linkExistingConversation(x.host, x.input)
    const other = await x.host.createWork({ botId: work.botId, operationId: "other", title: "Other", goal: "Keep files" })
    const attachment = {
      filename: "input.txt", filePath: "/retained/input.txt", content: "Retained content",
      mimeType: "text/plain", size: 16, truncated: false
    }
    const retain = (workId?: string) =>
      x.host.retainInputFile(work.botId, attachment, attachment.filePath, workId).botInputId!
    const input = retain(work.id), mainInput = retain(), otherInput = retain(other.work.id)
    const getInput = () => x.store.inputFiles(work.botId, [input])[0]
    const target = captureBotWorkDeletionTarget(x.host, work.botId, work.id, work.version)
    let checkAfterCallback!: () => boolean
    let releaseCheck!: () => void
    let lateCheck!: Promise<boolean>
    const deleteThread = vi.fn(async (id: string) => {
      const row = f.rows.get(id)!
      const metadata = JSON.parse(row.metadata!)
      expect(assertScopedBotWorkThreadDeletion(id, row, metadata)).toBe(true)
      expect(metadata).toEqual(x.original)
      expect(x.host.conversationLinks.forThread(id)?.conversation?.state).toBe("detached")
      checkAfterCallback = () => assertScopedBotWorkThreadDeletion(id, row, metadata)
      lateCheck = new Promise<void>(resolve => { releaseCheck = resolve }).then(checkAfterCallback)
      throw new Error("physical deletion failed")
    })
    await expect(removeBotWork(x.host, target, deleteThread)).rejects.toThrow("physical deletion failed")
    expect(x.removeWorkBrowser).toHaveBeenCalledExactlyOnceWith(botWorkBrowserScope(work.id, work.botId))
    expect(checkAfterCallback()).toBe(false)
    const expired = expect(lateCheck).rejects.toThrow("删除授权已结束")
    releaseCheck()
    await expired
    expect(x.host.workDeletionRecord(work.botId, work.id)?.phase).toBe("ready")
    expect(x.host.conversationLinks.forThread(work.threadId)?.id).toBe(work.id)
    expect(getInput().attachment?.content).toBe(attachment.content)
    await expect(linkExistingConversation(x.host, { ...x.input, operationId: "replacement" })).rejects.toThrow()
    await expect(exposeWorkConversation(x.host, work.botId, work.id)).rejects.toThrow("删除")

    const advance = vi.spyOn(x.store, "advanceWorkDeletion").mockImplementationOnce(() => { throw new Error("bookkeeping failed") })
    const resumed = vi.fn(async (id: string) => {
      const row = f.rows.get(id)!
      expect(assertScopedBotWorkThreadDeletion(id, row, JSON.parse(row.metadata!))).toBe(true)
      f.rows.delete(id)
    })
    await expect(removeBotWork(x.host, target, resumed)).resolves.toMatchObject({
      state: "cleanup_pending", deletedThreadId: work.threadId
    })
    expect(getInput().attachment?.content).toBe(attachment.content)
    expect(x.removeWorkBrowser).toHaveBeenCalledTimes(1)
    advance.mockRestore()
    await expect(removeBotWork(x.host, target, resumed)).resolves.toMatchObject({
      state: "deleted", deletedThreadId: work.threadId
    })
    expect(resumed).toHaveBeenCalledTimes(1)
    expect(x.host.conversationLinks.forThread(work.threadId)).toBeNull()
    expect(getInput).toThrow("原附件已不可用")
    expect(x.store.inputFiles(work.botId, [mainInput, otherInput]).map(file => file.id))
      .toEqual([mainInput, otherInput])
  })

  it("parks desktop drafts once, recovers original model operation IDs and fences cancellation before the journal write", async () => {
    const x = fixture(true)
    const requests: BotConversationTransitionRequest[] = []
    const window = Object.assign(new EventEmitter(), {
      id: 47,
      isDestroyed: () => false,
      send: (channel: string, request: BotConversationTransitionRequest) => {
        expect(channel).toBe("bots:conversation:transition")
        requests.push(request)
      }
    }) as unknown as WebContents
    listenBotConversationTransitions(window, true)
    try {
      const current = x.host.send({ botId: x.bot.id, requestId: "current", message: "Link the original conversation" })
      await vi.waitFor(() => expect(x.host.workToolSource(current.id).id).toBe(current.id))
      const signal = new AbortController().signal
      const linkSource = { taskId: current.id, callId: "link-call", key: "link-operation" }
      const { conversation, title, goal } = x.input
      const input = { conversation, title, goal }

      const originalRun = claimLocalThreadRunLease({ threadId: "original", owner: "desktop", runId: "ordinary-run" })
      expect(originalRun.acquired).toBe(true)
      try {
        await expect(x.host.linkOrdinaryThreadFromTool(linkSource, input, signal)).rejects.toThrow("会话执行")
        expect(getLocalThreadRunLease("original")?.runId).toBe("ordinary-run")
      } finally {
        releaseLocalThreadRunLease("original", "desktop", "ordinary-run")
      }
      f.approval = true
      await expect(x.host.linkOrdinaryThreadFromTool(linkSource, input, signal)).rejects.toThrow("审批")
      f.approval = false
      f.validateWorkspace.mockRejectedValueOnce(new Error("原目录无效"))
      await expect(x.host.linkOrdinaryThreadFromTool(linkSource, input, signal)).rejects.toThrow("原目录无效")
      expect(requests).toHaveLength(0)
      expect(x.store.conversations.forThread("original")).toBeNull()
      expect(f.update).not.toHaveBeenCalled()

      const linked = x.host.linkOrdinaryThreadFromTool(linkSource, input, signal)
      await vi.waitFor(() => expect(requests).toEqual([expect.objectContaining({
        action: "link", threadId: "original", incarnation: input.conversation.incarnation
      })]))
      expect(x.store.conversations.forThread("original")).toBeNull()
      await finishBotConversationTransition(window.id, requests[0].id)
      const bound = await linked
      expect(bound).toEqual({ workId: expect.any(String), version: expect.any(Number), conversation, state: "bound" })
      expect(x.store.recentTasks()).toHaveLength(1)
      f.busy = true
      await expect(x.host.linkOrdinaryThreadFromTool({ ...linkSource, callId: "retry-link" }, input, signal)).resolves.toEqual(bound)
      await expect(x.host.linkOrdinaryThreadFromTool(linkSource, { ...input, goal: "Changed" }, signal)).rejects.toThrow("其他内容")
      expect(requests).toHaveLength(1)
      f.busy = false

      const unlinkSource = { taskId: current.id, callId: "unlink-call", key: "unlink-operation" }
      const unlinkInput = { workId: bound.workId, expectedVersion: bound.version }
      await expect(x.host.unlinkWorkFromTool(linkSource, unlinkInput, signal)).rejects.toThrow("其他内容")
      f.update.mockImplementationOnce(() => { throw new Error("detach interrupted") })
      const interrupted = expect(x.host.unlinkWorkFromTool(unlinkSource, unlinkInput, signal)).rejects.toThrow("detach interrupted")
      expect(requests[1]).toMatchObject({ action: "unlink", threadId: "original", link: { work: { id: bound.workId } } })
      await expect(finishBotConversationTransition(window.id, requests[1].id)).rejects.toThrow("detach interrupted")
      await interrupted
      expect(x.store.conversations.forThread("original")?.conversation?.state).toBe("detaching")
      const unlinked = x.host.unlinkWorkFromTool({ ...unlinkSource, callId: "resume-unlink" }, unlinkInput, signal)
      await finishBotConversationTransition(window.id, requests[2].id)
      const detached = await unlinked
      expect(detached).toEqual({ ...bound, state: "detached", version: bound.version + 2 })
      expect(JSON.parse(f.rows.get("original")!.metadata!)).toEqual(x.original)
      await expect(x.host.linkOrdinaryThreadFromTool(linkSource, input, signal)).rejects.toThrow("旧操作")

      const newer = await linkExistingConversation(x.host, { ...x.input, operationId: "new-binding" })
      await expect(x.host.unlinkWorkFromTool({ ...unlinkSource, callId: "retry-unlink" }, unlinkInput, signal)).resolves.toEqual(detached)
      await expect(x.host.unlinkWorkFromTool(unlinkSource, { workId: newer.id, expectedVersion: newer.version }, signal)).rejects.toThrow("其他内容")
      expect(x.store.conversations.forThread("original")?.id).toBe(newer.id)
      expect(requests).toHaveLength(3)

      const cancel = x.host.unlinkWorkFromTool(
        { taskId: current.id, callId: "cancelled", key: "cancelled" },
        { workId: newer.id, expectedVersion: newer.version },
        signal
      )
      const cancellation = expect(cancel).rejects.toThrow("当前执行已停止")
      let finishValidation!: (value: boolean) => void
      x.pending.mockImplementationOnce(() => new Promise(resolve => { finishValidation = resolve }))
      const acknowledgement = finishBotConversationTransition(window.id, requests[3].id)
      await vi.waitFor(() => expect(finishValidation).toBeTypeOf("function"))
      x.host.cancel(current.id)
      finishValidation(false)
      await expect(acknowledgement).rejects.toThrow("当前执行已停止")
      await cancellation
      expect(x.store.conversations.forThread("original")?.id).toBe(newer.id)
    } finally {
      listenBotConversationTransitions(window, false)
    }
  })

  it.each([false, true])(
    "recovers a prepared association through the actual right-panel expose IPC (metadata written=%s)",
    async (written) => {
      const x = fixture()
      f.update.mockImplementationOnce((id: string, patch: Partial<ThreadSummaryRow>) => {
        if (written) f.rows.set(id, { ...f.rows.get(id)!, ...patch })
        throw new Error("binding interrupted")
      })
      await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("binding interrupted")
      const work = x.store.conversations.forThread("original")!
      expect(work.conversation?.state).toBe("preparing")
      const handlers = new Map<string, (...args: unknown[]) => unknown>()
      registerBotHandlers({
        handle: (name: string, handler: (...args: unknown[]) => unknown) =>
          handlers.set(name, handler)
      } as unknown as IpcMain)
      const frame = {},
        event = { senderFrame: frame, sender: { mainFrame: frame } }
      const recovered = (await handlers.get("bots:conversation:expose")!(
        event,
        "local",
        x.bot.id,
        work.id
      )) as typeof work
      expect(recovered.conversation?.state).toBe("bound")
      expect(recovered.threadId).toBe("original")
      expect(f.prepare).not.toHaveBeenCalled()
      expect(x.store.recentTasks()).toHaveLength(0)
      expect(JSON.parse(f.rows.get("original")!.metadata!)).toMatchObject(x.original)
    }
  )

  it("rejects deletion before mutating a linked Team with pending work, then preserves its original conversation", async () => {
    const x = fixture()
    const admitted = await linkExistingConversation(x.host, x.input)
    // Model an already-persisted Team association from before the admission gate.
    x.original.agentMode = "coordinator"
    const saved = f.rows.get("original")!
    f.rows.set("original", { ...saved, metadata: JSON.stringify({ ...JSON.parse(saved.metadata!), agentMode: "coordinator" }) })
    x.pending.mockResolvedValue(true)
    x.coordinatorPending.mockImplementation(threads => threads.includes("original"))
    const group = x.store.saveGroup({ name: "Keep membership", memberIds: [x.bot.id] })
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const removeThread = vi.fn(async (_event: unknown, _id: string) => {})
    registerBotHandlers({ handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } as unknown as IpcMain, removeThread)
    await expect(Promise.resolve().then(() => handlers.get("bots:remove")!({}, "local", x.bot.id, x.bot.version))).rejects.toThrow("后台执行")
    expect(x.store.getBot(x.bot.id)).toMatchObject({ archived: false, deleting: false, version: x.bot.version })
    expect(x.store.getGroup(group.id).memberIds).toEqual([x.bot.id])
    expect(x.store.conversations.record(admitted.id)?.state).toBe("bound")
    expect(x.host.getWork(x.bot.id, admitted.id).id).toBe(admitted.id)
    expect(removeThread).not.toHaveBeenCalled()
    x.pending.mockResolvedValue(false)
    x.coordinatorPending.mockReturnValue(false)
    await handlers.get("bots:remove")!({}, "local", x.bot.id, x.bot.version)
    expect(x.store.listBots()).toHaveLength(0)
    expect(removeThread.mock.calls.map(call => call[1])).not.toContain("original")
    expect(JSON.parse(f.rows.get("original")!.metadata!)).toEqual(x.original)
  })

  it("recovers an old deletion fence by preserving completed Team results for the original conversation", async () => {
    const x = fixture()
    const admitted = await linkExistingConversation(x.host, x.input)
    // Model an already-persisted Team association from before the admission gate.
    x.original.agentMode = "coordinator"
    const saved = f.rows.get("original")!
    f.rows.set("original", { ...saved, metadata: JSON.stringify({ ...JSON.parse(saved.metadata!), agentMode: "coordinator" }) })
    x.pending.mockResolvedValue(true)
    // Ordinary unlink must still require consumption of the pending result.
    await expect(unlinkWorkConversation(x.host, x.bot.id, admitted.id, admitted.version)).rejects.toThrow("后台执行")
    // This is the persisted state produced by the predecessor's deletion path.
    x.store.beginDeletion(x.bot.id, x.bot.version)
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const removeThread = vi.fn(async (_event: unknown, _id: string) => {})
    registerBotHandlers({ handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } as unknown as IpcMain, removeThread)
    // Live work/persistence still prevents cleanup even on a deletion retry.
    await expect(handlers.get("bots:remove")!({}, "local", x.bot.id, x.bot.version)).rejects.toThrow("后台执行")
    expect(f.check).not.toHaveBeenCalled()
    expect(x.store.conversations.record(admitted.id)?.state).toBe("bound")
    const pendingResult = "completed worker result"
    x.pending.mockImplementation(async (_threads, options) => !options?.allowPendingCoordinatorNotifications && !!pendingResult)
    f.check.mockImplementation((id: string) => {
      expect(id).toBe("original")
      expect(JSON.parse(f.rows.get(id)!.metadata!)).toEqual(x.original)
      expect(x.store.conversations.forThread(id)).toBeNull()
      expect(pendingResult).toBe("completed worker result")
    })
    await handlers.get("bots:remove")!({}, "local", x.bot.id, x.bot.version)
    expect(f.check).toHaveBeenCalledWith("original")
    const botOwner = vi.fn(() => x.host)
    const dispatch = createBotNotificationDispatcher(id => f.rows.get(id), botOwner)
    expect(await dispatch({ threadId: "original", kind: "coordinator", key: "completed-result" })).toBe(false)
    expect(botOwner).not.toHaveBeenCalled()
    expect(pendingResult).toBe("completed worker result")
    expect(x.store.listBots()).toHaveLength(0)
    expect(removeThread.mock.calls.map(call => call[1])).not.toContain("original")
    expect(JSON.parse(f.rows.get("original")!.metadata!)).toEqual(x.original)
  })

  it("deletes through real IPC/Host coordination, preserves admitted conversations, removes created ones and retries failed cleanup", async () => {
    const x = fixture(),
      admitted = await linkExistingConversation(x.host, x.input)
    const created = x.store.createWork({
      botId: x.bot.id,
      operationId: "created",
      title: "Created task",
      goal: "Task"
    })
    const metadata = {
      ...x.original,
      botId: x.bot.id,
      botHostId: "local",
      botWorkId: created.work.id,
      botAudienceKey: "desktop"
    }
    f.rows.set(created.work.threadId, {
      ...x.row,
      thread_id: created.work.threadId,
      metadata: JSON.stringify(metadata)
    })
    await exposeWorkConversation(x.host, x.bot.id, created.work.id)
    const handlers = new Map<string, (...args: unknown[]) => unknown>(),
      removed: string[] = []
    let refused = true
    registerBotHandlers(
      {
        handle: (name: string, handler: (...args: unknown[]) => unknown) =>
          handlers.set(name, handler)
      } as unknown as IpcMain,
      async (_event, id) => {
        if (id === created.work.threadId && refused) {
          refused = false
          throw new Error("created cleanup interrupted")
        }
        removed.push(id)
        f.rows.delete(id)
      }
    )
    await expect(
      handlers.get("bots:remove")!({}, "local", x.bot.id, x.bot.version)
    ).rejects.toThrow("cleanup interrupted")
    expect(() => x.host.getWork(x.bot.id, admitted.id)).toThrow("删除")
    expect(f.rows.has("original")).toBe(true)
    expect(JSON.parse(f.rows.get("original")!.metadata!)).toEqual(x.original)
    expect(removed).not.toContain("original")
    await handlers.get("bots:remove")!({}, "local", x.bot.id, x.bot.version)
    expect(removed).toContain(created.work.threadId)
    expect(f.rows.has(created.work.threadId)).toBe(false)
    expect(f.rows.has("original")).toBe(true)
    expect(x.store.listBots()).toHaveLength(0)
  })

  it("preserves identity/settings without execution, uses one thread, and unlink never resurrects an old command", async () => {
    const x = fixture(),
      work = await linkExistingConversation(x.host, x.input)
    const row = f.rows.get("original")!,
      metadata = JSON.parse(row.metadata!)
    expect(metadata).toMatchObject(x.original)
    expect(metadata.botWorkId).toBe(work.id)
    expect(x.store.recentTasks()).toHaveLength(0)
    expect((await linkExistingConversation(x.host, x.input)).id).toBe(work.id)
    expect((await resolveWorkConversation(x.host, "original"))?.workspacePath).toBe(
      "/original/workspace"
    )
    expect(() => assertWorkConversationEntry("original", row, metadata)).toThrow("任务会话发送")
    const task = x.host.send({
      botId: x.bot.id,
      workId: work.id,
      requestId: "same-request",
      message: "Modify"
    })
    expect(task.threadId).toBe("original")
    expect(() =>
      assertWorkConversationEntry("original", row, metadata, {
        source: "bot",
        localRunLease: { owner: "bot", runId: task.id }
      })
    ).toThrow()
    claimLocalThreadRunLease({ threadId: "original", owner: "bot", runId: task.id })
    expect(() =>
      assertWorkConversationEntry("original", row, metadata, {
        source: "bot",
        localRunLease: { owner: "bot", runId: task.id }
      })
    ).not.toThrow()
    releaseLocalThreadRunLease("original", "bot", task.id)
    x.host.cancel(task.id)
    const current = x.host.getWork(x.bot.id, work.id)
    await unlinkWorkConversation(x.host, x.bot.id, work.id, current.version)
    const browserScope = botWorkBrowserScope(work.id, x.bot.id)
    expect(x.removeWorkBrowser).not.toHaveBeenCalled()
    expect(x.host.browserScope(browserScope)).toBe(browserScope)
    expect(JSON.parse(f.rows.get("original")!.metadata!)).toEqual(x.original)
    expect(await resolveWorkConversation(x.host, "original")).toBeNull()
    expect(x.store.notificationThreadIds()).not.toContain("original")
    await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("旧操作")
    expect(x.store.listWorks(x.bot.id).items).toHaveLength(0)
    expect(x.store.beginDeletion(x.bot.id, x.bot.version)).not.toContain("original")
  })
  it("recovers prepared/bound cross-database failure and an interrupted unlink without a second task", async () => {
    const x = fixture()
    f.update.mockImplementationOnce((id: string, patch: Partial<ThreadSummaryRow>) => {
      f.rows.set(id, { ...f.rows.get(id)!, ...patch })
      x.db.run("PRAGMA query_only=ON")
    })
    await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow()
    expect(x.store.conversations.forThread("original")?.conversation?.state).toBe("preparing")
    expect(() =>
      assertWorkConversationEntry(
        "original",
        f.rows.get("original"),
        JSON.parse(f.rows.get("original")!.metadata!)
      )
    ).toThrow("关联或解除")
    x.db.run("PRAGMA query_only=OFF")
    x.pending.mockResolvedValueOnce(true)
    await expect(resolveWorkConversation(x.host, "original")).rejects.toThrow("后台")
    expect(x.store.conversations.forThread("original")?.conversation?.state).toBe("preparing")
    const recovered = await resolveWorkConversation(x.host, "original")
    expect(recovered?.work.conversation?.state).toBe("bound")
    const work = recovered!.work
    f.update.mockImplementationOnce(() => {
      throw new Error("message-db write refused")
    })
    await expect(unlinkWorkConversation(x.host, x.bot.id, work.id, work.version)).rejects.toThrow(
      "write refused"
    )
    expect(x.store.conversations.forThread("original")?.conversation?.state).toBe("detaching")
    expect(await resolveWorkConversation(x.host, "original")).toBeNull()
    expect(JSON.parse(f.rows.get("original")!.metadata!)).toEqual(x.original)
    expect(x.store.recentTasks()).toHaveLength(0)
  })
  it("rejects remote/historical, heartbeat, missing workspace, active goal and real pending work; rechecks incarnation after awaits", async () => {
    const x = fixture()
    for (const extra of [
      { remoteState: "historical" },
      { remoteReadOnly: true },
      { imDeliveryContext: {} },
      { harnessProjectSession: {} },
      { isHeartbeat: true },
      { workspacePath: null }
    ]) {
      f.rows.set("original", { ...x.row, metadata: JSON.stringify({ ...x.original, ...extra }) })
      await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow()
    }
    f.rows.set("original", x.row)
    f.approval = true
    await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("审批")
    f.approval = false
    f.goal = true
    await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("Goal")
    f.goal = false
    x.pending.mockResolvedValueOnce(true)
    await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("后台")
    x.pending.mockImplementationOnce(async () => {
      f.rows.set("original", {
        ...x.row,
        metadata: JSON.stringify({ ...x.original, cmb_thread_incarnation: "replacement-token" })
      })
      return false
    })
    await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("检查期间已变化")
    expect(x.store.listWorks(x.bot.id).items).toHaveLength(0)
  })
  it("validates the real directory before new and preparing associations, while a bound conversation remains readable and detachable", async () => {
    const x = fixture()
    const workspacePath = await mkdtemp(join(tmpdir(), "bot-link-workspace-"))
    try {
      const row = { ...x.row, metadata: JSON.stringify({ ...x.original, workspacePath }) }
      f.rows.set("original", row)
      await rm(workspacePath, { recursive: true })
      await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("不存在或不可访问")
      expect(f.update).not.toHaveBeenCalled()
      expect(x.store.conversations.forThread("original")).toBeNull()

      await mkdir(workspacePath)
      f.update.mockImplementationOnce(() => { throw new Error("binding interrupted") })
      await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("binding interrupted")
      const preparing = x.store.conversations.forThread("original")!
      expect(preparing.conversation?.state).toBe("preparing")
      await rm(workspacePath, { recursive: true })
      f.update.mockClear()
      await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("不存在或不可访问")
      await expect(exposeWorkConversation(x.host, x.bot.id, preparing.id)).rejects.toThrow("不存在或不可访问")
      expect(x.store.conversations.record(preparing.id)?.state).toBe("preparing")
      expect(f.update).not.toHaveBeenCalled()

      await mkdir(workspacePath)
      const bound = await exposeWorkConversation(x.host, x.bot.id, preparing.id)
      expect(bound.conversation?.state).toBe("bound")
      expect(JSON.parse(f.rows.get("original")!.metadata!).workspacePath).toBe(workspacePath)
      await rm(workspacePath, { recursive: true })
      f.validateWorkspace.mockClear()
      await expect(exposeWorkConversation(x.host, x.bot.id, bound.id)).resolves.toMatchObject({ id: bound.id })
      await unlinkWorkConversation(x.host, x.bot.id, bound.id, bound.version)
      expect(f.validateWorkspace).not.toHaveBeenCalled()
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
  it("opens an initialized native task after its project moves without creating replacement history or executing it", async () => {
    const x = fixture()
    const directory = await mkdtemp(join(tmpdir(), "bot-native-history-"))
    await mkdir(join(directory, "project"))
    const workspacePath = await f.validateWorkspace(join(directory, "project"))
    try {
      const { work } = x.store.createWork({
        botId: x.bot.id, operationId: "native-history", title: "Original result", goal: "Read project",
        workspace: { kind: "directory", path: workspacePath }
      }, undefined, { kind: "directory", path: workspacePath })
      const metadata = {
        ...x.original, workspacePath,
        botId: x.bot.id, botHostId: "local", botWorkId: work.id, botAudienceKey: "desktop"
      }
      const original = { ...x.row, thread_id: work.threadId, metadata: JSON.stringify(metadata) }
      f.rows.set(work.threadId, original)
      await rename(workspacePath, join(directory, "moved"))
      const tasks = x.store.recentTasks().map(task => task.id)
      f.validateWorkspace.mockClear()

      // Even when reading history, a changed ownership/path cannot be rebound.
      f.rows.set(work.threadId, { ...original, metadata: JSON.stringify({ ...metadata, workspacePath: directory }) })
      await expect(exposeWorkConversation(x.host, x.bot.id, work.id)).rejects.toThrow(/身份已变化|身份不一致/)
      expect(x.store.getWork(x.bot.id, work.id).conversation).toBeUndefined()
      f.rows.set(work.threadId, original)
      const opened = await exposeWorkConversation(x.host, x.bot.id, work.id)
      expect(opened).toMatchObject({ id: work.id, threadId: work.threadId, conversation: {
        state: "bound", origin: "created", ref: { incarnation: captureThreadIncarnation(original) }
      } })
      expect(JSON.parse(f.rows.get(work.threadId)!.metadata!).workspacePath).toBe(workspacePath)
      expect(x.store.recentTasks().map(task => task.id)).toEqual(tasks)
      expect(f.validateWorkspace).not.toHaveBeenCalled()
      // The real execution/new-association directory gate still rejects this path.
      await expect(f.validateWorkspace(workspacePath)).rejects.toThrow("不存在或不可访问")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it("checks the current directory and source again after awaiting validation", async () => {
    const x = fixture()
    f.validateWorkspace.mockImplementationOnce(async (path) => {
      f.rows.set("original", { ...x.row, metadata: JSON.stringify({ ...x.original, workspacePath: "/changed" }) })
      return String(path)
    })
    await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("目录在检查期间已变化")
    f.rows.set("original", x.row)

    let cancelled = false
    f.validateWorkspace.mockImplementationOnce(async (path) => {
      cancelled = true
      return String(path)
    })
    await expect(linkExistingConversation(x.host, x.input, () => {
      if (cancelled) throw new Error("原请求已取消")
    })).rejects.toThrow("原请求已取消")
    expect(f.update).not.toHaveBeenCalled()
    expect(x.store.conversations.forThread("original")).toBeNull()
  })
  it("exposes the original desktop work thread with the current Bot model and keeps later task choices", async () => {
    const x = fixture(),
      receipt = x.store.createWork({
        botId: x.bot.id,
        operationId: "create",
        title: "New task",
        goal: "Do work"
      })
    const metadata = {
      ...x.original,
      botId: x.bot.id,
      botHostId: "local",
      botWorkId: receipt.work.id,
      botAudienceKey: "desktop"
    }
    f.rows.set(receipt.work.threadId, {
      ...x.row,
      thread_id: receipt.work.threadId,
      metadata: JSON.stringify(metadata)
    })
    const work = await exposeWorkConversation(x.host, x.bot.id, receipt.work.id)
    expect(work.conversation?.origin).toBe("created")
    expect(JSON.parse(f.rows.get(receipt.work.threadId)!.metadata!)).toMatchObject({
      ...x.original, model: x.bot.modelRef
    })
    expect(JSON.parse(f.rows.get(receipt.work.threadId)!.metadata!).botWorkModelRoutingMode).toBe("pinned")
    // Opening again must not erase a choice made in the original conversation UI.
    const row = f.rows.get(receipt.work.threadId)!
    f.rows.set(row.thread_id, { ...row, metadata: JSON.stringify({
      ...JSON.parse(row.metadata!), model: "custom:user-choice", botWorkModelRoutingMode: "default"
    }) })
    f.update.mockClear()
    await exposeWorkConversation(x.host, x.bot.id, work.id)
    expect(f.update).not.toHaveBeenCalled()
    expect(JSON.parse(f.rows.get(work.threadId)!.metadata!)).toMatchObject({
      model: "custom:user-choice", botWorkModelRoutingMode: "default"
    })
    // A pre-upgrade bound work may have a hand-selected model with no routing marker.
    // Reopening must not reinterpret that saved choice as the parent's current default.
    const legacyMetadata = JSON.parse(f.rows.get(work.threadId)!.metadata!)
    delete legacyMetadata.botWorkModelRoutingMode
    f.rows.set(row.thread_id, { ...row, metadata: JSON.stringify(legacyMetadata) })
    f.update.mockClear()
    await exposeWorkConversation(x.host, x.bot.id, work.id)
    expect(f.update).not.toHaveBeenCalled()
    expect(JSON.parse(f.rows.get(work.threadId)!.metadata!)).toEqual(legacyMetadata)
    expect(x.store.recentTasks()).toHaveLength(1)
    expect((await resolveWorkConversation(x.host, receipt.work.threadId))?.work.id).toBe(work.id)
  })
  it.each([false, true])("never aliases a new pin on first sidebar open, even after the configured ID is deleted (alias fallback=%s)", async (legacyAlias) => {
    const x = fixture()
    const { work } = x.store.createWork({ botId: x.bot.id, operationId: "sidebar",
      title: "Sidebar task", goal: "Do work" })
    f.rows.set(work.threadId, { ...x.row, thread_id: work.threadId, metadata: JSON.stringify({
      ...x.original, model: "custom:previous-turn", botHostId: "local", botId: x.bot.id,
      botWorkId: work.id, botAudienceKey: "desktop"
    }) })
    if (legacyAlias) f.normalizeModel.mockReturnValue("custom:canonical-provider-id")
    const resolved = await resolveWorkConversation(x.host, work.threadId)
    expect(resolved?.work.id).toBe(work.id)
    expect(JSON.parse(f.rows.get(work.threadId)!.metadata!)).toMatchObject({
      model: x.bot.modelRef, botWorkModelRoutingMode: "pinned"
    })
    expect(f.normalizeModel).not.toHaveBeenCalled()
  })
})
it("pauses a due desktop work routine after the original conversation is unlinked", async () => {
  const x = fixture()
  const linked = await linkExistingConversation(x.host, x.input)
  const config = { name: "Update", message: "Update the report", frequency: "daily" as const,
    runAtTime: "09:00", enabled: true }
  const schedule = x.store.saveSchedule(x.bot.id, config, "2030-01-01T09:00:00Z",
    undefined, undefined, { workId: linked.id, operationId: "linked-routine" })
  await unlinkWorkConversation(x.host, x.bot.id, linked.id, linked.version)
  x.store.fireSchedule(schedule, "2030-01-02T09:00:00Z")
  expect(x.store.schedules()[0]).toMatchObject({ id: schedule.id, workId: linked.id,
    enabled: false, nextRunAt: null, workUnavailable: true })
  expect(x.store.recentTasks()).toHaveLength(0)
})

it("opens detached historical results without rebinding or creating tasks, and rejects reused or missing threads", async () => {
  const x = fixture()
  const linked = await linkExistingConversation(x.host, x.input)
  await unlinkWorkConversation(x.host, x.bot.id, linked.id, linked.version)
  const before = x.store.getWork(x.bot.id, linked.id)
  f.update.mockClear()
  const opened = await exposeWorkConversation(x.host, x.bot.id, linked.id)
  expect(opened).toEqual({ ...before, execution: expect.objectContaining({ businessState: "completed", phase: "unavailable" }) })
  expect(opened.conversation?.state).toBe("detached")
  expect(x.host.workSummaries(x.bot.id, [linked.id])[0].deletionCommitted).toBeUndefined()
  expect(f.update).not.toHaveBeenCalled()
  expect(x.store.recentTasks()).toHaveLength(0)
  const row = f.rows.get(opened.threadId)!
  f.rows.set(opened.threadId, {
    ...row,
    metadata: JSON.stringify({ ...x.original, cmb_thread_incarnation: "replacement" })
  })
  await expect(exposeWorkConversation(x.host, x.bot.id, linked.id)).rejects.toThrow(
    "原会话身份已变化"
  )
  f.rows.delete(opened.threadId)
  await expect(exposeWorkConversation(x.host, x.bot.id, linked.id)).rejects.toThrow("原消息不存在")
})

it.each([{ agentMode: "coordinator" }, { coordinatorMode: true }, { coordinatorMode: "on" }])(
  "rejects new Team association without writing metadata or work: %j", async (mode) => {
    const x = fixture()
    const original = { ...x.original, agentMode: undefined, ...mode }
    const row = { ...x.row, metadata: JSON.stringify(original) }
    f.rows.set("original", row)
    await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("不支持 Team")
    expect(f.update).not.toHaveBeenCalled()
    expect(f.rows.get("original")).toEqual(row)
    expect(x.store.listWorks(x.bot.id).items).toHaveLength(0)
    expect(x.store.recentTasks()).toHaveLength(0)
  }
)
it("rechecks mode after admission awaits and rejects Team without creating an association", async () => {
  const x = fixture()
  x.pending.mockImplementationOnce(async () => {
    f.rows.set("original", { ...x.row, metadata: JSON.stringify({ ...x.original, agentMode: "coordinator" }) })
    return false
  })
  await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("不支持 Team")
  expect(f.update).not.toHaveBeenCalled()
  expect(x.store.listWorks(x.bot.id).items).toHaveLength(0)
})
it("rejects a Workflow association and keeps an already bound Workflow openable and detachable", async () => {
  const x = fixture()
  const workflowMetadata = { ...x.original, agentMode: "workflow" }
  f.rows.set("original", { ...x.row, metadata: JSON.stringify(workflowMetadata) })
  await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("Workflow")
  expect(f.update).not.toHaveBeenCalled()
  expect(x.store.conversations.forThread("original")).toBeNull()

  f.rows.set("original", x.row)
  const linked = await linkExistingConversation(x.host, x.input)
  const saved = f.rows.get("original")!
  f.rows.set("original", { ...saved, metadata: JSON.stringify({ ...JSON.parse(saved.metadata!), agentMode: "workflow" }) })
  expect((await exposeWorkConversation(x.host, x.bot.id, linked.id)).id).toBe(linked.id)
  const detached = await unlinkWorkConversation(x.host, x.bot.id, linked.id, linked.version)
  expect(JSON.parse(f.rows.get("original")!.metadata!)).toEqual(workflowMetadata)
  expect((await exposeWorkConversation(x.host, x.bot.id, detached.id)).conversation?.state).toBe("detached")
  expect(x.store.recentTasks()).toHaveLength(0)
})
it("checks the active Zhaohu grant at link commit and allows association after revocation", async () => {
  const x = fixture()
  x.pending.mockImplementationOnce(async () => {
    f.threadGrant.mockReturnValue({ state: "active" })
    return false
  })
  await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("已接入招乎")
  expect(f.threadGrant).toHaveBeenCalledWith("original")
  expect(f.update).not.toHaveBeenCalled()
  expect(x.store.conversations.forThread("original")).toBeNull()

  f.threadGrant.mockReturnValue({ state: "revoked" })
  const linked = await linkExistingConversation(x.host, x.input)
  expect(linked.conversation?.state).toBe("bound")
  // Legacy coexistence must not disable history or trap the user in a link.
  f.threadGrant.mockReturnValue({ state: "active" })
  expect((await exposeWorkConversation(x.host, x.bot.id, linked.id)).id).toBe(linked.id)
  expect((await unlinkWorkConversation(x.host, x.bot.id, linked.id, linked.version)).conversation?.state).toBe("detached")
})
it("does not finalize a preparing association after an active Zhaohu grant appears", async () => {
  const x = fixture()
  f.update.mockImplementationOnce(() => { throw new Error("interrupted") })
  await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("interrupted")
  const work = x.store.conversations.forThread("original")!
  f.threadGrant.mockReturnValue({ state: "active" })
  f.update.mockClear()
  await expect(exposeWorkConversation(x.host, x.bot.id, work.id)).rejects.toThrow("已接入招乎")
  expect(f.update).not.toHaveBeenCalled()
  expect(x.store.conversations.record(work.id)?.state).toBe("preparing")
})
it("keeps an existing Team association readable and detachable without converting its mode", async () => {
  const x = fixture()
  const linked = await linkExistingConversation(x.host, x.input)
  const saved = f.rows.get("original")!
  f.rows.set("original", { ...saved, metadata: JSON.stringify({ ...JSON.parse(saved.metadata!), agentMode: "coordinator" }) })
  f.update.mockClear()
  expect(await exposeWorkConversation(x.host, x.bot.id, linked.id)).toMatchObject({ id: linked.id })
  await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("不支持 Team")
  expect(f.update).not.toHaveBeenCalled()
  await unlinkWorkConversation(x.host, x.bot.id, linked.id, linked.version)
  expect(JSON.parse(f.rows.get("original")!.metadata!)).toEqual({ ...x.original, agentMode: "coordinator" })
  expect(x.store.recentTasks()).toHaveLength(0)
})
it("does not finish a historical preparing Team association through expose", async () => {
  const x = fixture()
  f.update.mockImplementationOnce(() => { throw new Error("interrupted") })
  await expect(linkExistingConversation(x.host, x.input)).rejects.toThrow("interrupted")
  const work = x.store.conversations.forThread("original")!
  f.rows.set("original", { ...x.row, metadata: JSON.stringify({ ...x.original, agentMode: "coordinator" }) })
  f.update.mockClear()
  await expect(exposeWorkConversation(x.host, x.bot.id, work.id)).rejects.toThrow("不支持 Team")
  expect(f.update).not.toHaveBeenCalled()
  expect(x.store.conversations.record(work.id)?.state).toBe("preparing")
})


/** Real IM store/source proof with an isolated thread store; no network or user data. */
function imWorkFixture(legacy = false, specified = false) {
  const x = fixture()
  const route = x.store.imGateway.register("realm", "owner", {
    id: "external-group", botId: x.bot.id, kind: "group", label: x.bot.name,
    peerLabel: "产品协作群", version: 1, state: "active", conversationKey: "group-chat",
    createdAt: new Date().toISOString(), expiresAt: new Date().toISOString()
  })
  x.store.im.importImBinding({ id: route.id, botId: x.bot.id, kind: "group",
    label: x.bot.name, channelKey: "group-chat", version: 1 })
  x.store.im.setOnline(x.bot.id, route.id, true)
  const ingress = x.store.imGateway.receive("realm", "owner", {
    route: { bindingId: route.binding.id, botId: x.bot.id, kind: "group", label: x.bot.name, version: 1, senderId: "member" },
    event: { schemaVersion: 1, eventId: "im-request", platformMessageId: "group-message",
      principalId: "owner", conversationKey: "group-chat", conversationSeq: 1,
      message: { type: "text", text: "创建独立任务" }, occurredAt: new Date().toISOString(),
      redelivered: false, lease: { id: "test-lease", expiresAt: new Date(Date.now() + 90000).toISOString() } }
  })
  x.store.imGateway.settle(ingress.id, "active", undefined, Date.now() + 90000)
  const event = x.store.im.inject({ simulation: true, bindingId: route.id,
    eventId: ingress.id, messageId: "group-message", senderId: "member",
    text: "创建独立任务", mentionsBotIds: [x.bot.id] })
  x.store.transition(event.taskId!, "running")
  const workspacePath = specified ? "C:\\code\\业务系统" : `/fixture/bots/workspaces/mock-${route.id}`
  const receipt = x.store.createWork({ botId: x.bot.id, operationId: "group-work",
    title: "群内需求梳理", goal: "延续群内讨论" },
    { taskId: event.taskId!, callId: "create-work", key: "create-work" },
    { kind: specified ? "directory" : "default", path: workspacePath })
  x.store.settle(event.taskId!, "completed", null, "已交办")
  const source = receipt.work.source!
  const metadata = { ...x.original, workspacePath, botId: x.bot.id, botHostId: "local",
    botWorkId: receipt.work.id, botAudienceKey: source.audienceKey,
    botMockBindingId: source.bindingId, botMockGrantVersion: source.grantVersion,
    botMockConversationId: source.conversationId, ...(!legacy ? { botMockTransport: "im" } : { disableAgentsPrompt: true, allowedSkills: [], allowedExperts: [] }) }
  f.rows.set(receipt.work.threadId, { ...x.row, thread_id: receipt.work.threadId,
    metadata: JSON.stringify(metadata) })
  return { ...x, receipt, metadata, route }
}

describe("IM work in the ordinary workbench", () => {
  it.each([false, true])("opens the original IM thread with its group, workspace and model (legacy=%s)", async (legacy) => {
    const x = imWorkFixture(legacy, legacy)
    const opened = await resolveWorkConversation(x.host, x.receipt.work.threadId)
    expect(opened).toMatchObject({ bot: { id: x.bot.id },
      imConversation: { id: x.route.id, title: "产品协作群", state: "active" },
      workspacePath: x.metadata.workspacePath,
      work: { id: x.receipt.work.id, threadId: x.receipt.work.threadId,
        audienceKey: x.receipt.work.audienceKey, source: x.receipt.work.source,
        workspace: x.receipt.work.workspace, conversation: { origin: "created", state: "bound" } } })
    const upgraded = { ...x.metadata } as Record<string, unknown>
    delete upgraded.disableAgentsPrompt
    delete upgraded.allowedSkills
    delete upgraded.allowedExperts
    const savedMetadata = JSON.parse(f.rows.get(x.receipt.work.threadId)!.metadata!)
    expect(savedMetadata).toMatchObject({ ...upgraded, botMockTransport: "im", botLocalConversation: true })
    expect(savedMetadata.allowedSkills).toBeUndefined()
    expect(savedMetadata.disableAgentsPrompt).toBeUndefined()
    expect(await resolveWorkConversation(x.host, x.receipt.work.threadId)).toEqual({
      ...opened, work: { ...opened!.work, execution: { ...opened!.work.execution, observedAt: expect.any(Number) } }
    })
    expect(x.store.recentTasks()).toHaveLength(2) // opening does not execute or copy
    expect(x.host.listWorks(x.bot.id).items).toHaveLength(0) // absent from private Bot
    await expect(unlinkWorkConversation(x.host, x.bot.id, opened!.work.id, opened!.work.version))
      .rejects.toThrow("不能解除为私人会话")
    expect(() => x.store.conversations.beginDetach(x.bot.id, opened!.work.id, opened!.work.version))
      .toThrow("不能解除为私人会话")

    // Continue from the desktop workbench; still return results to the original group.
    x.store.transition(x.receipt.task.id, "running")
    x.store.settle(x.receipt.task.id, "completed", null, "第一轮结果")
    const followup = x.host.send({ botId: x.bot.id, workId: opened!.work.id,
      requestId: "workbench-followup", message: "继续完善" })
    expect(followup.threadId).toBe(opened!.work.threadId)
    expect(followup.mockSource).toEqual(opened!.work.source)
    expect(x.host.mockExecution(followup)?.source).toEqual(opened!.work.source)
    x.store.transition(followup.id, "running")
    x.store.settle(followup.id, "completed", null, "第二轮结果")
    const row = x.db.prepare("SELECT binding_id,work_id,text FROM bot_im_outbox WHERE source_task_id=?", [followup.id])
    try {
      expect(row.step()).toBe(true)
      expect(row.getAsObject()).toMatchObject({ binding_id: x.route.id, work_id: opened!.work.id, text: "第二轮结果" })
    } finally { row.free() }
  })

  it.each([
    { botMockBindingId: "other-group" }, { botAudienceKey: "desktop" },
    { botMockConversationId: "other-conversation" }, { botMockGrantVersion: 2 },
    { botMockTransport: "mock" }, { workspacePath: "/other/workspace" }, { botId: "other-bot" }
  ])("rejects mismatched identity before creating a link: %j", async (patch) => {
    const x = imWorkFixture()
    f.rows.set(x.receipt.work.threadId, { ...f.rows.get(x.receipt.work.threadId)!,
      metadata: JSON.stringify({ ...x.metadata, ...patch }) })
    await expect(resolveWorkConversation(x.host, x.receipt.work.threadId)).rejects.toThrow("身份不一致")
    expect(x.store.conversations.record(x.receipt.work.id)).toBeUndefined()
    expect(f.update).not.toHaveBeenCalled()
  })

  it("keeps revoked group history readable, follows group renames and blocks further execution", async () => {
    const x = imWorkFixture()
    await exposeWorkConversation(x.host, x.bot.id, x.receipt.work.id)
    x.store.transition(x.receipt.task.id, "running")
    x.store.settle(x.receipt.task.id, "completed", null, "旧结果")
    x.store.imGateway.register(x.route.realm, x.route.principal,
      { ...x.route.binding, peerLabel: "已改名的群", state: "revoked", version: 2 })
    x.store.im.revoke(x.bot.id, x.route.id, 1)
    const resolution = await resolveWorkConversation(x.host, x.receipt.work.threadId)
    expect(resolution?.imConversation).toEqual({ id: x.route.id, title: "已改名的群", state: "revoked" })
    expect(() => x.host.send({ botId: x.bot.id, workId: x.receipt.work.id,
      requestId: "revoked-followup", message: "不能再执行" })).toThrow()
    expect(resolution?.work.source).toEqual(x.receipt.work.source)
  })
})
