import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunPort } from "./host"

const databases: NativeSqliteAdapter[] = []
const hosts: LocalBotHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
  databases.splice(0).forEach((db) => db.close())
})

function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db)
  const input = { name: "Test", instructions: "", color: "#ea2845", modelRef: null }
  const requester = store.create(input),
    bot = store.create(input)
  const root = store.enqueue({ botId: requester.id, requestId: "root", message: "Run once" })
  store.transition(root.id, "running")
  const peer = store.delegate(root.id, bot.id, "Run once and return stdout", "once")
  store.settle(root.id, "completed", null, "Assigned")
  store.transition(peer.id, "running")
  const command = {
    id: "foreground",
    threadId: bot.threadId,
    command: "node test.js",
    cwd: "/test",
    startedAt: 10
  }
  const result = {
    id: command.id,
    threadId: bot.threadId,
    output: "ACTUAL_STDOUT",
    exitCode: 0,
    truncated: false,
    cancelled: false
  }
  return { db, store, requester, bot, peer, command, result }
}

describe("yielded foreground command ownership", () => {
  it("answers private input while holding the original peer task until its real result", () => {
    const { store, bot, peer, requester, command, result } = fixture()
    store.acceptCommand(peer.id, command, true)
    store.deferTask(peer.id, "model-boundary")
    expect(store.nextQueued([])).toBeNull()
    const direct = store.enqueue({ botId: bot.id, requestId: "private", message: "PRIVATE_ONLY" })
    expect(store.nextQueued([])?.id).toBe(direct.id)
    store.transition(direct.id, "running")
    store.settle(direct.id, "completed", null, "43")
    expect(store.nextQueued([])).toBeNull()
    store.flushReplies()
    expect(store.recentTasks().filter((t) => t.requestId === `reply-${peer.id}`)).toEqual([])
    store.settleCommand(result)
    store.settleCommand(result)
    expect(store.nextQueued([])?.id).toBe(peer.id)
    expect(store.continuationCommandResults(peer.id)).toEqual([
      expect.objectContaining({ output: "ACTUAL_STDOUT", state: "completed", exitCode: 0 })
    ])
    expect(store.recentTasks().filter((t) => t.origin.kind === "notification")).toEqual([])
    store.transition(peer.id, "running")
    store.settle(peer.id, "completed", null, "ACTUAL_STDOUT")
    store.flushReplies()
    const reply = store.nextQueued([])!
    expect(reply).toMatchObject({ botId: requester.id })
    expect(reply.message).toContain("ACTUAL_STDOUT")
    expect(reply.message).not.toContain("PRIVATE_ONLY")
  })

  it("retains an early command result before the model checkpoint is deferred", () => {
    const { store, peer, command, result } = fixture()
    store.acceptCommand(peer.id, command, true)
    store.settleCommand(result)
    store.deferTask(peer.id, "saved")
    expect(store.nextQueued([])?.id).toBe(peer.id)
    expect(store.continuationCommandResults(peer.id)[0]).toMatchObject({ output: result.output })
  })

  it("resumes the same routine so its original silence policy can decide the outcome", () => {
    const { store, bot, peer, command, result } = fixture()
    store.settle(peer.id, "completed", null, "Previous")
    const routine = store.enqueue(
      { botId: bot.id, requestId: "routine", message: "Check quietly" },
      { kind: "schedule", scheduleId: "test" }
    )
    store.transition(routine.id, "running")
    store.acceptCommand(routine.id, command, true)
    store.deferTask(routine.id, "routine-saved")
    expect(store.nextQueued([])).toBeNull()
    store.settleCommand(result)
    expect(store.nextQueued([])?.id).toBe(routine.id)
    store.transition(routine.id, "running")
    store.settle(routine.id, "completed", null, "BOT_ROUTINE_SILENT")
    expect(store.recentTasks().filter((t) => t.origin.kind === "notification")).toEqual([])
  })

  it.each(["cancel", "restart"] as const)(
    "never revives the original source after %s",
    (outcome) => {
      const { store, peer, command, result } = fixture()
      store.acceptCommand(peer.id, command, true)
      store.deferTask(peer.id, "saved")
      if (outcome === "restart") store.recover()
      else store.settle(peer.id, "cancelled", null)
      store.settleCommand(result)
      store.flushReplies()
      expect(store.getTask(peer.id).state).toBe(outcome === "restart" ? "interrupted" : "cancelled")
      expect(store.continuationCommandResults(peer.id)).toEqual([])
      expect(store.recentTasks().filter((t) => t.origin.kind === "notification")).toEqual([])
      expect(store.recentTasks().filter((t) => t.requestId === `reply-${peer.id}`)).toHaveLength(1)
      expect(store.activeCommandThreads()).toEqual([])
    }
  )

  it("keeps ordinary command notifications and rejects a user task as a foreground continuation", () => {
    const { store, bot, peer, command, result } = fixture()
    const direct = store.enqueue({ botId: bot.id, requestId: "other", message: "User" })
    expect(() => store.acceptCommand(direct.id, command, true)).toThrow()
    store.acceptCommand(peer.id, { ...command, id: "ordinary" })
    // Existing non-continuation receipts remain notifications, not source resumptions.
    store.settleCommand({ ...result, id: "ordinary" })
    expect(store.recentTasks().filter((t) => t.origin.kind === "notification")).toHaveLength(1)
  })

  it("validates source ownership and bounds untrusted output without promoting it to instructions", () => {
    const { db, store, peer, command, result } = fixture()
    store.acceptCommand(peer.id, command, true)
    store.deferTask(peer.id, "saved")
    store.settleCommand({ ...result, output: "x".repeat(20_000) })
    expect(store.continuationCommandResults(peer.id)[0]).toMatchObject({
      output: "x".repeat(16_000),
      truncated: true
    })
    db.run("UPDATE bot_commands SET bot_id='foreign' WHERE id=?", [command.id])
    expect(store.continuationCommandResults(peer.id)).toEqual([])
  })
  it("protects a paused source's result from both acceptance and idle history cleanup", () => {
    const { db, store, requester, peer, command, result } = fixture()
    store.acceptCommand(peer.id, command, true)
    store.deferTask(peer.id, "saved")
    store.settleCommand(result)
    db.run("UPDATE bot_commands SET updated_at=0 WHERE id=?", [command.id])
    const newer = store.enqueue({
      botId: requester.id,
      requestId: "newer",
      message: "Other commands"
    })
    store.transition(newer.id, "running")
    for (let i = 0; i < 205; i++) {
      const id = `newer-${i}`
      store.acceptCommand(newer.id, { ...command, id, threadId: newer.threadId })
      store.settleCommand({ ...result, id, threadId: newer.threadId })
    }
    store.pruneTaskHistory()
    expect(store.continuationCommandResults(peer.id)).toEqual([
      expect.objectContaining({ output: result.output })
    ])
    store.transition(peer.id, "running")
    store.settle(peer.id, "completed", null, result.output)
    store.pruneTaskHistory()
    expect(db.exec("SELECT id FROM bot_commands WHERE id='foreground'")[0].values).toEqual([])
  })
  it("carries an already persisted stop receipt through restart without exposing it as activity prose", () => {
    const { store, bot, peer, command, result } = fixture()
    store.acceptCommand(peer.id, command, true)
    store.deferTask(peer.id, "saved")
    store.settleCommand({ ...result, cancelled: true, exitCode: 130, output: "Stopped" })
    store.recover()
    store.flushReplies()
    const reply = store.recentTasks().find((task) => task.requestId === `reply-${peer.id}`)!
    expect(reply.message).toContain("以下命令已实际启动")
    expect(reply.message).toContain('"state":"cancelled"')
    expect(store.activities().find((activity) => activity.id === bot.id)?.preview).not.toContain(
      "以下命令"
    )
    expect(store.getTask(peer.id).state).toBe("interrupted")
    store.recover()
    store.flushReplies()
    expect(store.recentTasks().filter((task) => task.requestId === reply.requestId)).toHaveLength(1)
  })
})

