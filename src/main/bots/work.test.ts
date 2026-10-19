import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunPort } from "./host"
import { botTaskWorkFamily } from "../../shared/bots/contracts"

const databases: NativeSqliteAdapter[] = [],
  hosts: LocalBotHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
  databases.splice(0).forEach((d) => d.close())
})
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  let time = 1000
  const store = new BotStore(db, () => ++time)
  const input = { name: "Owner", instructions: "Keep role", color: "#ea2845", modelRef: null }
  const bot = store.create(input),
    peer = store.create({ ...input, name: "Peer" })
  const create = (operationId = "create") =>
    store.createWork({ botId: bot.id, operationId, title: "Draft", goal: "Prepare a draft" })
  return { db, store, bot, peer, create }
}
function finish(store: BotStore, id: string) {
  store.transition(id, "running")
  store.settle(id, "completed", null, "A draft")
}

describe("durable local independent works", () => {
  it("reopens the original receipt and rolls back native write refusal without creating another work", () => {
    const dir = mkdtempSync(join(tmpdir(), "m05-work-store-")),
      path = join(dir, "control.sqlite")
    let db = new NativeSqliteAdapter(new DatabaseSync(path))
    try {
      let store = new BotStore(db)
      const bot = store.create({
        name: "A",
        instructions: "Work",
        color: "#123456",
        modelRef: null
      })
      const input = {
        botId: bot.id,
        operationId: "create-original",
        title: "Draft",
        goal: "Prepare"
      }
      const receipt = store.createWork(input)
      store.initializeWorkThread(bot.id, receipt.work.id)
      db.close()
      db = new NativeSqliteAdapter(new DatabaseSync(path))
      store = new BotStore(db)
      expect(store.createWork(input)).toEqual(receipt)
      expect(store.getWork(bot.id, receipt.work.id).threadInitialized).toBe(true)
      expect(store.recentTasks()).toHaveLength(1)
      db.run("PRAGMA query_only=ON")
      expect(() => store.createWork({ ...input, operationId: "write-refused" })).toThrow()
      db.run("PRAGMA query_only=OFF")
      expect(store.listWorks(bot.id).items).toHaveLength(1)
      const accepted = store.createWork({ ...input, operationId: "write-refused" })
      expect(store.createWork({ ...input, operationId: "write-refused" })).toEqual(accepted)
      expect(store.recentTasks()).toHaveLength(2)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it("creates one fixed conversation and initial execution, scopes replay and receipts, and keeps lifecycle explicit", () => {
    const f = fixture(),
      r = f.create()
    expect(f.create()).toEqual(r)
    expect(() =>
      f.store.createWork({
        botId: f.bot.id,
        operationId: "create",
        title: "Other",
        goal: "Prepare a draft"
      })
    ).toThrow("不同内容")
    expect(r.task.threadId).toBe(r.work.threadId)
    expect(r.task.workId).toBe(r.work.id)
    expect(f.store.getBot(f.bot.id).threadId).not.toBe(r.work.threadId)
    expect(() => f.store.getWork(f.peer.id, r.work.id)).toThrow()
    const hash = createHash("sha256").update(r.task.message).digest("hex")
    expect(
      f.store.requestReceipts(
        f.bot.id,
        [{ requestId: r.task.requestId, messageHash: hash }],
        r.work.id
      )[0].state
    ).toBe("accepted")
    expect(
      f.store.requestReceipts(f.bot.id, [{ requestId: r.task.requestId, messageHash: hash }])[0]
        .state
    ).toBe("conflict")
    expect(() =>
      f.store.changeWork(f.bot.id, r.work.id, r.work.version, "complete-busy", "complete")
    ).toThrow("待办")
    finish(f.store, r.task.id)
    const current = f.store.getWork(f.bot.id, r.work.id)
    expect(current.state).toBe("active")
    const done = f.store.changeWork(f.bot.id, r.work.id, current.version, "done", "complete")
    expect(f.store.changeWork(f.bot.id, r.work.id, current.version, "done", "complete")).toEqual(
      done
    )
    expect(() =>
      f.store.enqueue({ botId: f.bot.id, workId: r.work.id, requestId: "late", message: "Edit" })
    ).toThrow()
    const resumed = f.store.changeWork(f.bot.id, r.work.id, done.version, "resume", "continue")
    expect(resumed.threadId).toBe(r.work.threadId)
    expect(f.store.recentTasks()).toHaveLength(1)
    const edit = f.store.enqueue({
      botId: f.bot.id,
      workId: r.work.id,
      requestId: "edit",
      message: "Edit"
    })
    expect(edit.threadId).toBe(r.work.threadId)
  })
  it("aggregates activity ahead of newer queued supplements and gates completion on async collaborators/outbox", () => {
    const f = fixture(),
      r = f.create()
    f.store.transition(r.task.id, "running")
    f.store.transition(r.task.id, "waiting_user")
    f.store.enqueue({
      botId: f.bot.id,
      workId: r.work.id,
      requestId: "supplement",
      message: "Extra"
    })
    expect(f.store.listWorks(f.bot.id).items[0].executionState).toBe("waiting_user")
    const peer = f.store.delegate(r.task.id, f.peer.id, "Review", "review")
    expect(peer.origin).toMatchObject({ rootWorkId: r.work.id, returnWorkId: r.work.id })
    expect(f.store.listWorks(f.bot.id).items[0].pendingPeers).toBe(1)
    f.store.settle(r.task.id, "completed", null)
    const supplement = f.store.recentTasks().find((t) => t.requestId === "supplement")!
    f.store.transition(supplement.id, "cancelled")
    expect(() =>
      f.store.changeWork(
        f.bot.id,
        r.work.id,
        f.store.getWork(f.bot.id, r.work.id).version,
        "busy-peer",
        "complete"
      )
    ).toThrow()
    finish(f.store, peer.id)
    expect(() =>
      f.store.changeWork(
        f.bot.id,
        r.work.id,
        f.store.getWork(f.bot.id, r.work.id).version,
        "busy-reply",
        "complete"
      )
    ).toThrow()
    f.store.flushReplies()
    const reply = f.store.recentTasks().find((t) => t.requestId === `reply-${peer.id}`)!
    expect(reply.workId).toBe(r.work.id)
    expect(reply.threadId).toBe(r.work.threadId)
    finish(f.store, reply.id)
    expect(
      f.store.changeWork(
        f.bot.id,
        r.work.id,
        f.store.getWork(f.bot.id, r.work.id).version,
        "done",
        "complete"
      ).state
    ).toBe("completed")
  })
  it("retains late closed-route results while delivering unrelated outbox items", () => {
    const f = fixture(),
      r = f.create(),
      other = f.create("other")
    f.store.transition(r.task.id, "running")
    f.store.transition(other.task.id, "running")
    const one = f.store.delegate(r.task.id, f.peer.id, "Review one", "one")
    const two = f.store.delegate(other.task.id, f.peer.id, "Review two", "two")
    f.store.settle(r.task.id, "completed", null)
    f.store.settle(other.task.id, "completed", null)
    finish(f.store, one.id)
    finish(f.store, two.id)
    // Simulate a legacy/late closed route; the guarded public complete cannot produce this race.
    f.db.run("UPDATE bot_work_items SET state='completed' WHERE id=?", [r.work.id])
    f.store.flushReplies()
    f.store.flushReplies()
    expect(f.store.recentTasks().filter((t) => t.requestId === `reply-${one.id}`)).toHaveLength(0)
    expect(f.store.recentTasks().filter((t) => t.requestId === `reply-${two.id}`)).toHaveLength(1)
    expect(f.store.exchange(f.bot.id, one.id, undefined, r.work.id).reply).toMatchObject({
      delivered: false,
      message: "A draft"
    })
  })
  it("keeps work-family waits visible and fences archive/deletion without orphaning peer execution", () => {
    const f = fixture(),
      r = f.create()
    f.store.transition(r.task.id, "running")
    const peer = f.store.delegate(r.task.id, f.peer.id, "Review", "peer")
    f.store.settle(r.task.id, "completed", null)
    f.store.transition(peer.id, "running")
    f.store.transition(peer.id, "waiting_user")
    expect(f.store.getWork(f.bot.id, r.work.id).executionState).toBe("waiting_user")
    expect(f.store.getWork(f.bot.id, r.work.id).activity?.unread).toBe(true)
    expect(() =>
      f.store.update({ ...f.bot, expectedVersion: f.bot.version, archived: true })
    ).toThrow("关联协作")
    expect(() => f.store.beginDeletion(f.bot.id, f.bot.version)).toThrow("关联协作")
    expect(f.store.getBot(f.bot.id).archived).toBe(false)
    f.store.settle(peer.id, "cancelled", null)
    const next = f.create("next")
    f.store.transition(next.task.id, "running")
    const queuedPeer = f.store.delegate(next.task.id, f.peer.id, "Another review", "another")
    f.store.settle(next.task.id, "completed", null)
    f.store.update({ ...f.bot, expectedVersion: f.bot.version, archived: true })
    expect(f.store.getTask(queuedPeer.id).state).toBe("cancelled")
    expect(f.store.nextQueued([])).toBeNull()
    expect(() => f.store.flushReplies()).not.toThrow()
  })
  it("keeps paginated metadata and thread discovery after execution pruning", () => {
    const f = fixture()
    for (let i = 0; i < 45; i++) {
      const r = f.create(`work-${i}`)
      f.store.transition(r.task.id, "cancelled")
    }
    const first = f.store.listWorks(f.bot.id),
      second = f.store.listWorks(f.bot.id, first.nextCursor!)
    expect(first.items).toHaveLength(40)
    expect(second.items).toHaveLength(5)
    expect(new Set([...first.items, ...second.items].map((w) => w.id)).size).toBe(45)
    expect(first.items[0]).not.toHaveProperty("goal")
    expect(() => f.store.listWorks(f.peer.id, first.nextCursor!)).toThrow()
    f.db.run("DELETE FROM bot_tasks")
    const threads = first.items.map((w) => w.threadId)
    expect(f.store.notificationThreadIds()).toEqual(expect.arrayContaining(threads))
    expect(f.store.beginDeletion(f.bot.id, f.bot.version)).toEqual(expect.arrayContaining(threads))
  })
  it("surfaces an old active work ahead of 40 newer completed works and batches expanded metadata", () => {
    const f = fixture(),
      old = f.create("old")
    f.store.transition(old.task.id, "running")
    f.store.transition(old.task.id, "waiting_user")
    for (let i = 0; i < 41; i++) {
      const r = f.create(`new-${i}`)
      finish(f.store, r.task.id)
      f.store.changeWork(
        f.bot.id,
        r.work.id,
        f.store.getWork(f.bot.id, r.work.id).version,
        `done-${i}`,
        "complete"
      )
    }
    const page = f.store.listWorks(f.bot.id)
    expect(page.items.some((w) => w.id === old.work.id)).toBe(false)
    expect(page.priority).toMatchObject([{ id: old.work.id, executionState: "waiting_user" }])
    expect(f.store.workSummaries(f.bot.id, [old.work.id])).toMatchObject([
      { id: old.work.id, executionState: "waiting_user" }
    ])
    expect(() => f.store.workSummaries(f.peer.id, [old.work.id])).toThrow()
    expect(() => f.store.workSummaries(f.bot.id, Array(41).fill(old.work.id))).toThrow()
  })
  it("acknowledges only the displayed main/work boundary and preserves newer activity against late bulk reads", () => {
    const f = fixture(),
      a = f.create("a"),
      b = f.create("b")
    const main = f.store.enqueue({ botId: f.bot.id, requestId: "main", message: "Hello" })
    finish(f.store, main.id)
    finish(f.store, a.task.id)
    finish(f.store, b.task.id)
    const mainActivity = f.store.activities().find((x) => x.kind === "bot" && x.id === f.bot.id)!
    const aActivity = f.store.getWork(f.bot.id, a.work.id).activity!
    expect(aActivity.unread).toBe(true)
    f.store.markRead("bot", f.bot.id, mainActivity.version)
    expect(f.store.getWork(f.bot.id, a.work.id).activity!.unread).toBe(true)
    expect(f.store.workActivities()[0].unread).toBe(true)
    f.store.markUnread("bot", f.bot.id)
    f.store.markRead("work", a.work.id, aActivity.version)
    expect(f.store.activities().find((x) => x.kind === "bot" && x.id === f.bot.id)!.unread).toBe(
      true
    )
    expect(f.store.getWork(f.bot.id, b.work.id).activity!.unread).toBe(true)
    const boundary = f.store.workActivities()[0].version
    const supplement = f.store.enqueue({
      botId: f.bot.id,
      workId: a.work.id,
      requestId: "late-reply",
      message: "Revise"
    })
    finish(f.store, supplement.id)
    f.store.markWorksRead(f.bot.id, boundary)
    expect(f.store.getWork(f.bot.id, a.work.id).activity!.unread).toBe(true)
    expect(f.store.getWork(f.bot.id, b.work.id).activity!.unread).toBe(false)
    // A switched-away acknowledgement cannot clear a later reply in the original work.
    f.store.markRead("work", a.work.id, aActivity.version)
    expect(f.store.getWork(f.bot.id, a.work.id).activity!.unread).toBe(true)
    expect(f.store.activities().some((x) => x.kind === "work")).toBe(false)
    f.store.markWorksRead(f.bot.id, f.store.workActivities()[0].version)
    expect(f.store.workActivities()[0].unread).toBe(false)
  })
  it("blocks completion on original background managers and skips late notifications for a closed work", async () => {
    const f = fixture(),
      r = f.create()
    finish(f.store, r.task.id)
    let busy = true
    const host = new LocalBotHost(f.store, {
      acquire: () => null,
      onAvailable: () => () => {},
      hasPendingWork: async (threads) => {
        expect(threads).toContain(r.work.threadId)
        return busy
      }
    })
    hosts.push(host)
    const current = f.store.getWork(f.bot.id, r.work.id)
    await expect(
      host.changeWork(f.bot.id, r.work.id, current.version, "complete", "complete")
    ).rejects.toThrow("后台")
    busy = false
    const done = await host.changeWork(f.bot.id, r.work.id, current.version, "complete", "complete")
    expect(done.state).toBe("completed")
    busy = true
    expect(
      await host.changeWork(f.bot.id, r.work.id, current.version, "complete", "complete")
    ).toEqual(done)
    expect(() =>
      host.enqueueNotification(f.bot.id, r.work.threadId, "workflow", "late", "Late result")
    ).not.toThrow()
    expect(() =>
      host.enqueueNotification(f.bot.id, r.work.threadId, "coordinator", "late", "Late result")
    ).not.toThrow()
    expect(f.store.recentTasks()).toHaveLength(1)
  })
  it("does not claim a historical peer's later background work, and stops only source-bound peer commands", async () => {
    const f = fixture(),
      cancelledThreads: string[] = [],
      cancelledCommands: string[][] = []
    const host = new LocalBotHost(f.store, {
      acquire: () => null,
      onAvailable: () => () => {},
      hasPendingWork: async (threads) => threads.includes(f.peer.threadId),
      cancelBackground: (thread) => {
        cancelledThreads.push(thread)
      },
      cancelBackgroundCommands: (ids) => {
        cancelledCommands.push([...ids])
      }
    })
    hosts.push(host)
    const r = f.create()
    f.store.transition(r.task.id, "running")
    const peer = f.store.delegate(r.task.id, f.peer.id, "Review", "peer")
    f.store.settle(r.task.id, "completed", null)
    finish(f.store, peer.id)
    f.store.flushReplies()
    finish(f.store, f.store.recentTasks().find((t) => t.requestId === `reply-${peer.id}`)!.id)
    const unrelated = f.store.enqueue({
      botId: f.peer.id,
      requestId: "unrelated",
      message: "Other work"
    })
    f.store.transition(unrelated.id, "running")
    f.store.acceptCommand(unrelated.id, {
      id: "unrelated-command",
      threadId: f.peer.threadId,
      command: "unrelated",
      cwd: "/fixture",
      startedAt: 1
    })
    f.store.settle(unrelated.id, "completed", null)
    expect(
      (
        await host.changeWork(
          f.bot.id,
          r.work.id,
          f.store.getWork(f.bot.id, r.work.id).version,
          "done",
          "complete"
        )
      ).state
    ).toBe("completed")
    host.stopConversation(f.bot.id, undefined, r.work.id)
    expect(cancelledThreads).toEqual([r.work.threadId])
    expect(cancelledCommands).toEqual([])
    const other = f.create("other")
    f.store.transition(other.task.id, "running")
    const linked = f.store.delegate(other.task.id, f.peer.id, "Review another", "another")
    f.store.transition(linked.id, "running")
    f.store.acceptCommand(linked.id, {
      id: "linked-command",
      threadId: f.peer.threadId,
      command: "linked",
      cwd: "/fixture",
      startedAt: 2
    })
    f.store.settle(linked.id, "completed", null)
    host.stopConversation(f.bot.id, undefined, other.work.id)
    expect(cancelledThreads).toEqual([r.work.threadId, other.work.threadId])
    expect(cancelledCommands).toEqual([["linked-command"]])
    expect(
      f.db.exec("SELECT suppressed FROM bot_commands WHERE id='unrelated-command'")[0].values[0][0]
    ).toBe(0)
  })
  it("reserves one graph for main while a work or its peer waits; additional work stays queued", async () => {
    const f = fixture(),
      executions: Array<{ task: ReturnType<BotStore["getTask"]>; finish: () => void }> = []
    const runtime: BotRunPort = {
      onAvailable: () => () => {},
      acquire: (_bot, task) => ({
        release() {},
        execute: async (signal, waiting) => {
          waiting(true)
          await new Promise<void>((resolve) => {
            executions.push({ task, finish: resolve })
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
          return { state: "completed" }
        }
      })
    }
    const host = new LocalBotHost(f.store, runtime)
    hosts.push(host)
    const a = host.createWork({ botId: f.bot.id, operationId: "a", title: "A", goal: "A" })
    const b = host.createWork({ botId: f.bot.id, operationId: "b", title: "B", goal: "B" })
    await new Promise((r) => setTimeout(r, 20))
    const peer = host.delegate(a.task.id, f.peer.id, "Review", "peer")
    host.send({ botId: f.bot.id, requestId: "main", message: "Still there?" })
    await new Promise((r) => setTimeout(r, 20))
    expect(executions).toHaveLength(2)
    expect(executions.some((e) => e.task.requestId === "main")).toBe(true)
    expect(f.store.getTask(peer.id).state).toBe("queued")
    expect(f.store.getTask(b.task.id).state).toBe("queued")
    host.cancel(b.task.id)
    executions.find((e) => e.task.id === a.task.id)!.finish()
    await new Promise((r) => setTimeout(r, 30))
    expect(executions.filter((e) => botTaskWorkFamily(e.task))).toHaveLength(2)
    expect(
      f.store.recentTasks().filter((t) => ["running", "waiting_user"].includes(t.state))
    ).toHaveLength(2)
    expect(f.store.getTask(peer.id).state).toBe("waiting_user")
  })
})
