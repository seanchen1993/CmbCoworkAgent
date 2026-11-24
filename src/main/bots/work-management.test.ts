import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ThreadSummaryRow } from "../db"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunLease } from "./host"
import { createBotWorkTools } from "./work-tools"
import { renameBotWorkThread } from "./work-management"
import { requireThreadMutationLease, withThreadRunMutationLock } from "../ipc/thread-run-mutation-lock"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { botHistoryHidesTitle, protectedBotHistoryTitle, setBotHistoryInputSource } from "./history-input-projection"

const native = vi.hoisted(() => ({
  rows: new Map<string, ThreadSummaryRow>(),
  update: vi.fn(),
  broadcast: vi.fn()
}))
vi.mock("../db", () => ({
  getThreadCore: (id: string) => native.rows.get(id) ?? null,
  updateThread: native.update
}))
vi.mock("../agent/renderer-stream-mirror", () => ({ broadcastToRenderers: native.broadcast }))

const resources: Array<{ db: NativeSqliteAdapter; host: LocalBotHost }> = []
afterEach(async () => {
  setBotHistoryInputSource(undefined)
  await Promise.all(resources.map(({ host }) => host.stop()))
  resources.splice(0).forEach(({ db }) => db.close())
  native.rows.clear()
  native.update.mockReset()
  native.broadcast.mockReset()
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
async function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  setBotHistoryInputSource({ works: id => store.desktopDeliveryWorks(id), inputs: (...args) => store.inputProjections(...args) })
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const refuseInput = new Map<string, () => void>()
  const host: LocalBotHost = new LocalBotHost(store, {
    renameWork: (work, commit, lease) => renameBotWorkThread(host, work, commit, lease),
    onAvailable: () => () => {},
    acquire: (_bot, task): BotRunLease => {
      let refused = false
      return {
        release() { refuseInput.delete(task.id) },
        notificationTerminal: () => refused ? { outcome: "error", code: "prompt_blocked" } : undefined,
        execute: (signal) => new Promise((resolve) => {
          refuseInput.set(task.id, () => {
            refused = true
            resolve({ state: "failed", error: "Input refused" })
          })
          signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true })
        })
      }
    }
  })
  resources.push({ db, host })
  const sourceTask = host.send({
    botId: bot.id,
    requestId: "rename",
    message: "把报告任务改名为季度报告"
  })
  const { work, task: workTask } = await host.createWork({
    botId: bot.id,
    operationId: "work",
    title: "报告",
    goal: "生成报告，保留所有文件"
  })
  await tick()
  const source = { taskId: sourceTask.id, callId: "call", key: "rename" }
  native.update.mockImplementation((id: string, updates: Partial<ThreadSummaryRow>) => {
    const old = native.rows.get(id)
    if (!old) return null
    const row = { ...old, ...updates }
    native.rows.set(id, row)
    return row
  })
  const mount = () => {
    const row: ThreadSummaryRow = {
      thread_id: work.threadId,
      created_at: 1,
      updated_at: 1,
      status: "idle",
      title: work.title,
      metadata: JSON.stringify({
        botId: bot.id,
        botWorkId: work.id,
        botHostId: "local",
        botAudienceKey: "desktop",
        title: work.title,
        workspacePath: "/project",
        model: "fixed",
        memoryEnabled: false
      })
    }
    native.rows.set(work.threadId, row)
    host.initializeWorkThread(bot.id, work.id)
    return row
  }
  const bind = () => {
    const row = mount()
    const ref = {
      kind: "local_thread" as const,
      threadId: row.thread_id,
      incarnation: captureThreadIncarnation(row)
    }
    host.conversationLinks.prepareCreated(bot.id, work.id, ref)
    host.conversationLinks.bound(bot.id, work.id, ref)
    const bound = {
      ...row,
      metadata: JSON.stringify({
        ...JSON.parse(row.metadata!), botLocalConversation: true, botWorkOrigin: "created"
      })
    }
    native.rows.set(row.thread_id, bound)
    return bound
  }
  const rename = (title = "季度报告", version = work.version, key = source.key) =>
    host.renameWorkFromTool({ ...source, callId: key, key }, work.id, version, title)
  return { db, store, bot, host, work, workTask, sourceTask, source, mount, bind, rename, refuseInput }
}

