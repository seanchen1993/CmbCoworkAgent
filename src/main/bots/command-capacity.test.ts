import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import type { BotTask } from "../../shared/bots/contracts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  cleanups.push(() => db.close())
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const other = store.create({ name: "Other", instructions: "", color: "#123456", modelRef: null })
  const start = (id = "command", source?: BotTask) => {
    const task = source ?? store.enqueue({ botId: bot.id, requestId: `source-${id}`, message: "Generate report" })
    store.transition(task.id, "running")
    const command = { id, threadId: task.threadId, command: "node report.mjs", cwd: "/synthetic", startedAt: Date.now() }
    store.acceptCommand(task.id, command)
    store.settle(task.id, "completed", null, "Started", undefined, true)
    const result = { id, threadId: task.threadId, output: `RESULT-${id}`, exitCode: 7, truncated: false, cancelled: false }
    return { task, command, result }
  }
  const fill = (count = 500) => Array.from({ length: count }, (_, i) => store.enqueue({ botId: other.id, requestId: `queued-${i}`, message: "Unrelated work" }))
  const notices = () => store.recentTasks().filter(t => t.origin.kind === "notification" && t.origin.notificationKind === "command")
  return { db, store, bot, other, start, fill, notices }
}

it.each([false, true])("defers the exact settled receipt at capacity, including recovery=%s", (restart) => {
  const f = fixture()
  const { result } = f.start()
  const queued = f.fill()
  expect(() => f.store.enqueue({ botId: f.other.id, requestId: "overflow", message: "Extra" })).toThrow("待办队列已满")
  expect(() => f.store.settleCommand(result)).not.toThrow()
  expect(f.store.activeCommandThreads()).toEqual([])
  expect(f.notices()).toHaveLength(0)
  const store = restart ? new BotStore(f.db) : f.store
  if (restart) store.recover()
  store.flushReplies()
  expect(f.notices()).toHaveLength(0)
  store.transition(queued[0].id, "cancelled")
  store.flushReplies()
  const notice = f.notices()[0]
  expect(notice.message).toContain("RESULT-command")
  expect(notice.message).toContain('"exitCode":7')
  expect(notice.origin).toMatchObject({ key: result.id, commandSucceeded: false })
  expect(() => store.enqueue({ botId: f.other.id, requestId: "still-full", message: "Extra" })).toThrow("待办队列已满")
  store.settleCommand(result)
  store.flushReplies()
  expect(f.notices()).toHaveLength(1)
  store.transition(notice.id, "running")
  store.settle(notice.id, "completed", null, "Failed with exit 7")
  store.flushReplies()
  expect(f.notices()).toHaveLength(1)
})

it("keeps the Host usable and delivers once when a slot opens, without rerunning the command", async () => {
  const f = fixture(), runs: BotTask[] = [], errors: unknown[] = []
  const host = new LocalBotHost(f.store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => task.botId === f.other.id ? null : {
      release() {},
      async execute() { runs.push(task); return { state: "completed", result: "Reported exit 7" } }
    }
  }, 2, error => errors.push(error))
  cleanups.push(() => host.stop())
  const { task, result } = f.start()
  const queued = f.fill()
  expect(() => host.commandLifecycle(task.id).settled(result)).not.toThrow()
  host.cancel(queued[0].id)
  await vi.waitFor(() => expect(runs).toHaveLength(1))
  expect(runs[0].origin).toMatchObject({ kind: "notification", key: result.id })
  expect(runs[0].message).toContain("RESULT-command")
  host.commandLifecycle(task.id).settled(result)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(runs).toHaveLength(1)
  expect(errors).toEqual([])
  expect(() => host.send({ botId: f.other.id, requestId: "host-alive", message: "New request" })).not.toThrow()
})

it("refills capacity when delayed user-message injection frees a slot during a long run", async () => {
  const f = fixture(), runs: BotTask[] = [], errors: unknown[] = []
  let inject: (() => boolean) | undefined
  let finishSteer: ((value: boolean) => void) | undefined
  const host = new LocalBotHost(f.store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({
      release() {},
      steer: async (_incoming, beforeInject) => {
        inject = beforeInject
        return new Promise<boolean>(resolve => { finishSteer = resolve })
      },
      async execute(signal) {
        if (task.requestId === "long-run") {
          host.onSteeringReady(task.id)
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        } else runs.push(task)
        return { state: "completed", result: "Finished" }
      }
    })
  }, 2, error => errors.push(error))
  cleanups.push(() => host.stop())
  const long = host.send({ botId: f.other.id, requestId: "long-run", message: "Keep working" })
  await vi.waitFor(() => expect(f.store.getTask(long.id).state).toBe("running"))
  const { task, result } = f.start()
  f.fill(499)
  const addition = host.send({ botId: f.other.id, requestId: "additional-input", message: "A clarification" })
  host.commandLifecycle(task.id).settled(result)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.store.getTask(addition.id).state).toBe("queued")
  expect(f.store.hasPendingCommandNotifications()).toBe(true)
  expect(inject!()).toBe(true)
  finishSteer!(true)
  await vi.waitFor(() => expect(runs).toHaveLength(1))
  expect(runs[0].origin).toMatchObject({ kind: "notification", key: result.id })
  expect(f.store.getTask(long.id).state).toBe("running")
  expect(f.store.getTask(addition.id).state).toBe("running")
  expect(errors).toEqual([])
})