const routineActions = ["edit", "pause", "remove"] as const
type RoutineAction = (typeof routineActions)[number]

function routineFixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db, () => 1000)
  const bot = store.create({
    name: "Routine",
    instructions: "",
    color: "#ea2845",
    modelRef: null
  })
  const config = {
    name: "Daily report",
    message: "Verify and deliver the original report",
    frequency: "daily" as const,
    runAtTime: "09:00",
    enabled: true
  }
  const schedule = store.saveSchedule(bot.id, config, "2030-01-01T09:00:00Z")
  const enqueue = (requestId = "original-routine") =>
    store.enqueue(
      { botId: bot.id, requestId, message: config.message },
      { kind: "schedule", scheduleId: schedule.id }
    )
  const command = {
    id: "routine-command",
    threadId: bot.threadId,
    command: "synthetic command (never executed)",
    cwd: "/synthetic",
    startedAt: 10
  }
  const result = {
    id: command.id,
    threadId: command.threadId,
    output: "VERIFIED_REPORT",
    exitCode: 0,
    truncated: false,
    cancelled: false
  }
  const files = [{ filePath: "/synthetic/report.md", name: "report.md", size: 15 }]
  return { db, store, bot, config, schedule, enqueue, command, result, files }
}

function changeRoutine(context: ReturnType<typeof routineFixture>, action: RoutineAction) {
  const { store, bot, config, schedule } = context
  const current = store.schedules().find((item) => item.id === schedule.id)!
  if (action === "remove") store.removeSchedule(current.id, current.version)
  else
    store.saveSchedule(
      bot.id,
      action === "pause" ? { ...config, enabled: false } : { ...config, message: "New scope" },
      action === "pause" ? null : "2030-01-02T09:00:00Z",
      current
    )
}

