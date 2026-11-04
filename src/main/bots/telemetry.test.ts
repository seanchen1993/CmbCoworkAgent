import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { BotTelemetryReporter } from "./telemetry-reporter"
import { BOT_EVENTS } from "../../shared/bots/telemetry"
import type { BotImBinding } from "../../shared/bots/im-channel"
import type { CoworkEvent } from "../services/event-reporter"

vi.mock("../storage", () => ({ getUserInfo: () => null }))
const closes: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

function fixture(path = ":memory:") {
  const db = new NativeSqliteAdapter(new DatabaseSync(path))
  let closed = false
  const close = () => {
    if (!closed) {
      closed = true
      db.close()
    }
  }
  closes.push(close)
  const clock = { time: 1_800_000_000_000, owner: "account-one" }
  const store = new BotStore(
    db,
    () => ++clock.time,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => ({ userName: "Test", userIp: "127.0.0.1", sapId: clock.owner, upperOrgLv1: "Test org" })
  )
  const bot = store.create({
    name: "Secret Bot name",
    instructions: "Secret instructions",
    color: "#123456",
    modelRef: null
  })
  const enqueue = (requestId: string) =>
    store.enqueue({
      botId: bot.id,
      requestId,
      message: "Secret message /private/file.docx sk-secret"
    })
  const events = () => store.telemetry.due(Number.MAX_SAFE_INTEGER).map((row) => row.event)
  return { db, store, bot, clock, close, enqueue, events }
}