it("recovers an interrupted source's unknown command once even when the queue is full", () => {
  const f = fixture()
  const task = f.store.enqueue({ botId: f.bot.id, requestId: "crash", message: "Run" })
  f.store.transition(task.id, "running")
  f.store.acceptCommand(task.id, { id: "unknown", threadId: task.threadId, command: "run", cwd: "/synthetic", startedAt: 1 })
  const queued = f.fill()
  const reopened = new BotStore(f.db)
  expect(() => reopened.recover()).not.toThrow()
  expect(reopened.getTask(task.id).state).toBe("interrupted")
  expect(reopened.activeCommandThreads()).toEqual([])
  reopened.transition(queued[0].id, "cancelled")
  reopened.flushReplies()
  expect(f.notices()).toHaveLength(1)
  expect(f.notices()[0].origin).toMatchObject({ key: "unknown", commandSucceeded: false })
  expect(f.notices()[0].message).toContain('"state":"outcome_unknown"')
  reopened.recover()
  reopened.flushReplies()
  expect(f.notices()).toHaveLength(1)
})

it("application shutdown preserves a finished pending result on a thread with another live command", async () => {
  const f = fixture()
  const host = new LocalBotHost(f.store, { onAvailable: () => () => {}, acquire: () => null })
  cleanups.push(() => host.stop())
  const task = f.store.enqueue({ botId: f.bot.id, requestId: "parallel", message: "Check both" })
  f.store.transition(task.id, "running")
  for (const id of ["finished", "live"])
    f.store.acceptCommand(task.id, { id, threadId: task.threadId, command: id, cwd: "/synthetic", startedAt: 1 })
  f.store.settle(task.id, "completed", null, "Started", undefined, true)
  const queued = f.fill()
  f.store.settleCommand({ id: "finished", threadId: task.threadId, output: "actual failure", exitCode: 7, cancelled: false, truncated: false })
  await host.stop()
  const reopened = new BotStore(f.db)
  reopened.recover()
  reopened.transition(queued[0].id, "cancelled")
  reopened.flushReplies()
  expect(f.notices()).toHaveLength(1)
  expect(f.notices()[0].origin).toMatchObject({ key: "finished", commandSucceeded: false })
  expect(f.notices()[0].message).toContain("actual failure")
})

it.each(["thread", "task", "run", "archive"] as const)("explicit %s stop withdraws pending results without affecting another owner", mode => {
  const f = fixture()
  const first = f.start("stopped")
  const second = f.start("kept", f.store.enqueue({ botId: f.other.id, requestId: "other-source", message: "Independent" }))
  const queued = f.fill()
  f.store.settleCommand(first.result)
  f.store.settleCommand(second.result)
  if (mode === "thread") f.store.suppressCommands(first.task.threadId)
  else if (mode === "task") f.store.stopTaskPeers(first.task.id)
  else if (mode === "run") expect(f.store.stopRunCommands(first.task.threadId, [first.result.id])).toEqual([])
  else {
    const archived = f.store.update({ ...f.bot, expectedVersion: f.bot.version, archived: true })
    f.store.update({ ...archived, expectedVersion: archived.version, archived: false })
  }
  for (const task of queued.slice(0, 2)) f.store.transition(task.id, "cancelled")
  new BotStore(f.db).flushReplies()
  expect(f.notices().map(t => t.origin.kind === "notification" && t.origin.key)).toEqual(["kept"])
})

