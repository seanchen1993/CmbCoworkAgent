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
})
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:")),
    store = new BotStore(db)
  const pending = vi.fn(async () => false)
  const host = new LocalBotHost(
    store,
    { acquire: () => null, onAvailable: () => () => {}, hasPendingWork: pending },
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
    agentMode: "coordinator",
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
  return { db, store, host, bot, original, row, input, pending }
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