describe("Bot operational facts", () => {
  it("commits events with business writes, but does not publish rolled-back or duplicate work", () => {
    const f = fixture()
    f.db.run("BEGIN")
    f.store.create({ name: "Rolled back", instructions: "", color: "#123456", modelRef: null })
    f.db.run("ROLLBACK")
    const input = {
      botId: f.bot.id,
      operationId: "work",
      title: "Secret title",
      goal: "Secret goal"
    }
    const created = f.store.createWork(input)
    expect(f.store.createWork(input)).toEqual(created)
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.created)).toHaveLength(1)
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.workCreated)).toHaveLength(1)
    expect(JSON.stringify(f.events())).not.toMatch(
      /Secret|sk-secret|private\/file|instructions|message/
    )
  })

  it("counts a paused/resumed run once, with a separate work confirmation lifecycle", () => {
    const f = fixture()
    const { work, task } = f.store.createWork({
      botId: f.bot.id,
      operationId: "work",
      title: "Draft",
      goal: "Write"
    })
    f.store.transition(task.id, "running")
    f.store.transition(task.id, "waiting_user")
    f.store.transition(task.id, "running")
    f.store.settle(task.id, "completed", null, "Secret result")
    f.store.settle(task.id, "completed", null, "Secret result")
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.started)).toHaveLength(1)
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.ended)).toHaveLength(1)
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.workCompleted)).toHaveLength(0)
    let current = f.store.getWork(f.bot.id, work.id)
    current = f.store.changeWork(f.bot.id, work.id, current.version, "done", "complete")
    f.store.changeWork(f.bot.id, work.id, current.version, "still-done", "complete")
    current = f.store.changeWork(f.bot.id, work.id, current.version, "continue", "continue")
    f.store.changeWork(f.bot.id, work.id, current.version, "done-again", "complete")
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.workCompleted)).toHaveLength(2)
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.workReopened)).toHaveLength(1)
    expect(f.events().find((e) => e.eventName === BOT_EVENTS.ended)?.properties).toMatchObject({
      botRunKind: "work",
      botOutcome: "completed"
    })
  })

  it("does not count checkpoint continuation as a new logical run", () => {
    const f = fixture(),
      task = f.store.enqueue(
        { botId: f.bot.id, requestId: "deferred", message: "Check quietly" },
        { kind: "schedule", scheduleId: "routine" }
      )
    f.store.transition(task.id, "running")
    f.store.deferTask(task.id, "checkpoint")
    f.store.transition(task.id, "running")
    f.store.settle(task.id, "completed", null)
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.started)).toHaveLength(1)
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.ended)).toHaveLength(1)
  })

  it("observes injected turns and bulk interruption recovery without double counting", () => {
    const f = fixture(),
      parent = f.enqueue("parent"),
      child = f.enqueue("child")
    f.store.transition(parent.id, "running")
    f.store.injectIntoRun(child.id, parent.id)
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.started)).toHaveLength(2)
    f.store.recover()
    f.store.recover()
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.ended)).toHaveLength(2)
    expect(
      f
        .events()
        .filter((e) => e.eventName === BOT_EVENTS.ended)
        .every((e) => e.properties?.botOutcome === "interrupted")
    ).toBe(true)
  })

  it.each([
    [null, { kind: "user" }, null, "app_private", "chat"],
    [null, { kind: "group", groupId: "g" }, null, "app_group", "chat"],
    [{ transport: "im", personal: true }, { kind: "user" }, null, "zhaohu_private", "chat"],
    [{ transport: "im" }, { kind: "mock" }, "w", "zhaohu_group", "work"],
    [{ transport: "im" }, { kind: "schedule" }, null, "zhaohu_group", "schedule"],
    [null, { kind: "bot" }, null, "app_private", "collaboration"],
    [null, { kind: "work_result" }, null, "app_private", "notification"],
    [{}, { kind: "mock" }, null, "simulation", "chat"],
    [null, { kind: "introduction" }, null, "app_private", "introduction"]
  ])(
    "keeps channel and execution kind orthogonal (%s, %s)",
    (source, origin, workId, channel, kind) => {
      const f = fixture(),
        task = f.enqueue("case")
      // Set control-state fixtures, then exercise the same SQL observer used by every writer.
      f.db.run(
        "UPDATE bot_tasks SET mock_source_json=?,origin_json=?,work_id=?,state='running',updated_at=? WHERE id=?",
        [
          source === null ? null : JSON.stringify(source),
          JSON.stringify(origin),
          workId,
          f.clock.time,
          task.id
        ]
      )
      expect(f.events().find((e) => e.eventName === BOT_EVENTS.started)?.properties).toMatchObject({
        botChannel: channel,
        botRunKind: kind
      })
    }
  )

  it("counts accepted bindings, not pending codes, polls or group-name changes", () => {
    const f = fixture()
    const binding: BotImBinding = {
      id: "binding",
      botId: f.bot.id,
      kind: "group",
      label: "Secret group",
      state: "pending",
      version: 1,
      conversationKey: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString()
    }
    f.store.imGateway.register("realm", "private-user-id", binding)
    const active = { ...binding, state: "active" as const, version: 2, conversationKey: "room" }
    f.store.imGateway.register("realm", "private-user-id", active)
    f.store.imGateway.register("realm", "private-user-id", {
      ...active,
      peerLabel: "Renamed group"
    })
    f.store.imGateway.register("realm", "private-user-id", {
      ...active,
      state: "revoked",
      version: 3
    })
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.connected)).toHaveLength(1)
    expect(f.events().filter((e) => e.eventName === BOT_EVENTS.revoked)).toHaveLength(1)
    expect(JSON.stringify(f.events())).not.toMatch(
      /private-user-id|Secret group|Renamed group|realm/
    )
  })

  it("retains original event identity across retries/restart and lets older Apps reopen the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-metrics-")),
      path = join(dir, "bots.db")
    closes.push(() => rmSync(dir, { recursive: true, force: true }))
    const f = fixture(path),
      event = f.store.telemetry.due(f.clock.time)[0]
    f.clock.owner = "account-two"
    f.store.telemetry.settle(
      event.id,
      { ok: false, retryable: true, error: "offline" },
      0,
      f.clock.time
    )
    f.close()
    // A connection without the new SQL function must still be able to write old tables.
    const oldApp = new DatabaseSync(path)
    oldApp.prepare("UPDATE bots SET name='Changed by older App' WHERE id=?").run(f.bot.id)
    oldApp.close()
    const db = new NativeSqliteAdapter(new DatabaseSync(path))
    closes.push(() => db.close())
    const reloaded = new BotStore(db)
    const retry = reloaded.telemetry.due(Number.MAX_SAFE_INTEGER)[0]
    expect(retry.event).toEqual(event.event)
    expect(retry.event.sapId).toBe("account-one")
    reloaded.telemetry.settle(retry.id, { ok: true, status: 200 }, 1, Date.now())
    expect(reloaded.telemetry.due(Number.MAX_SAFE_INTEGER)).toEqual([])
    const row = db.exec("SELECT state,context_json,properties_json FROM bot_telemetry_outbox")[0]
      .values[0]
    expect(row).toEqual(["sent", null, null])
  })

  it("uses an indexed bounded batch even with a large backlog", () => {
    const f = fixture()
    f.db.run(`WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<10000)
      INSERT INTO bot_telemetry_outbox(id,event_name,event_time,context_json,properties_json)
      SELECT 'load-'||v,'bot.created',v,'{}','{}' FROM n`)
    expect(f.store.telemetry.due(Number.MAX_SAFE_INTEGER, 1_000_000)).toHaveLength(20)
    const plan = JSON.stringify(
      f.db.exec(
        "EXPLAIN QUERY PLAN SELECT * FROM bot_telemetry_outbox WHERE state='pending' AND next_attempt_at<=9999999999999 ORDER BY next_attempt_at,event_time,id LIMIT 20"
      )
    )
    expect(plan).toContain("bot_telemetry_due")
    expect(plan).not.toContain("TEMP B-TREE")
  })
})