it("keeps work busy until its deferred result is handled or explicitly stopped", () => {
  const f = fixture()
  const { work, task } = f.store.createWork({ botId: f.bot.id, operationId: "create", title: "Report", goal: "Generate report" })
  const { result } = f.start("work", task)
  const queued = f.fill()
  f.store.settleCommand(result)
  expect(f.store.getWork(f.bot.id, work.id).backgroundBusy).toBe(true)
  expect(() => f.store.changeWork(f.bot.id, work.id, work.version, "complete", "complete")).toThrow("后台")
  f.store.stopTaskPeers(task.id)
  expect(f.store.getWork(f.bot.id, work.id).backgroundBusy).toBe(false)
  f.store.transition(queued[0].id, "cancelled")
  f.store.flushReplies()
  expect(f.notices()).toHaveLength(0)
})

it("pending outcomes survive receipt pruning and drain in bounded batches without losing early failures", () => {
  const f = fixture()
  const task = f.store.enqueue({ botId: f.bot.id, requestId: "many", message: "Check results" })
  f.store.transition(task.id, "running")
  const queued = f.fill()
  for (let i = 0; i < 205; i++) {
    const id = `receipt-${String(i).padStart(3, "0")}`
    f.store.acceptCommand(task.id, { id, threadId: task.threadId, command: id, cwd: "/synthetic", startedAt: i })
    f.store.settleCommand({ id, threadId: task.threadId, output: `unique-${i}`, exitCode: i === 0 ? 7 : 0, cancelled: false, truncated: false })
  }
  f.store.settle(task.id, "completed", null, "Started", undefined, true)
  const reopened = new BotStore(f.db)
  reopened.recover()
  for (const task of queued) reopened.transition(task.id, "cancelled")
  reopened.flushReplies()
  const queuedNotices = () => reopened.recentTasks().filter(t => t.origin.kind === "notification")
  expect(queuedNotices()).toHaveLength(16)
  for (let i = 0; i < 13; i++) reopened.flushReplies()
  const results = queuedNotices()
  expect(results).toHaveLength(205)
  expect(new Set(results.map(t => t.requestId)).size).toBe(205)
  expect(results.find(t => t.origin.kind === "notification" && t.origin.key === "receipt-000")).toMatchObject({
    origin: { commandSucceeded: false }, message: expect.stringContaining("unique-0")
  })
})

it("still rolls back genuine receipt persistence failures instead of disguising them as backpressure", () => {
  const f = fixture(), { result } = f.start()
  const original = f.db.run.bind(f.db)
  const spy = vi.spyOn(f.db, "run").mockImplementation((sql, args) => {
    if (sql.startsWith("UPDATE bot_commands SET pending_notification=")) throw new Error("disk failure")
    return original(sql, args)
  })
  expect(() => f.store.settleCommand(result)).toThrow("disk failure")
  spy.mockRestore()
  expect(f.store.activeCommandThreads()).toEqual([result.threadId])
  f.store.settleCommand(result)
  expect(f.notices()).toHaveLength(1)
})

it.each([[false, false], [true, false], [false, true], [true, true]])("distinguishes active-turn shutdown from explicit Stop (shutdown=%s, admitted=%s)", async (shutdown, admitted) => {
  const f = fixture()
  let launched = false
  const host = new LocalBotHost(f.store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => task.botId === f.other.id ? null : {
      release() {},
      async execute(signal) {
        const lifecycle = host.commandLifecycle(task.id)
        lifecycle.accepted({ id: "active-finished", threadId: task.threadId, command: "run", cwd: "/synthetic", startedAt: 1 })
        f.fill()
        lifecycle.settled({ id: "active-finished", threadId: task.threadId, output: "REAL-RESULT", exitCode: 0, truncated: false, cancelled: false })
        launched = true
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        return { state: "completed", result: "aborted" }
      }
    }
  })
  cleanups.push(() => host.stop())
  const source = host.send({ botId: f.bot.id, requestId: "active-source", message: "Run" })
  await vi.waitFor(() => expect(launched).toBe(true))
  expect(f.store.getTask(source.id).state).toBe("running")
  expect(host.snapshot().backgroundThreads).toContain(f.bot.threadId)
  if (admitted) {
    const filler = f.store.recentTasks().find(t => t.state === "queued" && t.botId === f.other.id)!
    host.cancel(filler.id)
    await vi.waitFor(() => expect(f.notices()[0]?.state).toBe("queued"))
  }
  if (shutdown) await host.stop()
  else {
    host.stopConversation(f.bot.id)
    await vi.waitFor(() => expect(host.hasActiveRuns()).toBe(false))
    await host.stop()
  }
  const reopened = new BotStore(f.db)
  reopened.recover()
  const filler = reopened.recentTasks().find(t => t.state === "queued" && t.botId === f.other.id)!
  reopened.transition(filler.id, "cancelled")
  reopened.flushReplies()
  expect(f.notices()).toHaveLength(shutdown || admitted ? 1 : 0)
  if (shutdown || admitted) expect(f.notices()[0].state).toBe(shutdown ? "queued" : "cancelled")
  if (shutdown) expect(f.notices()[0].message).toContain("REAL-RESULT")
})

