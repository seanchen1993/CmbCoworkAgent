import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import type { BotMockEvent } from "../../shared/bots/mock-channel"

const databases: NativeSqliteAdapter[] = [],
  hosts: LocalBotHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
  databases.splice(0).forEach((db) => db.close())
})
function fixture(path = ":memory:") {
  const db = new NativeSqliteAdapter(new DatabaseSync(path))
  databases.push(db)
  let time = 0
  const store = new BotStore(db, () => ++time),
    bot = store.create({ name: "A", instructions: "Expert", color: "#123456", modelRef: null })
  const binding = (operationId = "bind", kind: "dm" | "group" = "dm", sender = "alice") =>
    store.mock.create({
      simulation: true,
      botId: bot.id,
      operationId,
      kind,
      channelKey: operationId,
      label: operationId,
      allowedSenderIds: [sender]
    })
  const event = (
    bindingId: string,
    eventId = "event",
    extra: Partial<BotMockEvent> = {}
  ): BotMockEvent => ({
    simulation: true,
    bindingId,
    eventId,
    messageId: `message-${eventId}`,
    senderId: "alice",
    text: "Hello",
    mentionsBotIds: [],
    ...extra
  })
  return { db, store, bot, binding, event }
}
function finish(store: BotStore, id: string, text = "Actual answer") {
  store.transition(id, "running")
  store.settle(id, "completed", null, text)
}
describe("local simulated channels", () => {
  it("inspects only exact persisted receipts after revocation or archive, without readmitting events", () => {
    const f = fixture(),
      a = f.binding(),
      input = f.event(a.id)
    const receipt = f.store.mock.inject(input)
    f.store.mock.revoke(f.bot.id, a.id, a.grantVersion)
    expect(f.store.mock.inject(input)).toEqual(receipt)
    expect(() => f.store.mock.inject({ ...input, text: "Different" })).toThrow("不同内容")
    expect(() => f.store.mock.inject({ ...input, messageId: "Different" })).toThrow("不同内容")
    expect(() => f.store.mock.inject(f.event(a.id, "not-persisted"))).toThrow()
    f.store.update({
      ...f.store.getBot(f.bot.id),
      expectedVersion: f.store.getBot(f.bot.id).version,
      archived: true
    })
    expect(f.store.mock.inject(input)).toEqual(receipt)
    expect(f.store.recentTasks()).toHaveLength(1)
    f.db.run("UPDATE bot_mock_events SET receipt_json=json_set(receipt_json,'$.taskId','wrong')")
    expect(() => f.store.mock.inject(input)).toThrow("回执与原记录不一致")
  })
  it("binds fixed audiences, admits one execution per event, and uses structured group mentions or its own sent reply", () => {
    const f = fixture(),
      a = f.binding(),
      b = f.binding("group", "group")
    const input = f.event(a.id),
      receipt = f.store.mock.inject(input)
    expect(f.store.mock.inject(input)).toEqual(receipt)
    expect(() => f.store.mock.inject({ ...input, text: "Changed" })).toThrow("不同内容")
    expect(() =>
      f.store.mock.inject({
        ...input,
        eventId: "forbidden",
        messageId: "other",
        senderId: "mallory"
      })
    ).toThrow("未获")
    const ignored = f.store.mock.inject(
      f.event(b.id, "ignored", { text: "@A says mentioned in plain text" })
    )
    expect(ignored.status).toBe("ignored")
    const mentioned = f.store.mock.inject(
      f.event(b.id, "mentioned", { mentionsBotIds: [f.bot.id] })
    )
    expect(f.store.getTask(mentioned.taskId!).threadId).not.toBe(
      f.store.getTask(receipt.taskId!).threadId
    )
    expect(f.store.listWorks(f.bot.id).items).toHaveLength(0)
    finish(f.store, mentioned.taskId!)
    const out = f.store.mock.beginDelivery()!
    f.store.mock.delivered(out.id, "sent")
    expect(() => f.store.mock.inject(f.event(a.id, "cross", { replyToMessageId: out.id }))).toThrow(
      "不属于"
    )
    expect(f.store.mock.inject(f.event(b.id, "follow", { replyToMessageId: out.id })).status).toBe(
      "accepted"
    )
  })
  it("rolls back the event and task together on native SQLite refusal", () => {
    const f = fixture(),
      a = f.binding(),
      input = f.event(a.id)
    f.db.run(
      "CREATE TEMP TRIGGER refuse_mock AFTER INSERT ON bot_tasks BEGIN SELECT RAISE(ABORT,'fixture storage refused'); END"
    )
    expect(() => f.store.mock.inject(input)).toThrow("storage refused")
    expect(f.store.mock.history(f.bot.id, a.id).items).toHaveLength(0)
    expect(f.store.recentTasks()).toHaveLength(0)
    f.db.run("DROP TRIGGER refuse_mock")
    const result = f.store.mock.inject(input)
    expect(f.store.mock.inject(input)).toEqual(result)
    expect(f.store.recentTasks()).toHaveLength(1)
  })
  it("freezes source into work and desktop continuation without giving owner privileges or cross-audience tools", () => {
    const f = fixture(),
      a = f.binding(),
      b = f.binding("other"),
      e = f.store.mock.inject(f.event(a.id))
    f.store.transition(e.taskId!, "running")
    const source = f.store.getTask(e.taskId!)
    expect(f.store.hasDirectUserRequest(source.id)).toBe(false)
    expect(f.store.hasWorkUserRequest(source.id)).toBe(true)
    const work = f.store.createWork(
      { botId: f.bot.id, operationId: "create", title: "Work", goal: "Draft" },
      { taskId: source.id, callId: "create-call", key: "work" }
    )
    expect(work.work.source?.bindingId).toBe(a.id)
    expect(work.task.mockSource).toEqual(source.mockSource)
    const privateWork = f.store.createWork({
      botId: f.bot.id,
      operationId: "private",
      title: "Private",
      goal: "Owner only"
    })
    expect(
      f.store
        .listWorks(f.bot.id, undefined, "", source.mockSource!.audienceKey)
        .items.map((w) => w.id)
    ).toEqual([work.work.id])
    expect(() =>
      f.store.sendWork(
        { taskId: source.id, callId: "cross", key: "cross" },
        privateWork.work.id,
        "Other"
      )
    ).toThrow("受众")
    const desktop = f.store.enqueue({
      botId: f.bot.id,
      workId: work.work.id,
      requestId: "desktop-edit",
      message: "Edit"
    })
    expect(desktop.mockSource).toEqual(source.mockSource)
    expect(f.store.hasDirectUserRequest(desktop.id)).toBe(false)
    const wrong = f.store.mock.inject(f.event(b.id, "other"))
    f.store.transition(wrong.taskId!, "running")
    expect(() =>
      f.store.sendWork(
        { taskId: wrong.taskId!, callId: "wrong", key: "wrong" },
        work.work.id,
        "Other"
      )
    ).toThrow("受众")
    expect(() => f.store.mock.execution({ ...work.task, mockSource: undefined })).toThrow(
      "来源证明缺失"
    )
    f.db.run(
      "UPDATE bot_mock_events SET payload_json=json_set(payload_json,'$.text','corrupt') WHERE task_id=?",
      [source.id]
    )
    expect(() => f.store.mock.execution(work.task)).toThrow("不一致")
  })
  it("aggregates external work unread at the owner Bot boundary and respects the captured seen clock", () => {
    const f = fixture(),
      a = f.binding(),
      e = f.store.mock.inject(f.event(a.id))
    f.store.transition(e.taskId!, "running")
    const work = f.store.createWork(
      { botId: f.bot.id, operationId: "create", title: "External", goal: "Draft" },
      { taskId: e.taskId!, callId: "create", key: "create" }
    )
    finish(f.store, work.task.id, "First")
    const captured = f.store.workActivities().find((v) => v.botId === f.bot.id)!
    expect(captured.unread).toBe(true)
    const second = f.store.enqueue({
      botId: f.bot.id,
      workId: work.work.id,
      requestId: "second",
      message: "Edit"
    })
    finish(f.store, second.id, "Second")
    f.store.markWorksRead(f.bot.id, captured.version)
    expect(f.store.workActivities().find((v) => v.botId === f.bot.id)?.unread).toBe(true)
    f.store.markWorksRead(
      f.bot.id,
      f.store.workActivities().find((v) => v.botId === f.bot.id)!.version
    )
    expect(f.store.workActivities().find((v) => v.botId === f.bot.id)?.unread).toBe(false)
    expect(f.store.listWorks(f.bot.id, undefined, "", "desktop").items).toHaveLength(0)
  })
  it("routes an active work reply to that exact thread and retains a completed target reference without auto-reopening", () => {
    const f = fixture(),
      a = f.binding(),
      e = f.store.mock.inject(f.event(a.id))
    f.store.transition(e.taskId!, "running")
    const work = f.store.createWork(
      { botId: f.bot.id, operationId: "create", title: "Work", goal: "Draft" },
      { taskId: e.taskId!, callId: "create", key: "create" }
    )
    f.store.settle(e.taskId!, "completed", null, "Created")
    finish(f.store, work.task.id, "First work result")
    let out = f.store.mock.beginDelivery()!
    f.store.mock.delivered(out.id, "sent")
    out = f.store.mock.beginDelivery()!
    f.store.mock.delivered(out.id, "sent")
    const result = f.store.mock
      .history(f.bot.id, a.id)
      .items.find((v) => v.workId === work.work.id)!
    const reply = f.store.mock.inject(
      f.event(a.id, "edit", { text: "Change to Sunday", replyToMessageId: result.id })
    )
    expect(f.store.getTask(reply.taskId!).threadId).toBe(work.work.threadId)
    finish(f.store, reply.taskId!, "Sunday")
    const current = f.store.getWork(f.bot.id, work.work.id)
    f.store.changeWork(f.bot.id, work.work.id, current.version, "done", "complete")
    const follow = f.store.mock.inject(
      f.event(a.id, "completed", { text: "Continue please", replyToMessageId: result.id })
    )
    const task = f.store.getTask(follow.taskId!)
    expect(task.workId).toBeUndefined()
    expect(task.message).toContain(work.work.id)
    expect(task.message).toContain("completed")
    expect(f.store.getWork(f.bot.id, work.work.id).state).toBe("completed")
  })
  it("rechecks online/revocation/owner state immediately before delivery, leaving only genuine in-flight uncertainty unknown", () => {
    const f = fixture(),
      a = f.binding(),
      e = f.store.mock.inject(f.event(a.id))
    finish(f.store, e.taskId!)
    let out = f.store.mock.beginDelivery()!
    f.store.mock.setOnline(f.bot.id, a.id, false)
    expect(f.store.mock.mayDeliver(out.id)).toBe(false)
    expect(f.store.mock.history(f.bot.id, a.id).items[0].state).toBe("pending")
    f.store.mock.setOnline(f.bot.id, a.id, true)
    out = f.store.mock.beginDelivery()!
    f.store.mock.revoke(f.bot.id, a.id, 1)
    expect(f.store.mock.mayDeliver(out.id)).toBe(false)
    expect(f.store.mock.history(f.bot.id, a.id).items[0].state).toBe("blocked")
    expect(() => f.store.mock.inject(f.event(a.id, "late"))).toThrow("撤销")
    const b = f.binding("other"),
      second = f.store.mock.inject(f.event(b.id, "second"))
    finish(f.store, second.taskId!)
    out = f.store.mock.beginDelivery()!
    f.store.update({ ...f.bot, expectedVersion: f.bot.version, archived: true })
    expect(f.store.mock.mayDeliver(out.id)).toBe(false)
    expect(f.store.mock.history(f.bot.id, b.id).items[0].state).toBe("blocked")
  })
  it("leaves only the mock queue offline while beta responds, and never automatically retries unknown delivery", async () => {
    const f = fixture(),
      calls: string[] = [],
      sends: string[] = []
    const host = new LocalBotHost(
      f.store,
      {
        onAvailable: () => () => {},
        acquire: (_bot, task) => ({
          release() {},
          execute: async () => {
            calls.push(task.id)
            return { state: "completed", result: "Real local execution" }
          }
        })
      },
      2,
      () => {},
      undefined,
      {
        send: async (reply) => {
          sends.push(reply.id)
          return "unknown"
        }
      }
    )
    hosts.push(host)
    const a = host.createMockBinding({
      simulation: true,
      botId: f.bot.id,
      operationId: "channel",
      kind: "dm",
      channelKey: "channel",
      label: "Channel",
      allowedSenderIds: ["alice"]
    })
    host.setMockOnline(f.bot.id, a.id, false)
    const e = host.injectMockEvent(f.event(a.id))
    const owner = host.send({ botId: f.bot.id, requestId: "owner", message: "Owner hello" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toEqual([owner.id])
    expect(f.store.getTask(e.taskId!).state).toBe("queued")
    host.setMockOnline(f.bot.id, a.id, true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toContain(e.taskId)
    expect(sends).toHaveLength(1)
    host.resume()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sends).toHaveLength(1)
    expect(host.mockHistory(f.bot.id, a.id).items[0].state).toBe("unknown")
  })
  it("recovers interrupted receipts in indexed batches without loading the full old queue", () => {
    const f = fixture(),
      a = f.binding()
    for (let i = 0; i < 105; i++) f.store.mock.inject(f.event(a.id, `old-${i}`))
    f.db.run("UPDATE bot_tasks SET state='interrupted'")
    const count = () => Number(f.db.exec("SELECT COUNT(*) FROM bot_mock_outbox")[0].values[0][0])
    f.store.mock.recover()
    expect(count()).toBe(0)
    const counts: number[] = []
    while (true) {
      const before = count(),
        more = f.store.mock.recoverInterruptedBatch()
      counts.push(count() - before)
      if (!more) break
    }
    expect(counts).toEqual([40, 40, 25])
    expect(count()).toBe(105)
    expect(f.store.mock.recoverInterruptedBatch()).toBe(false)
    expect(f.store.recentTasks().every((t) => t.state === "interrupted")).toBe(true)
    expect(
      JSON.stringify(
        f.db.exec(
          "EXPLAIN QUERY PLAN SELECT t.id,o.source_task_id AS recorded FROM bot_tasks t LEFT JOIN bot_mock_outbox o ON o.source_task_id=t.id WHERE t.mock_source_json IS NOT NULL AND t.state='interrupted' AND t.id>'' AND t.id<='z' ORDER BY t.id LIMIT 40"
        )
      )
    ).toContain("bot_mock_interrupted")
  })
  it("reopens persisted original events and sending receipts without rerunning or resending", () => {
    const dir = mkdtempSync(join(tmpdir(), "m05-mock-reopen-")),
      path = join(dir, "control.sqlite")
    const f = fixture(path),
      a = f.binding(),
      input = f.event(a.id),
      receipt = f.store.mock.inject(input)
    finish(f.store, receipt.taskId!)
    f.store.mock.beginDelivery()
    databases.splice(databases.indexOf(f.db), 1)
    f.db.close()
    const db = new NativeSqliteAdapter(new DatabaseSync(path))
    try {
      const store = new BotStore(db)
      store.recover()
      expect(store.mock.inject(input)).toEqual(receipt)
      expect(store.recentTasks()).toHaveLength(1)
      expect(store.mock.beginDelivery()).toBeNull()
      expect(store.mock.history(f.bot.id, a.id).items[0].state).toBe("unknown")
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