describe("routine changes during foreground continuation", () => {
  it.each(
    routineActions.flatMap((action) =>
      (["queued", "running", "waiting_user", "checkpoint", "command"] as const).map((state) => ({
        action,
        state
      }))
    )
  )("$action only cancels an unstarted trigger ($state)", ({ action, state }) => {
    const context = routineFixture()
    const { store, bot, enqueue, files, command } = context
    const task = enqueue()
    const user = store.enqueue({ botId: bot.id, requestId: "user-control", message: "Keep user" })
    const other = store.enqueue(
      { botId: bot.id, requestId: "other-routine", message: "Keep other routine" },
      { kind: "schedule", scheduleId: "other-schedule" }
    )
    if (state !== "queued") store.transition(task.id, "running")
    if (state === "waiting_user") store.transition(task.id, "waiting_user")
    if (state === "command") store.acceptCommand(task.id, command, true)
    if (state === "checkpoint" || state === "command") store.deferTask(task.id, "saved", files)
    changeRoutine(context, action)
    expect(store.getTask(task.id)).toMatchObject({
      state:
        state === "queued"
          ? "cancelled"
          : state === "checkpoint" || state === "command"
            ? "queued"
            : state,
      message: context.config.message
    })
    expect(store.getTask(user.id).state).toBe("queued")
    expect(store.getTask(other.id).state).toBe("queued")
    expect(store.taskCheckpoint(task.id)).toBe(
      state === "checkpoint" || state === "command" ? "saved" : undefined
    )
    expect(store.continuationFiles(task.id)).toEqual(
      state === "checkpoint" || state === "command" ? files : []
    )
    expect(store.activeCommandThreads()).toEqual(state === "command" ? [bot.threadId] : [])
  })

  it.each(routineActions)(
    "resumes and delivers the same accepted command after %s without a duplicate trigger",
    async (action) => {
      const context = routineFixture()
      const { store, command, result, files, enqueue, schedule } = context
      const executions: string[] = []
      const settled = vi.fn()
      const errors = vi.fn()
      let host!: LocalBotHost
      const runtime: BotRunPort = {
        onAvailable: () => () => {},
        onSettled: settled,
        acquire: (_bot, task) => ({
          release: () => undefined,
          execute: async () => {
            const checkpoint = store.taskCheckpoint(task.id)
            executions.push(checkpoint ? "resume" : "start")
            if (!checkpoint) {
              host.commandLifecycle(task.id, true).accepted(command)
              return { state: "deferred", checkpointId: "saved", files }
            }
            expect(checkpoint).toBe("saved")
            expect(store.continuationFiles(task.id)).toEqual(files)
            expect(store.continuationCommandResults(task.id)).toEqual([
              expect.objectContaining({ output: result.output, state: "completed", exitCode: 0 })
            ])
            return { state: "completed", result: "Verified original report", files }
          }
        })
      }
      host = new LocalBotHost(store, runtime, 1, errors)
      hosts.push(host)
      const task = enqueue()
      await vi.waitFor(() => expect(store.taskCheckpoint(task.id)).toBe("saved"))
      changeRoutine(context, action)
      const latest = store.schedules().find((item) => item.id === schedule.id)
      store.fireSchedule(latest ?? schedule, "2030-01-03T09:00:00Z")
      expect(store.recentTasks()).toHaveLength(1)
      expect(store.getTask(task.id).state).toBe("queued")
      expect(store.nextQueued([])).toBeNull()
      expect(store.activeCommandThreads()).toEqual([command.threadId])
      const lifecycle = host.commandLifecycle(task.id, true)
      lifecycle.settled(result)
      lifecycle.settled(result)
      await vi.waitFor(() => expect(store.getTask(task.id).state).toBe("completed"))
      expect(executions).toEqual(["start", "resume"])
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: task.id }),
        "completed",
        "Verified original report",
        files
      )
      expect(store.recentTasks()).toHaveLength(1)
      expect(store.activeCommandThreads()).toEqual([])
      expect(store.taskCheckpoint(task.id)).toBeUndefined()
      expect(errors).not.toHaveBeenCalled()
    }
  )

  it("still requires the exact stop receipt when explicitly cancelling a removed routine's run", async () => {
    const context = routineFixture()
    const { store, enqueue, command, result, bot } = context
    let release!: () => void
    const cancelCommands = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const host = new LocalBotHost(store, {
      acquire: () => null,
      onAvailable: () => () => {},
      cancelCommands
    })
    hosts.push(host)
    const task = enqueue()
    store.transition(task.id, "running")
    store.acceptCommand(task.id, command, true)
    store.deferTask(task.id, "saved")
    changeRoutine(context, "remove")
    const other = store.enqueue({ botId: bot.id, requestId: "private-control", message: "Keep" })
    host.cancel(task.id)
    host.cancel(task.id)
    await vi.waitFor(() =>
      expect(cancelCommands).toHaveBeenCalledExactlyOnceWith(bot.threadId, [command.id])
    )
    expect(store.getTask(task.id).state).toBe("queued")
    host.commandLifecycle(task.id, true).settled({ ...result, cancelled: true, exitCode: 130 })
    expect(store.getTask(task.id).state).toBe("queued")
    release()
    await vi.waitFor(() => expect(store.getTask(task.id).state).toBe("cancelled"))
    expect(store.getTask(other.id).state).toBe("queued")
    expect(store.activeCommandThreads()).toEqual([])
    expect(store.taskCheckpoint(task.id)).toBeUndefined()
    expect(store.recentTasks().filter((item) => item.origin.kind === "notification")).toEqual([])
  })

  it.each(routineActions)(
    "interrupts rather than replays a preserved %s continuation after restart",
    (action) => {
      const context = routineFixture()
      const { store, enqueue, command, result } = context
      const task = enqueue()
      store.transition(task.id, "running")
      store.acceptCommand(task.id, command, true)
      store.deferTask(task.id, "saved")
      changeRoutine(context, action)
      store.recover()
      store.settleCommand(result)
      store.recover()
      expect(store.getTask(task.id).state).toBe("interrupted")
      expect(store.taskCheckpoint(task.id)).toBeUndefined()
      expect(store.continuationCommandResults(task.id)).toEqual([])
      expect(store.nextQueued([])).toBeNull()
      expect(store.recentTasks()).toHaveLength(1)
      expect(store.activeCommandThreads()).toEqual([])
    }
  )
})