it.each([false, true])("keeps a pending result in its group and withdraws it when its owner leaves (leave=%s)", leave => {
  const f = fixture()
  const group = f.store.saveGroup({ name: "Capacity", memberIds: [f.bot.id, f.other.id] })
  f.store.sendGroup({ groupId: group.id, requestId: "group-source", text: "Generate report", targetBotIds: [f.bot.id] })
  const task = f.store.recentTasks().find(t => t.origin.kind === "group")!
  const { result } = f.start("group-result", task)
  const queued = f.fill()
  f.store.settleCommand(result)
  if (leave) f.store.saveGroup({ ...group, memberIds: [f.other.id] }, { id: group.id, version: group.version })
  f.store.transition(queued[0].id, "cancelled")
  f.store.flushReplies()
  expect(f.notices()).toHaveLength(leave ? 0 : 1)
  if (!leave) expect(f.notices()[0]).toMatchObject({ threadId: task.threadId, origin: { groupId: group.id, key: result.id } })
})

it.each(["retained", "silent"] as const)("does not turn %s commands into independent notifications at capacity", mode => {
  const f = fixture()
  const root = f.store.enqueue({ botId: f.other.id, requestId: "owner", message: "Run" })
  f.store.transition(root.id, "running")
  const peer = f.store.delegate(root.id, f.bot.id, "Check", "peer")
  f.store.transition(peer.id, "running")
  const command = { id: mode, threadId: peer.threadId, command: "check", cwd: "/synthetic", startedAt: 1,
    ...(mode === "silent" ? { notifyOnComplete: false } : {}) }
  f.store.acceptCommand(peer.id, command, mode === "retained")
  const queued = f.fill()
  f.store.settleCommand({ id: mode, threadId: peer.threadId, output: "EXACT", exitCode: 7, cancelled: false, truncated: false })
  f.store.transition(queued[0].id, "cancelled")
  f.store.flushReplies()
  expect(f.notices()).toHaveLength(0)
  if (mode === "retained") expect(f.store.continuationCommandResults(peer.id)).toMatchObject([{ task_id: mode, exitCode: 7, output: "EXACT" }])
})

it("skips a withdrawn full batch and wakes again for the next valid saved result", async () => {
  const f = fixture()
  const group = f.store.saveGroup({ name: "Old group", memberIds: [f.bot.id, f.other.id] })
  f.store.sendGroup({ groupId: group.id, requestId: "old-room", text: "Run", targetBotIds: [f.bot.id] })
  const source = f.store.recentTasks().find(t => t.origin.kind === "group")!
  f.store.transition(source.id, "running")
  const valid = f.start("valid")
  const queued = f.fill()
  for (let i = 0; i < 16; i++) {
    const id = `departed-${i}`
    f.store.acceptCommand(source.id, { id, threadId: source.threadId, command: id, cwd: "/synthetic", startedAt: i })
    f.store.settleCommand({ id, threadId: source.threadId, exitCode: 0, output: id, cancelled: false, truncated: false })
  }
  f.store.settleCommand(valid.result)
  f.store.settle(source.id, "completed", null, "Started", undefined, true)
  // Persisted membership may already have changed before the next Host starts.
  f.store.saveGroup({ ...group, memberIds: [f.other.id] }, { id: group.id, version: group.version })
  for (const task of queued.slice(0, 20)) f.store.transition(task.id, "cancelled")
  const runs: BotTask[] = []
  const host = new LocalBotHost(new BotStore(f.db), {
    onAvailable: () => () => {},
    acquire: (_bot, task) => task.botId === f.other.id ? null : {
      release() {}, async execute() { runs.push(task); return { state: "completed", result: "Reported" } }
    }
  })
  cleanups.push(() => host.stop())
  await vi.waitFor(() => expect(runs).toHaveLength(1))
  expect(runs[0].origin).toMatchObject({ key: "valid" })
  expect(f.notices()).toHaveLength(1)
})


it("uses capacity released by dispatch without waiting for an unrelated long task to end", async () => {
  const f = fixture()
  const { result } = f.start()
  f.fill()
  f.store.settleCommand(result)
  const runs: BotTask[] = []
  const host = new LocalBotHost(f.store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({
      release() {},
      async execute(signal) {
        runs.push(task)
        if (task.botId === f.other.id)
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        return { state: "completed", result: "Reported" }
      }
    })
  }, Number.POSITIVE_INFINITY)
  cleanups.push(() => host.stop())
  await vi.waitFor(() => expect(runs.some(t => t.origin.kind === "notification")).toBe(true))
  expect(runs).toHaveLength(2)
  expect(f.store.getTask(runs.find(t => t.botId === f.other.id)!.id).state).toBe("running")
  expect(f.notices()).toHaveLength(1)
  expect(f.notices()[0].message).toContain("RESULT-command")
})