describe("Bot event delivery", () => {
  it("bounds in-flight work and applies offline backoff to the whole backlog", async () => {
    const f = fixture()
    let resolve!: (result: { ok: true; status: number }) => void
    const report = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          })
      )
      .mockResolvedValueOnce({ ok: false, retryable: true, error: "offline", retryAfterMs: 60000 })
      .mockResolvedValue({ ok: true, status: 200 })
    for (let i = 0; i < 30; i++) {
      const task = f.enqueue(`r-${i}`)
      f.store.transition(task.id, "running")
      f.store.settle(task.id, "completed", null)
    }
    const reporter = new BotTelemetryReporter(
      f.store.telemetry,
      () => ({ report }),
      () => f.clock.time
    )
    closes.push(() => reporter.close())
    const first = reporter.flush()
    expect(reporter.flush()).toBe(first)
    expect(report).toHaveBeenCalledTimes(1)
    resolve({ ok: true, status: 200 })
    await first
    expect(report).toHaveBeenCalledTimes(2)
    await reporter.flush()
    expect(report).toHaveBeenCalledTimes(2)
    f.clock.time += 60000
    await reporter.flush()
    expect(report).toHaveBeenCalledTimes(22) // max 20 per flush, rather than draining the entire backlog
    await reporter.close()
    await reporter.flush()
    expect(report).toHaveBeenCalledTimes(22)
  })

  it("sends the existing HTTP envelope and retries an ambiguous response with the same eventId", async () => {
    const { HttpEventReporter } = await import("../services/event-reporter")
    const received: CoworkEvent[] = []
    const server = createServer(async (req, res) => {
      let body = ""
      for await (const chunk of req) body += chunk
      expect(req.url).toBe("/api/traces/events")
      received.push(JSON.parse(body))
      res.writeHead(received.length === 1 ? 503 : 200, { "content-type": "application/json" })
      res.end(JSON.stringify({ code: 200, success: true }))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    closes.push(
      () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    )
    const address = server.address() as { port: number },
      f = fixture()
    let http = new HttpEventReporter(`http://127.0.0.1:${address.port}`)
    const reporter = new BotTelemetryReporter(
      f.store.telemetry,
      () => http,
      () => f.clock.time
    )
    closes.push(() => reporter.close())
    await reporter.flush()
    expect(received).toHaveLength(1)
    expect(f.store.telemetry.due(Number.MAX_SAFE_INTEGER)).toHaveLength(1)
    // New reporter simulates app restart; durable record preserves ID and time.
    http = new HttpEventReporter(`http://127.0.0.1:${address.port}`)
    f.clock.time += 600_000
    await reporter.flush()
    expect(received).toHaveLength(2)
    expect(received[1]).toEqual(received[0])
    expect(received[1].eventCategory).toBe("bot")
    expect(f.store.telemetry.due(Number.MAX_SAFE_INTEGER)).toHaveLength(0)
  })
})
