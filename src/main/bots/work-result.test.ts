import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import type { BotTask, BotTaskState } from "../../shared/bots/contracts"
import { BOT_ROUTINE_SILENT } from "../../shared/bots/routine-silence"

const dbs: NativeSqliteAdapter[] = []
const hosts: LocalBotHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
  dbs.splice(0).forEach((db) => db.close())
})
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  dbs.push(db)
  let now = 1000
  const store = new BotStore(db, () => ++now)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const created = store.createWork({
    botId: bot.id,
    operationId: "create",
    title: "读书会",
    goal: "安排活动"
  })
  return { db, store, bot, ...created }
}
const notices = (store: BotStore) =>
  store.recentTasks().filter((task) => task.origin.kind === "work_result")
function settle(
  store: BotStore,
  task: BotTask,
  state: BotTaskState = "completed",
  result = "周日下午三点，社区阅览室。"
) {
  store.transition(task.id, "running")
  store.settle(task.id, state, state === "failed" ? "模型连接失败" : null, result)
}

describe("independent work result return", () => {
  it("atomically queues one result for the same Bot main chat, without completing the business task", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.settle(f.task.id, "completed", null, "实际结果", [
      { filePath: "/private/output/plan.md", name: "plan.md", size: 30 }
    ])
    expect(notices(f.store)).toHaveLength(0)
    // A fresh store drains the existing outbox; it does not replay the source work.
    const reopened = new BotStore(f.db)
    reopened.recover()
    reopened.flushReplies()
    const [notice] = notices(reopened)
    expect(notice).toMatchObject({
      botId: f.bot.id,
      threadId: f.bot.threadId,
      state: "queued",
      origin: {
        kind: "work_result",
        workId: f.work.id,
        executionTaskId: f.task.id,
        executionState: "completed"
      }
    })
    expect(notice.workId).toBeUndefined()
    expect(JSON.parse(notice.message)).toMatchObject({
      result: "实际结果",
      files: [{ name: "plan.md", size: 30 }],
      businessState: "active"
    })
    expect(notice.message).not.toContain("/private/output")
    expect(reopened.getWork(f.bot.id, f.work.id).state).toBe("active")
    reopened.settle(f.task.id, "completed", null, "重复回调")
    reopened.flushReplies()
    expect(notices(reopened).map((t) => t.id)).toEqual([notice.id])
    settle(reopened, notice)
    reopened.flushReplies()
    expect(notices(reopened)).toHaveLength(1)
    expect(reopened.messageOrigins(f.bot.id, [notice.requestId])[0].origin.kind).toBe("work_result")
  })

  it.each(["completed", "failed", "cancelled", "interrupted", "outcome_unknown"] as const)(
    "returns the actual %s outcome and bounded result, not other conversation history",
    (state) => {
      const f = fixture()
      settle(f.store, f.task, state, state === "failed" ? "" : "A".repeat(20000))
      f.store.flushReplies()
      const [notice] = notices(f.store)
      const body = JSON.parse(notice.message)
      expect(notice.origin).toMatchObject({ executionState: state })
      expect(body.result.length).toBeLessThanOrEqual(16000)
      if (state === "failed") expect(body.result).toBe("模型连接失败")
      else expect(body.truncated).toBe(true)
      expect(f.store.getWork(f.bot.id, f.work.id).state).toBe("active")
    }
  )

  it("returns later revisions separately while preserving the same work and thread", () => {
    const f = fixture()
    settle(f.store, f.task)
    f.store.flushReplies()
    const next = f.store.enqueue({
      botId: f.bot.id,
      workId: f.work.id,
      requestId: "revision",
      message: "改到四点"
    })
    settle(f.store, next, "completed", "周日下午四点")
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(2)
    expect(
      new Set(notices(f.store).map((t) => t.origin.kind === "work_result" && t.origin.workId))
    ).toEqual(new Set([f.work.id]))
    expect(new Set(notices(f.store).map((t) => t.requestId)).size).toBe(2)
  })

  it("returns only the physical run result when multiple user messages were consumed together", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    const child = f.store.enqueue({
      botId: f.bot.id,
      workId: f.work.id,
      requestId: "steer",
      message: "改到四点"
    })
    f.db.run("UPDATE bot_tasks SET state='running',injected_into=? WHERE id=?", [
      f.task.id,
      child.id
    ])
    f.store.settleRun(f.task.id, [child.id], "completed", null, "四点的完整结果")
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(1)
    expect(JSON.parse(notices(f.store)[0].message).result).toBe("四点的完整结果")
  })

  it("does not return superseded turns or known quiet internal completion receipts", () => {
    const f = fixture()
    settle(f.store, f.task, "superseded", "")
    const quiet = f.store.enqueue(
      { botId: f.bot.id, workId: f.work.id, requestId: "quiet", message: "cleanup done" },
      { kind: "notification", notificationKind: "command", key: "cleanup", commandSucceeded: true }
    )
    settle(f.store, quiet, "completed", BOT_ROUTINE_SILENT)
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(0)
  })

  it("returns from linked local conversations and drops a result if the link is removed before delivery", () => {
    const f = fixture()
    const ref = {
      kind: "local_thread" as const,
      threadId: "existing-chat",
      incarnation: { token: "token", legacyCreatedAt: 1 }
    }
    const work = f.store.conversations.prepare({
      botId: f.bot.id,
      operationId: "link",
      title: "项目计划",
      goal: "整理计划",
      conversation: ref
    })
    f.store.conversations.bound(f.bot.id, work.id, ref)
    const task = f.store.enqueue({
      botId: f.bot.id,
      workId: work.id,
      requestId: "linked-turn",
      message: "请修改"
    })
    settle(f.store, task)
    f.store.flushReplies()
    expect(notices(f.store)[0].origin).toMatchObject({
      workId: work.id,
      workThreadId: "existing-chat"
    })
    settle(f.store, notices(f.store)[0])
    const next = f.store.enqueue({
      botId: f.bot.id,
      workId: work.id,
      requestId: "another",
      message: "再修改"
    })
    settle(f.store, next)
    const current = f.store.getWork(f.bot.id, work.id)
    f.store.conversations.beginDetach(f.bot.id, work.id, current.version)
    f.store.conversations.detached(f.bot.id, work.id)
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(1)
  })

  it("reports a source interrupted by restart once, without re-running it", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.recover()
    f.store.flushReplies()
    f.store.recover()
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(1)
    expect(notices(f.store)[0].origin).toMatchObject({ executionState: "interrupted" })
    expect(f.store.getTask(f.task.id).state).toBe("interrupted")
  })

  it("keeps external mock task results in their original audience", () => {
    const f = fixture()
    const binding = f.store.mock.create({
      simulation: true,
      botId: f.bot.id,
      operationId: "bind",
      kind: "dm",
      channelKey: "dm",
      label: "dm",
      allowedSenderIds: ["alice"]
    })
    f.store.mock.inject({
      simulation: true,
      bindingId: binding.id,
      eventId: "event",
      messageId: "message",
      senderId: "alice",
      text: "创建任务",
      mentionsBotIds: []
    })
    const source = f.store.recentTasks().find((t) => t.mockSource)!
    f.store.transition(source.id, "running")
    const work = f.store.createWork(
      { botId: f.bot.id, operationId: "external", title: "渠道计划", goal: "私有渠道内容" },
      { taskId: source.id, callId: "create", key: "create" }
    )
    settle(f.store, work.task)
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(0)
  })

  it("queues behind a busy main conversation and never steers the active user turn", async () => {
    const f = fixture()
    const main = f.store.enqueue({
      botId: f.bot.id,
      requestId: "main",
      message: "正在讨论另一件事"
    })
    let release!: () => void
    const executed: BotTask[] = []
    const host = new LocalBotHost(f.store, {
      onAvailable: () => () => {},
      acquire: (_bot, task) => ({
        release() {},
        async execute(signal) {
          executed.push(task)
          if (task.id === main.id)
            await new Promise<void>((resolve) => {
              release = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
          return { state: "completed", result: "实际回复" }
        }
      })
    })
    hosts.push(host)
    await vi.waitFor(() => expect(notices(f.store)).toHaveLength(1))
    expect(executed.some((task) => task.origin.kind === "work_result")).toBe(false)
    release()
    await vi.waitFor(() =>
      expect(executed.filter((task) => task.origin.kind === "work_result")).toHaveLength(1)
    )
  })
})