it.each(["member", "bot-delete", "group-delete", "schedule-disable", "schedule-delete", "mock-revoke", "archive"] as const)(
  "resumes unrelated saved results after %s releases queued capacity", async action => {
    const f = fixture(), { result } = f.start()
    const group = f.store.saveGroup({ name: "Queued group", memberIds: [f.bot.id, f.other.id] })
    const config = { name: "Queued routine", message: "Check", frequency: "once" as const,
      runAt: "2030-01-01T00:00:00Z", enabled: true }
    const routine = f.store.saveSchedule(f.other.id, config, config.runAt)
    const binding = f.store.mock.create({ simulation: true, botId: f.other.id, operationId: "bind",
      kind: "group", channelKey: "channel", label: "Channel", allowedSenderIds: ["alice"] })
    if (action === "member" || action === "group-delete")
      f.store.sendGroup({ groupId: group.id, requestId: "queued-group", text: "Run", targetBotIds: [f.other.id] })
    else if (action.startsWith("schedule")) f.store.fireSchedule(routine, null)
    else if (action === "mock-revoke") f.store.mock.inject({ simulation: true, bindingId: binding.id,
      eventId: "event", messageId: "message", senderId: "alice", text: "Run", mentionsBotIds: [f.other.id] })
    else f.store.enqueue({ botId: f.other.id, requestId: "target", message: "Run" })
    f.fill(499)
    f.store.settleCommand(result)
    const runs: BotTask[] = []
    const host = new LocalBotHost(f.store, {
      onAvailable: () => () => {},
      acquire: (_bot, task) => task.botId === f.other.id ? null : {
        release() {}, async execute() { runs.push(task); return { state: "completed", result: "Reported" } }
      }
    }, 2, () => {}, () => null)
    cleanups.push(() => host.stop())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runs).toHaveLength(0)
    expect(f.store.hasPendingCommandNotifications()).toBe(true)
    if (action === "member") host.saveGroup({ ...group, memberIds: [f.bot.id] }, group)
    else if (action === "group-delete") await host.removeGroup(group.id, group.version, async () => {})
    else if (action === "bot-delete") await host.remove(f.other.id, f.other.version, async () => {})
    else if (action === "archive") host.update({ ...f.other, expectedVersion: f.other.version, archived: true })
    else if (action === "mock-revoke") host.revokeMockBinding(f.other.id, binding.id, binding.grantVersion)
    else if (action === "schedule-delete") host.removeSchedule(routine.id, f.store.schedules().find(s => s.id === routine.id)!.version)
    else host.saveSchedule(f.other.id, { ...config, enabled: false }, f.store.schedules().find(s => s.id === routine.id)!)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0].origin).toMatchObject({ kind: "notification", key: result.id })
    expect(runs[0].message).toContain("RESULT-command")
  }
)

it("refills capacity released by retiring an invalid group post inside the pump", async () => {
  const f = fixture()
  const poster = f.store.create({ name: "Poster", instructions: "", color: "#123456", modelRef: null })
  const group = f.store.saveGroup({ name: "Posted group", memberIds: [poster.id, f.other.id] })
  const post = f.store.enqueue({ botId: poster.id, requestId: "post", message: "Post in group" })
  f.store.transition(post.id, "running")
  f.store.publishGroupMessage(post.id, "post-call", "@Other please investigate", group.id)
  f.store.settle(post.id, "completed", null, "Posted")
  const seed = f.store.recentTasks().find(t => t.requestId.startsWith("group-post-"))!
  const { result } = f.start()
  f.fill(499)
  f.store.settleCommand(result)
  const runs: BotTask[] = []
  const host = new LocalBotHost(f.store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => task.botId !== f.bot.id ? null : {
      release() {}, async execute() { runs.push(task); return { state: "completed", result: "Reported" } }
    }
  })
  cleanups.push(() => host.stop())
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(f.store.getTask(seed.id).state).toBe("queued")
  host.update({ ...poster, expectedVersion: poster.version, archived: true })
  await vi.waitFor(() => expect(runs).toHaveLength(1))
  expect(f.store.getTask(seed.id).state).toBe("cancelled")
  expect(runs[0].origin).toMatchObject({ kind: "notification", key: result.id })
})
