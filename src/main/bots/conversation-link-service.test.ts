import { DatabaseSync } from "node:sqlite"
import type { IpcMain } from "electron"
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
  isExternallyManagedThreadRunBusy: () => f.busy
}))
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
  assertWorkConversationEntry,
  setWorkConversationLookup
} from "./conversation-link-authority"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { captureThreadIncarnation } from "../services/thread-incarnation"
const resources: Array<{ db: NativeSqliteAdapter; host: LocalBotHost }> = []
afterEach(async () => {
  await Promise.all(resources.map((r) => r.host.stop()))
  resources.splice(0).forEach((r) => r.db.close())
  setWorkConversationLookup(undefined)
  f.rows.clear()
  f.busy = false
  f.goal = false
  f.approval = false
  f.checkpoint = null
  f.update.mockReset()
  f.check.mockReset()
})
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:")),
    store = new BotStore(db)
  const pending = vi.fn(async (_threads: readonly string[], _options?: { allowPendingCoordinatorNotifications?: boolean }) => false)
  const coordinatorPending = vi.fn((_threads: string[]) => false)
  const host = new LocalBotHost(
    store,
    { acquire: () => null, onAvailable: () => () => {}, hasPendingWork: pending, hasPendingCoordinator: coordinatorPending },
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
  return { db, store, host, bot, original, row, input, pending, coordinatorPending }
}
describe("trusted local conversation handshake", () => {
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
  it("exposes only the original desktop work thread and keeps its current settings", async () => {
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
    expect(JSON.parse(f.rows.get(receipt.work.threadId)!.metadata!)).toMatchObject(x.original)
    expect(x.store.recentTasks()).toHaveLength(1)
    expect((await resolveWorkConversation(x.host, receipt.work.threadId))?.work.id).toBe(work.id)
  })
})
it("opens detached historical results without rebinding or creating tasks, and rejects reused or missing threads", async () => {
  const x = fixture()
  const linked = await linkExistingConversation(x.host, x.input)
  await unlinkWorkConversation(x.host, x.bot.id, linked.id, linked.version)
  const before = x.store.getWork(x.bot.id, linked.id)
  f.update.mockClear()
  const opened = await exposeWorkConversation(x.host, x.bot.id, linked.id)
  expect(opened).toEqual(before)
  expect(opened.conversation?.state).toBe("detached")
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
    expect(await resolveWorkConversation(x.host, x.receipt.work.threadId)).toEqual(opened)
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
