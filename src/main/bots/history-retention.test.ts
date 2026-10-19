import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"

const DAY = 86400000
const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function fixture() {
  const native = new DatabaseSync(":memory:")
  const adapter = new NativeSqliteAdapter(native)
  databases.push(adapter)
  let now = 1000
  const transcripts = new Map<string, Map<string, string>>()
  const readTranscript = (thread: string, ids: string[]) =>
    new Map(
      ids.flatMap((id) => {
        const message = transcripts.get(thread)?.get(id)
        return message == null ? [] : [[id, message] as const]
      })
    )
  const store = new BotStore(adapter, () => now, readTranscript)
  const bot = store.create({ name: "A", instructions: "", color: "#ea2845", modelRef: null })
  const peer = store.create({ name: "B", instructions: "", color: "#ea2845", modelRef: null })
  const complete = (key: string) => {
    const task = store.enqueue({ botId: bot.id, requestId: key, message: `work-${key}` })
    store.transition(task.id, "running")
    store.settle(task.id, "completed", null, "Done")
    return task
  }
  const fillTail = () => {
    now += 1
    for (let i = 0; i < 100; i++) complete(`tail-${i}`)
    now += 31 * DAY
  }
  return {
    native,
    adapter,
    store,
    bot,
    peer,
    complete,
    fillTail,
    transcripts,
    reopen: () => new BotStore(adapter, () => now, readTranscript),
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe("Bot control history retention", () => {
  it("keeps a command's original request while its bounded receipt is retained", () => {
    const f = fixture()
    const source = f.store.enqueue({
      botId: f.bot.id,
      requestId: "command-source",
      message: "Rename Peer after checking"
    })
    f.store.transition(source.id, "running")
    f.store.acceptCommand(source.id, {
      id: "long-command",
      threadId: source.threadId,
      command: "node check.js",
      cwd: "/synthetic",
      startedAt: 1000
    })
    f.store.transition(source.id, "completed")
    f.fillTail()
    f.store.pruneTaskHistory()
    expect(f.store.getTask(source.id).message).toBe(source.message)
    const reopened = f.reopen()
    reopened.settleCommand({
      id: "long-command",
      threadId: source.threadId,
      output: "Checked",
      exitCode: 0,
      truncated: false,
      cancelled: false
    })
    const notice = reopened.nextQueued([])!
    reopened.transition(notice.id, "running")
    expect(reopened.profileContinuationRequest(notice.id)).toBe(source.message)
  })
  it("retains routine provenance after task pruning without copying the routine transcript", () => {
    const f = fixture()
    const task = f.store.enqueue(
      { botId: f.bot.id, requestId: "old-routine", message: "Check once" },
      { kind: "schedule", scheduleId: "routine" }
    )
    f.store.transition(task.id, "running")
    f.store.settle(task.id, "completed", null, "BOT_ROUTINE_SILENT")
    f.fillTail()
    expect(f.store.pruneTaskHistory()).toBe(1)
    expect(
      f.native.prepare("SELECT message FROM bot_exchange_archive WHERE id=?").get(task.id)
    ).toEqual({ message: null })
    expect(f.reopen().messageOrigins(f.bot.id, [task.requestId])).toEqual([
      { id: task.id, requestId: task.requestId, origin: task.origin, state: "completed" }
    ])
    expect(f.reopen().messageOrigins(f.peer.id, [task.requestId])).toEqual([])
  })
  it("keeps exchange references and provenance after task pruning without duplicating durable messages", () => {
    const f = fixture()
    const root = f.store.enqueue({ botId: f.bot.id, requestId: "root", message: "Delegate" })
    f.store.transition(root.id, "running")
    const dispatch = f.store.delegate(root.id, f.peer.id, "Independent check", "check")
    f.store.transition(dispatch.id, "running")
    f.store.settle(dispatch.id, "completed", null, "Checked")
    f.store.settle(root.id, "completed", null)
    f.store.flushReplies()
    const reply = f.store.recentTasks().find((task) => task.requestId === `reply-${dispatch.id}`)!
    f.store.transition(reply.id, "running")
    f.store.settle(reply.id, "completed", null, "Delivered")
    for (const task of [dispatch, reply]) {
      if (task.origin.kind !== "bot") throw new Error("expected collaboration")
      f.transcripts.set(
        task.threadId,
        new Map([
          [
            task.requestId,
            `来自 ${task.origin.fromBotName} 的${task.origin.expectsReply ? "协作消息" : "协作结果"}：\n\n${task.message}`
          ]
        ])
      )
    }
    f.fillTail()
    expect(f.store.pruneTaskHistory()).toBe(3)
    expect(() => f.store.getTask(dispatch.id)).toThrow("不存在")
    expect(f.native.prepare("SELECT message FROM bot_exchange_archive ORDER BY id").all()).toEqual([
      { message: null },
      { message: null }
    ])
    const reopened = f.reopen()
    expect(reopened.exchangeHistory(f.bot.id, dispatch.id).items).toMatchObject([
      {
        taskId: dispatch.id,
        message: "Independent check",
        reply: { message: "Checked", delivered: true }
      }
    ])
    expect(reopened.messageOrigins(f.peer.id, [dispatch.requestId])).toMatchObject([
      { id: dispatch.id, origin: { kind: "bot", fromBotId: f.bot.id, expectsReply: true } }
    ])
    expect(reopened.messageOrigins(f.bot.id, [dispatch.requestId])).toEqual([])
    expect(() =>
      reopened.enqueue({
        botId: f.peer.id,
        requestId: dispatch.requestId,
        message: dispatch.message
      })
    ).toThrow("已处理")
    f.transcripts.clear()
    expect(() => reopened.exchange(f.bot.id, dispatch.id)).toThrow("原会话消息")
    reopened.beginDeletion(f.peer.id, f.peer.version)
    reopened.finishDeletion(f.peer.id)
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM bot_exchange_archive").get()?.n).toBe(0)
  })

  it("retains the original dispatch when cancellation happened before Runtime persistence", () => {
    const f = fixture()
    const root = f.store.enqueue({ botId: f.bot.id, requestId: "cancel-root", message: "Delegate" })
    f.store.transition(root.id, "running")
    const dispatch = f.store.delegate(root.id, f.peer.id, "Not yet executed", "cancel-check")
    f.store.transition(dispatch.id, "cancelled")
    f.store.settle(root.id, "completed", null)
    f.fillTail()
    f.store.pruneTaskHistory()
    expect(f.reopen().exchange(f.bot.id, dispatch.id)).toMatchObject({
      message: "Not yet executed",
      state: "cancelled",
      reply: null
    })
  })

  it("prunes old payloads in bounded batches, retains the visible tail and blocks duplicate execution", () => {
    const f = fixture()
    for (let i = 0; i < 110; i++) f.complete(`old-${i}`)
    f.fillTail()
    expect(f.store.pruneTaskHistory()).toBe(100)
    expect(f.store.pruneTaskHistory()).toBe(10)
    expect(f.store.pruneTaskHistory()).toBe(0)
    expect(f.store.recentTasks()).toHaveLength(100)
    expect(() =>
      f.store.enqueue({ botId: f.bot.id, requestId: "old-0", message: "work-old-0" })
    ).toThrow("已处理")
    expect(() =>
      f.store.enqueue({ botId: f.bot.id, requestId: "old-0", message: "changed" })
    ).toThrow("另一条")
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM bot_task_receipts").get()?.n).toBe(110)
    f.advance(60 * DAY)
    f.store.pruneTaskHistory()
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM bot_task_receipts").get()?.n).toBe(0)
  })

  it("keeps a completed root while a peer is queued and while its reply awaits delivery", () => {
    const f = fixture()
    const root = f.store.enqueue({ botId: f.bot.id, requestId: "root", message: "Delegate" })
    f.store.transition(root.id, "running")
    const peer = f.store.delegate(root.id, f.peer.id, "Review", "review")
    f.store.settle(root.id, "completed", null, "Pending review")
    f.fillTail()
    expect(f.store.pruneTaskHistory()).toBe(0)
    expect(f.store.getTask(root.id).state).toBe("completed")
    f.store.transition(peer.id, "running")
    f.store.settle(peer.id, "completed", null, "Verified")
    f.advance(31 * DAY)
    f.store.pruneTaskHistory()
    expect(f.store.getTask(peer.id).state).toBe("completed")
    expect(f.store.getTask(root.id).state).toBe("completed")
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM bot_reply_outbox").get()?.n).toBe(1)
    f.store.flushReplies()
    f.store.pruneTaskHistory()
    const reply = f.store.recentTasks().find((task) => task.requestId === `reply-${peer.id}`)
    expect(reply?.state).toBe("queued")
    expect(f.store.getTask(root.id).id).toBe(root.id)
  })

  it("rolls back both receipt and deletion if cleanup fails", () => {
    const f = fixture()
    const old = f.complete("old")
    f.fillTail()
    const run = f.adapter.run.bind(f.adapter)
    const fault = vi.spyOn(f.adapter, "run").mockImplementation((sql, args) => {
      if (sql === "DELETE FROM bot_tasks WHERE id=?") throw new Error("disk failure")
      return run(sql, args)
    })
    expect(() => f.store.pruneTaskHistory()).toThrow("disk failure")
    fault.mockRestore()
    expect(f.store.getTask(old.id)).toBeDefined()
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM bot_task_receipts").get()?.n).toBe(0)
    expect(f.store.pruneTaskHistory()).toBe(1)
  })

  it("discovers group recovery threads even after their control history is gone", () => {
    const f = fixture()
    const group = f.store.saveGroup({ name: "Team", memberIds: [f.bot.id, f.peer.id] })
    expect(f.store.notificationThreadIds()).toContain(`group-${group.id}-${f.bot.id}`)
    expect(f.store.notificationThreadIds()).toContain(`group-${group.id}-${f.peer.id}`)
  })
})