describe("Bot work rename through native metadata service", () => {
  it("restricts existing desktop-thread rename and stop while preserving personal-IM native task management", async () => {
    const f = await fixture()
    const row: ThreadSummaryRow = {
      thread_id: "ordinary-thread", created_at: 3, updated_at: 3, status: "idle", title: "原会话",
      metadata: JSON.stringify({ workspacePath: "/project" })
    }
    const ref = { kind: "local_thread" as const, threadId: row.thread_id, incarnation: captureThreadIncarnation(row) }
    const linked = f.host.conversationLinks.prepare({ botId: f.bot.id, operationId: "link-existing",
      conversation: ref, title: row.title!, goal: "保留原会话" })
    f.host.conversationLinks.bound(f.bot.id, linked.id, ref)
    native.rows.set(row.thread_id, { ...row, metadata: JSON.stringify({ workspacePath: "/project",
      botId: f.bot.id, botWorkId: linked.id, botHostId: "local", botAudienceKey: "desktop",
      botLocalConversation: true, botWorkOrigin: "existing" }) })
    const desktop = await f.host.renameWorkFromTool({ ...f.source, key: "desktop", callId: "desktop" },
      linked.id, f.host.getWork(f.bot.id, linked.id).version, "桌面改名")
    expect(native.rows.get(row.thread_id)?.title).toBe("桌面改名")

    f.host.cancel(f.sourceTask.id)
    await tick()
    const now = Date.now(), expiresAt = new Date(now + 60_000).toISOString()
    const route = f.host.registerImBinding("realm", "owner", { id: "personal", botId: f.bot.id,
      kind: "dm", label: "Personal", version: 1, state: "active", conversationKey: "channel",
      createdAt: new Date(now).toISOString(), expiresAt })
    f.host.imChannel.importImBinding({ id: route.id, botId: f.bot.id, kind: "dm", label: "Personal",
      channelKey: "channel", version: 1 })
    f.host.setImOnline(f.bot.id, route.id, true)
    const ingress = f.host.imGateway.receive("realm", "owner", {
      route: { bindingId: "personal", botId: f.bot.id, kind: "dm", label: "Personal", version: 1, senderId: "owner" },
      event: { schemaVersion: 1, eventId: "rename-event", platformMessageId: "rename-message",
        principalId: "owner", conversationKey: "channel", conversationSeq: 1,
        message: { type: "text", text: "改名为 IM 标题" }, occurredAt: new Date(now).toISOString(),
        redelivered: false, lease: { id: "lease", expiresAt } }
    })
    f.host.imGateway.settle(ingress.id, "active", undefined, now + 60_000)
    const accepted = f.host.acceptImEvent({ bindingId: route.id, eventId: ingress.id,
      messageId: "rename-message", senderId: "owner", text: "改名为 IM 标题", mentionsBotIds: [f.bot.id] })
    f.host.imGateway.settle(ingress.id, "active", accepted.taskId!)
    await vi.waitFor(() => expect(f.store.getTask(accepted.taskId!).state).toBe("running"))
    const source = { taskId: accepted.taskId!, callId: "im-existing", key: "im-existing" }
    expect(f.host.workTargets(source.taskId).items.some(work => work.id === linked.id)).toBe(true)
    await expect(f.host.renameWorkFromTool(source, linked.id, desktop.version, "IM 标题"))
      .rejects.toThrow("桌面主对话")
    expect(native.rows.get(row.thread_id)?.title).toBe("桌面改名")
    expect(f.host.getWork(f.bot.id, linked.id).version).toBe(desktop.version)
    expect(() => f.host.stopWorkFromTool({ ...source, callId: "im-stop-existing" }, linked.id, desktop.version))
      .toThrow("桌面主对话")
    expect(f.host.getWork(f.bot.id, linked.id).dispatchStopped).toBeUndefined()
    f.host.stopWork(f.bot.id, linked.id)
    const stopped = f.host.getWork(f.bot.id, linked.id)
    const fromWork = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "from-work", message: "继续普通会话" })
    f.store.injectIntoRun(fromWork.id, f.workTask.id)
    expect(() => f.store.sendWork({ taskId: fromWork.id, callId: "sibling-resume", key: "sibling-resume" },
      linked.id, "继续", stopped.version)).toThrow("桌面主对话")
    await expect(f.host.changeWorkFromTool({ ...source, callId: "im-continue-existing" }, linked.id,
      stopped.version, "continue")).rejects.toThrow("桌面主对话")
    expect(() => f.host.sendWork({ ...source, callId: "im-resume-existing" }, linked.id, "继续", stopped.version))
      .toThrow("桌面主对话")
    expect(f.host.getWork(f.bot.id, linked.id)).toMatchObject({ dispatchStopped: true, version: stopped.version })
    const nativeWork = await f.host.renameWorkFromTool({ ...source, callId: "im-native", key: "im-native" },
      f.work.id, f.host.getWork(f.bot.id, f.work.id).version, "IM 任务标题")
    expect(nativeWork.title).toBe("IM 任务标题")
    expect(f.host.stopWorkFromTool({ ...source, callId: "im-stop-native" }, nativeWork.id, nativeWork.version).stopRequested).toBe(true)
    const resumed = f.host.sendWork({ ...source, callId: "im-resume-native", key: "im-resume-native" },
      nativeWork.id, "继续这个原生 Bot 任务", f.host.getWork(f.bot.id, nativeWork.id).version)
    expect(resumed.workId).toBe(nativeWork.id)
    expect(f.host.getWork(f.bot.id, nativeWork.id).dispatchStopped).toBeUndefined()
    f.host.cancel(accepted.taskId!)
    const deskSource = f.host.send({ botId: f.bot.id, requestId: "desk-stop", message: "停止原会话" })
    await vi.waitFor(() => expect(f.store.getTask(deskSource.id).state).toBe("running"))
    const continued = await f.host.changeWorkFromTool({ taskId: deskSource.id, key: "continue", callId: "desk-continue" },
      linked.id, stopped.version, "continue")
    expect(continued.dispatchStopped).toBeUndefined()
    expect(f.host.stopWorkFromTool({ taskId: deskSource.id, key: "desk", callId: "desk" }, linked.id, continued.version)
      .stopRequested).toBe(true)
  })

  it("renames an unopened task without creating a thread, running again or changing its goal", async () => {
    const f = await fixture()
    const before = f.store.recentTasks()
    const renamed = await f.rename()
    expect(renamed).toMatchObject({
      id: f.work.id,
      threadId: f.work.threadId,
      title: "季度报告",
      goal: f.work.goal,
      state: f.work.state,
      version: f.work.version + 1
    })
    expect(f.store.recentTasks()).toEqual(before)
    expect(native.update).not.toHaveBeenCalled()
    expect((await f.rename()).version).toBe(f.work.version + 1)
  })

  it.each(["before rewrite", "after rewrite", "before refusal"] as const)("keeps an explicit title renamed %s without restoring the original goal", async (order) => {
    const f = await fixture()
    const title = "季度核查"
    f.host.recordPreparedInput(f.sourceTask.id, f.sourceTask.id, f.sourceTask.message)
    f.host.beginInputPreparation(f.workTask.id, f.workTask.id)
    if (order !== "after rewrite") await f.rename(title)

    if (order === "before refusal") {
      f.refuseInput.get(f.workTask.id)!()
      await vi.waitFor(() => expect(f.store.getTask(f.workTask.id).state).toBe("failed"))
      f.store.flushReplies()
      expect(f.store.recentTasks().find(task => task.origin.kind === "work_result")?.origin)
        .toMatchObject({ workId: f.work.id, workTitle: title })
    } else {
      f.host.recordPreparedInput(f.workTask.id, f.workTask.id, "核对允许公开的材料")
    }
    if (order === "after rewrite") {
      f.mount()
      expect(f.host.projectWorkForModel(f.work)).toMatchObject({ title: "原任务", goal: "" })
      expect(f.host.workTargets(f.sourceTask.id, undefined, f.work.title).items).toEqual([])
      await f.rename(f.work.title, f.work.version, "same-title")
      expect(f.host.projectWorkForModel(f.work).title).toBe("原任务")
      expect(botHistoryHidesTitle(f.work.threadId, native.rows.get(f.work.threadId)!)).toBe(true)
      await f.rename(title)
    }

    expect(f.host.projectWorkForModel(f.work)).toMatchObject({ title, goal: "" })
    expect(f.host.workTargets(f.sourceTask.id, undefined, f.work.title).items).toEqual([])
    expect(f.host.workTargets(f.sourceTask.id, undefined, title)).toMatchObject({
      items: [{ id: f.work.id, title }], priority: [{ id: f.work.id, title }]
    })
    const recovered = f.store.desktopOperationReceipts(f.sourceTask.id, { kind: "work_rename", targetId: f.work.id })
    expect(recovered.items).toMatchObject([
      { workId: f.work.id, title, recordedTitle: title },
      ...(order === "after rewrite" ? [{ workId: f.work.id, title, recordedTitle: "原任务" }] : [])
    ])
    expect(f.host.workPromptGoal(f.bot.id, f.work.id)).toBeUndefined()

    await f.host.stop()
    f.db.run("DELETE FROM bot_tasks WHERE id=?", [f.workTask.id])
    const reopened = new BotStore(f.db)
    expect(reopened.workPromptGoal(f.bot.id, f.work.id)).toBeUndefined()
    expect(reopened.projectWorkForModel(f.work)).toMatchObject({ title, goal: "" })
  })

  it("updates both title locations and the sidebar while preserving running work and settings", async () => {
    const f = await fixture()
    const original = f.mount()
    const before = f.store.recentTasks()
    const renamed = await f.rename()
    const nativeRow = native.rows.get(f.work.threadId)!
    expect(nativeRow.title).toBe(renamed.title)
    expect(JSON.parse(nativeRow.metadata!)).toEqual({
      ...JSON.parse(original.metadata!),
      title: renamed.title, ...protectedBotHistoryTitle(null)
    })
    expect(f.store.recentTasks()).toEqual(before)
    expect(native.broadcast).toHaveBeenCalledWith("threads:changed", undefined)
    expect((await f.rename()).version).toBe(f.work.version + 1)
    expect(native.update).toHaveBeenCalledTimes(1)
  })

  it("retries a partial native save through the same receipt and never overwrites a later rename", async () => {
    const f = await fixture()
    f.mount()
    native.update.mockImplementationOnce(() => {
      throw new Error("disk unavailable")
    })
    await expect(f.rename()).rejects.toThrow("名称同步失败")
    expect(f.host.getWork(f.bot.id, f.work.id)).toMatchObject({
      title: "季度报告",
      version: f.work.version + 1
    })
    expect(native.rows.get(f.work.threadId)!.title).toBe("报告")
    expect((await f.rename()).version).toBe(f.work.version + 1)
    expect(native.rows.get(f.work.threadId)!.title).toBe("季度报告")
    await f.rename("年报", f.work.version + 1, "later")
    await expect(f.rename()).rejects.toThrow("不会覆盖后续修改")
    expect(native.rows.get(f.work.threadId)!.title).toBe("年报")
    expect(f.host.getWork(f.bot.id, f.work.id)).toMatchObject({
      title: "年报",
      version: f.work.version + 2
    })
  })

  it("uses the original bound conversation and refuses the old entry after unlink", async () => {
    const f = await fixture()
    const row = f.bind()
    const version = f.host.getWork(f.bot.id, f.work.id).version
    await f.rename("关联报告", version)
    f.host.stopConversation(f.bot.id, undefined, f.work.id)
    await tick()
    f.host.conversationLinks.beginDetach(
      f.bot.id,
      f.work.id,
      f.host.getWork(f.bot.id, f.work.id).version
    )
    await expect(
      f.rename("不能修改", f.host.getWork(f.bot.id, f.work.id).version, "after-unlink")
    ).rejects.toThrow()
    expect(native.rows.get(row.thread_id)!.title).toBe("关联报告")
  })

  it.each(["bound", "native"])("keeps the desktop rename searchable under the same %s work and conversation", async (kind) => {
    const f = await fixture()
    const row = kind === "bound" ? f.bind() : f.mount()
    const lease = requireThreadMutationLease(row.thread_id)
    const target = f.host.getWork(f.bot.id, f.work.id)
    const tasks = f.store.recentTasks()
    const renamed = await f.host.renameWorkFromDesktop(target, "  季度核查  ", lease)
    expect(renamed).toMatchObject({ id: target.id, threadId: row.thread_id, title: "季度核查",
      goal: target.goal, version: target.version + 1 })
    expect(renamed.conversation).toEqual(target.conversation)
    expect(f.host.listWorks(f.bot.id, undefined, "季度核查").items).toMatchObject([{ id: target.id }])
    expect(f.host.listWorks(f.bot.id, undefined, "报告").items).toEqual([])
    expect(native.rows.get(row.thread_id)?.title).toBe("季度核查")
    expect(JSON.parse(native.rows.get(row.thread_id)!.metadata!)).toEqual({
      ...JSON.parse(row.metadata!), title: "季度核查", ...protectedBotHistoryTitle(null)
    })
    expect(f.store.recentTasks()).toEqual(tasks)
    await expect(f.host.renameWorkFromDesktop(target, "旧窗口标题", lease)).rejects.toThrow("任务已变化")
    expect(native.rows.get(row.thread_id)?.title).toBe("季度核查")
  })

  it("repairs a partial desktop rename on retry without advancing the work version twice", async () => {
    const f = await fixture()
    const row = f.bind()
    f.host.recordPreparedInput(f.workTask.id, f.workTask.id, "核对允许公开的材料")
    expect(botHistoryHidesTitle(row.thread_id, row)).toBe(true)
    const lease = requireThreadMutationLease(row.thread_id)
    const target = f.host.getWork(f.bot.id, f.work.id)
    native.update.mockImplementationOnce(() => { throw new Error("disk unavailable") })
    await expect(f.host.renameWorkFromDesktop(target, "新标题", lease)).rejects.toThrow("名称同步失败")
    const current = f.host.getWork(f.bot.id, f.work.id)
    expect(current).toMatchObject({ title: "新标题", version: target.version + 1 })
    expect(native.rows.get(row.thread_id)?.title).toBe(row.title)
    expect(botHistoryHidesTitle(row.thread_id, native.rows.get(row.thread_id)!)).toBe(true)
    await expect(f.host.renameWorkFromDesktop(current, "新标题", lease)).resolves.toMatchObject({ version: current.version })
    expect(native.rows.get(row.thread_id)?.title).toBe("新标题")
    expect(botHistoryHidesTitle(row.thread_id, native.rows.get(row.thread_id)!)).toBe(false)
  })

  it("refuses a replacement native row even if it carries the original work metadata", async () => {
    const f = await fixture()
    const row = f.mount()
    const lease = requireThreadMutationLease(row.thread_id)
    const target = f.host.getWork(f.bot.id, f.work.id)
    native.rows.set(row.thread_id, { ...row, created_at: row.created_at + 1 })
    await expect(f.host.renameWorkFromDesktop(target, "旧窗口标题", lease)).rejects.toThrow("Thread changed")
    expect(f.host.getWork(f.bot.id, f.work.id).title).toBe(row.title)
    expect(native.update).not.toHaveBeenCalled()
  })

  it("does not change titles after cancellation while waiting for the native mutation guard", async () => {
    const f = await fixture()
    f.mount()
    let release!: () => void
    const hold = withThreadRunMutationLock(
      f.work.threadId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await tick()
    const pending = f.rename()
    const rejected = expect(pending).rejects.toThrow("已停止")
    f.host.cancel(f.sourceTask.id)
    release()
    await hold
    await rejected
    expect(f.host.getWork(f.bot.id, f.work.id).title).toBe("报告")
    expect(native.update).not.toHaveBeenCalled()
  })

  it.each(["missing", "unrelated", "different-incarnation"])(
    "rejects %s native targets before recording the rename",
    async (kind) => {
      const f = await fixture()
      const row = f.mount()
      if (kind === "missing") native.rows.delete(row.thread_id)
      if (kind === "unrelated") native.rows.set(row.thread_id, { ...row, metadata: "{}" })
      let release: (() => void) | undefined
      const hold =
        kind === "different-incarnation"
          ? withThreadRunMutationLock(
              row.thread_id,
              () =>
                new Promise<void>((resolve) => {
                  release = resolve
                })
            )
          : undefined
      if (hold) await tick()
      const pending = f.rename()
      const rejected = expect(pending).rejects.toThrow()
      if (hold) {
        native.rows.set(row.thread_id, { ...row, created_at: 2 })
        release!()
        await hold
      }
      await rejected
      expect(f.host.getWork(f.bot.id, f.work.id).title).toBe("报告")
      expect(native.update).not.toHaveBeenCalled()
    }
  )

  it("checks task ownership and returns a small tool receipt without original task contents", async () => {
    const f = await fixture()
    const other = f.store.create({
      name: "Other",
      instructions: "",
      color: "#123456",
      modelRef: null
    })
    const privateWork = f.store.createWork({
      botId: other.id,
      operationId: "private",
      title: "Private",
      goal: "Private"
    }).work
    await expect(f.host.renameWorkFromTool(f.source, privateWork.id, 1, "Wrong")).rejects.toThrow()
    const tool = createBotWorkTools(f.sourceTask, () => f.host, new AbortController().signal).find(
      (t) => t.name === "bot_work_rename"
    )!
    const response = await tool.invoke({
      type: "tool_call",
      id: "tool-rename",
      name: tool.name,
      args: {
        requestKey: "tool-rename",
        workId: f.work.id,
        expectedVersion: f.work.version,
        title: "季度报告"
      }
    })
    expect(JSON.stringify(response)).toContain("季度报告")
    expect(JSON.stringify(response)).not.toContain(f.work.goal)
    expect(
      createBotWorkTools(
        { ...f.sourceTask, workId: f.work.id },
        () => f.host,
        new AbortController().signal
      ).some((t) => t.name === "bot_work_rename")
    ).toBe(false)
  })
})
