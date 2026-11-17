import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveBotWorkStatus } from "../../renderer/src/lib/bot/work-status"
import type { BotSchedule, BotScheduleInput } from "../../shared/bots/contracts"
import type { BotScheduledWorkSnapshot, BotWorkScheduleMonitorInput } from "../../shared/bots/schedule-observation"
import { BOT_ROUTINE_SILENT } from "../../shared/bots/routine-silence"
import { parseSchedule } from "../../shared/bots/validation"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { LocalBotHost, type BotRunPort } from "./host"
import { BotStore } from "./store"
import { createBotScheduleTools } from "./tools"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

function fixture(runtime?: Partial<BotRunPort>) {
  let now = Date.parse("2030-01-01T00:00:00Z")
  vi.spyOn(Date, "now").mockImplementation(() => now)
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db, () => now)
  const createHost = (target: BotStore, runtime?: Partial<BotRunPort>) =>
    new LocalBotHost(
      target,
      { acquire: () => null, onAvailable: () => () => {}, ...runtime },
      2,
      vi.fn(),
      (input, from) =>
        input.runAt ?? new Date(Math.max(now, from.getTime()) + (input.intervalMinutes ?? 10) * 60_000).toISOString()
    )
  const hosts = [createHost(store, runtime)]
  cleanups.push(async () => {
    for (const host of hosts.reverse()) await host.stop()
    db.close()
  })
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const { work, task } = store.createWork(
    {
      botId: bot.id,
      operationId: "work",
      title: "Report",
      goal: "Prepare the report"
    },
    undefined,
    { kind: "project", projectId: "report", projectName: "Report", path: "/reports" }
  )
  store.transition(task.id, "running")
  store.settle(task.id, "completed", null)
  return {
    bot,
    work,
    task,
    db,
    store,
    host: hosts[0],
    binding: { workId: work.id, operationId: "schedule-request" },
    advance(ms: number) {
      now += ms
    },
    reopen(runtime?: Partial<BotRunPort>) {
      const reopened = new BotStore(db, () => now)
      const host = createHost(reopened, runtime)
      hosts.push(host)
      return { host, store: reopened }
    },
    triggers() {
      return store.recentTasks().filter((task) => task.origin.kind === "schedule")
    }
  }
}

const interval: BotScheduleInput = {
  name: "Update report",
  message: "Update the existing report from its saved inputs",
  frequency: "interval",
  intervalMinutes: 10,
  enabled: true
}
const DAY = 24 * 60 * 60 * 1000

it.each(["user", "introduction"] as const)("anchors relative schedules to a consumed user input in a %s run", async origin => {
  const f = fixture({
    scheduleObservationPublication: { persist() {}, async announce() {} },
    acquire: (_bot, task) => !task.workId && ["user", "introduction"].includes(task.origin.kind) ? {
      release() {},
      execute: signal => new Promise(resolve => {
        signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true })
      })
    } : null
  })
  // Introductions only start for a new Bot with no task history.
  const bot = origin === "introduction"
    ? f.store.create({ name: "New owner", instructions: "", color: "#123456", modelRef: null })
    : f.bot
  if (origin === "introduction") f.host.introduce(bot.id)
  else f.host.send({ botId: bot.id, requestId: "long-main", message: "Help me plan" })
  await vi.waitFor(() => expect(f.store.recentTasks().some(t => !t.workId && t.origin.kind === origin && t.state === "running")).toBe(true))
  const parent = f.store.recentTasks().find(t => !t.workId && t.origin.kind === origin && t.state === "running")!
  const work = origin === "introduction"
    ? f.store.createWork({ botId: bot.id, operationId: "intro-work", title: "Report", goal: "Prepare report" }).work
    : f.work
  const [tool] = createBotScheduleTools(bot, parent, () => f.host, new AbortController().signal)
  f.advance(600_000)
  const user = f.store.enqueue({ botId: bot.id, requestId: "later-user", message: "In one minute, check this work once" })
  f.store.recordPreparedInput(user.id, user.message)
  f.store.injectIntoRun(user.id, parent.id)
  const args = { action: "save", name: "Later check", afterSeconds: 60, requestKey: "relative-observation",
    workMonitor: { workId: work.id, mode: "report" } }
  const save = async (id: string) => {
    const result = await tool.invoke({ type: "tool_call", name: tool.name, id, args })
    expect(result.status, String(result.content)).not.toBe("error")
    return JSON.parse(String(result.content)) as BotSchedule
  }
  const first = await save("relative-first")
  expect(first.runAt).toBe("2030-01-01T00:11:00.000Z")
  f.advance(20_000)
  expect((await save("relative-retry")).id).toBe(first.id)
  expect(f.store.schedules()).toHaveLength(1)
  expect(f.store.schedules()[0].runAt).toBe(first.runAt)
})

function fillRecentHistory(f: ReturnType<typeof fixture>, suffix = "") {
  for (let i = 0; i < 100; i++) {
    const task = f.store.enqueue({ botId: f.bot.id, requestId: `ordinary-${i}${suffix}`, message: "Unrelated chat" })
    f.store.transition(task.id, "running")
    f.store.settle(task.id, "completed", null)
  }
}

it("keeps fixed reminder and observation titles on the port without an Agent stream", () => {
  const source = readFileSync(new URL("./local-service.ts", import.meta.url), "utf8")
  const announce = /announce: \(publication\) => announceBotResultMessage\(\{([^]*?)\n\s*\}\)/.exec(source)?.[1]
  expect(announce).toContain('notificationTitle: publication.reminder ? "提醒" : "例行观察"')
  expect(announce).toMatch(/\n\s*mirrorTranscript: false\s*$/)
})

it.each([
  { kind: "observation", entry: "panel" },
  { kind: "observation", entry: "tool" },
  { kind: "observation", entry: "tool with unchanged monitor" },
  { kind: "work execution", entry: "panel" },
  { kind: "work execution", entry: "tool" }
] as const)("preserves the $kind interval deadline when renaming it through the $entry", async ({ kind, entry }) => {
  const f = fixture({
    scheduleObservationPublication: { persist() {}, async announce() {} },
    acquire: (_bot, task) => task.origin.kind === "user" && !task.workId ? {
      release() {},
      execute: signal => new Promise(resolve => {
        signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true })
      })
    } : null
  })
  const request = f.host.send({ botId: f.bot.id, requestId: "schedule-edit-source", message: "Schedule this work" })
  await vi.waitFor(() => expect(f.store.getTask(request.id).state).toBe("running"))
  const [tool] = createBotScheduleTools(f.bot, request, () => f.host, new AbortController().signal)
  const save = async (requestKey: string, fields: object): Promise<BotSchedule> => {
    const response = await tool.invoke({
      type: "tool_call", name: tool.name, id: requestKey, args: { action: "save", requestKey, ...fields }
    })
    expect(response.status, String(response.content)).not.toBe("error")
    return JSON.parse(String(response.content))
  }

  const workMonitor = { workId: f.work.id, mode: "report" as const, expiresAt: "2030-01-01T00:15:00Z" }
  const original = await save("create", {
    ...interval,
    ...(kind === "observation" ? { workMonitor } : { workId: f.work.id })
  })
  const due = "2030-01-01T00:10:00.000Z"
  expect(original.nextRunAt).toBe(due)
  f.advance(8 * 60_000)
  const name = "Report audit"
  const renamed = entry === "panel"
    ? f.host.saveSchedule(f.bot.id, parseSchedule({ ...original, name }), { id: original.id, version: original.version })
    : await save("rename", { id: original.id, name, ...(entry === "tool with unchanged monitor" ? { workMonitor } : {}) })
  expect.soft(renamed).toMatchObject({ id: original.id, name, nextRunAt: due, sourceTaskId: original.sourceTaskId })
  if (kind === "observation") expect(renamed.workMonitor).toEqual(original.workMonitor)

  f.advance(2 * 60_000)
  f.host.resume()
  const triggers = f.triggers()
  expect.soft(triggers).toMatchObject([{
    state: kind === "observation" ? "completed" : "queued",
    origin: { kind: "schedule", scheduleId: original.id }
  }])
  expect.soft(triggers[0]?.workId).toBe(kind === "observation" ? undefined : f.work.id)
  if (kind === "observation") {
    expect(f.store.pendingScheduledWorkPublications()).toMatchObject([{
      threadId: f.bot.threadId, createdAt: Date.parse(due)
    }])
  }
})

it("recalculates deadlines for explicit interval changes, resuming a pause, and ordinary interval edits", () => {
  const f = fixture()
  const ordinary = f.host.saveSchedule(f.bot.id, interval)
  const managed = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
  f.advance(8 * 60_000)

  expect(f.host.saveSchedule(f.bot.id, { ...interval, name: "Ordinary renamed" }, ordinary).nextRunAt)
    .toBe("2030-01-01T00:18:00.000Z")
  const changedInput = { ...interval, intervalMinutes: 20 }
  const changed = f.host.saveSchedule(f.bot.id, changedInput, managed)
  expect(changed.nextRunAt).toBe("2030-01-01T00:28:00.000Z")
  const paused = f.host.saveSchedule(f.bot.id, { ...changedInput, enabled: false }, changed)
  expect(paused.nextRunAt).toBeNull()
  f.advance(4 * 60_000)
  expect(f.host.saveSchedule(f.bot.id, changedInput, paused).nextRunAt)
    .toBe("2030-01-01T00:32:00.000Z")
})

describe("desktop work schedules", () => {
  it("retains the main user authority and execution target through tool replay, edit and trigger", () => {
    const f = fixture()
    const request = f.store.enqueue({
      botId: f.bot.id,
      requestId: "user-request",
      message: "Update the same report every day"
    })
    f.store.transition(request.id, "running")
    const save = (taskId: string, callId: string) =>
      f.store.saveSchedule(f.bot.id, interval, "2030-01-01T00:10:00Z", undefined, undefined, {
        workId: f.work.id,
        source: { taskId, callId, key: "update-report" }
      })
    const saved = save(request.id, "tool-call")
    expect(save(request.id, "replayed-call")).toEqual(saved)
    f.store.settle(request.id, "completed", null)
    const inWork = f.store.enqueue({
      botId: f.bot.id,
      workId: f.work.id,
      requestId: "work-message",
      message: "Set another schedule"
    })
    f.store.transition(inWork.id, "running")
    expect(() => save(inWork.id, "child-call")).toThrow("桌面主对话")
    f.store.settle(inWork.id, "completed", null)
    const edited = f.store.saveSchedule(
      f.bot.id,
      { ...interval, name: "Rename" },
      saved.nextRunAt,
      saved
    )
    expect(edited).toMatchObject({ workId: f.work.id, sourceTaskId: request.id, desktopWork: true })
    f.store.fireSchedule(edited, "2030-01-01T00:20:00Z")
    expect(f.triggers()).toMatchObject([
      {
        workId: f.work.id,
        threadId: f.work.threadId,
        origin: { kind: "schedule", scheduleId: saved.id, sourceTaskId: request.id }
      }
    ])
  })

  it("rejects cross-Bot work and prevents rebinding a saved routine", () => {
    const f = fixture()
    const other = f.store.create({
      name: "Other",
      instructions: "",
      color: "#123456",
      modelRef: null
    })
    expect(() => f.host.saveSchedule(other.id, interval, undefined, undefined, f.binding)).toThrow(
      "工作不属于当前 Bot"
    )
    const saved = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
    expect(() => f.host.saveSchedule(f.bot.id, interval, saved, undefined, f.binding)).toThrow(
      "执行目标和渠道不能变更"
    )
    expect(f.store.schedules()).toEqual([saved])
  })

  it("replays the original creation across reopen and deadline without restoring a deleted routine", async () => {
    const f = fixture()
    const once = { ...interval, frequency: "once" as const, runAt: "2030-01-01T00:10:00Z" }
    const save = (host: LocalBotHost, input = once) =>
      host.saveSchedule(f.bot.id, input, undefined, undefined, f.binding)
    const saved = save(f.host)
    expect(saved).toMatchObject({ desktopWork: true, audienceKey: "desktop", workId: f.work.id })
    expect(saved.sourceTaskId).toBeUndefined()
    await f.host.stop()
    f.advance(600_001)
    const reopened = f.reopen()
    expect(save(reopened.host).id).toBe(saved.id)
    expect(() => save(reopened.host, { ...once, message: "Different request" })).toThrow("不同内容")
    reopened.host.resume()
    reopened.host.resume()
    const [trigger] = f.triggers()
    expect(f.triggers()).toHaveLength(1)
    expect(trigger).toMatchObject({
      workId: f.work.id,
      threadId: f.work.threadId,
      origin: { kind: "schedule", scheduleId: saved.id }
    })
    expect(reopened.store.getWork(f.bot.id, f.work.id).workspace).toEqual(f.work.workspace)
    const current = reopened.store.schedules()[0]
    reopened.host.removeSchedule(current.id, current.version)
    expect(() => save(reopened.host)).toThrow("原例行已删除")
    expect(reopened.store.schedules()).toEqual([])
    expect(reopened.store.getTask(trigger.id).state).toBe("cancelled")
  })

  it.each(["withdraw", "already started", "checkpoint deferred", "rescheduled"] as const)("checks the exact one-shot occurrence before a card can withdraw it (%s)", change => {
    const f = fixture()
    const once = parseSchedule({ ...interval, frequency: "once", runAt: "2030-01-01T00:10:00Z" })
    f.host.saveSchedule(f.bot.id, once, undefined, undefined, f.binding)
    f.host.changeWorkControl({ botId: f.bot.id, workId: f.work.id, action: "take", operationId: "take-once",
      expectedVersion: f.store.getWork(f.bot.id, f.work.id).version })
    f.advance(600_000)
    f.host.resume()
    const [trigger] = f.triggers()
    const [fired] = f.host.snapshot().schedules
    expect(fired.pendingOccurrenceId).toBe(trigger.id)
    const update = (fields: Partial<BotScheduleInput>, existing: { id: string; version: number; withdrawTaskId?: string }) =>
      f.host.saveSchedule(f.bot.id, parseSchedule({ ...fired, ...fields }), existing)
    const renamed = update({ name: "Same occurrence" }, fired)
    expect(f.store.getTask(trigger.id).state).toBe("queued")
    const withdraw = { id: renamed.id, version: renamed.version, withdrawTaskId: trigger.id }
    expect(() => update({}, { ...withdraw, withdrawTaskId: f.task.id })).toThrow("本次执行已变化")
    if (change === "already started" || change === "checkpoint deferred") {
      const pending = f.host.workControlPending(f.bot.id, f.work.id)
      f.host.changeWorkControl({ botId: f.bot.id, workId: f.work.id, action: "return", operationId: "return-once",
        expectedVersion: pending.version, confirmedTaskIds: [trigger.id] })
      f.store.transition(trigger.id, "running")
      if (change === "checkpoint deferred") f.store.deferTask(trigger.id, "started-checkpoint")
      expect(() => update({}, withdraw)).toThrow("本次执行已变化")
      expect(f.host.snapshot().schedules[0].pendingOccurrenceId).toBeUndefined()
      expect(f.store.getTask(trigger.id).state).toBe(change === "already started" ? "running" : "queued")
    } else if (change === "rescheduled") {
      update({ name: renamed.name, enabled: true, runAt: "2030-01-01T00:20:00Z" }, renamed)
      f.advance(600_000)
      f.host.resume()
      const [replacement] = f.host.snapshot().schedules
      expect(replacement.pendingOccurrenceId).toBeDefined()
      expect(replacement.pendingOccurrenceId).not.toBe(trigger.id)
      expect(() => update({}, withdraw)).toThrow("例行任务已改变")
      expect(f.store.getTask(replacement.pendingOccurrenceId!).state).toBe("queued")
    } else {
      expect(update({}, withdraw)).toEqual(renamed)
      expect(f.store.getTask(trigger.id).state).toBe("cancelled")
      expect(f.host.workControlPending(f.bot.id, f.work.id).items).toEqual([])
      expect(f.host.snapshot().schedules).toEqual([renamed])
      expect(() => update({}, withdraw)).toThrow("本次执行已变化")
    }
  })

  it("queues a newly arranged one-shot once while the previous occurrence is still running", () => {
    const f = fixture()
    const once = parseSchedule({ ...interval, frequency: "once", runAt: "2030-01-01T00:10:00Z" })
    f.host.saveSchedule(f.bot.id, once, undefined, undefined, f.binding)
    f.advance(600_000)
    f.host.resume()
    const [first] = f.triggers()
    f.store.transition(first.id, "running")
    const [fired] = f.host.snapshot().schedules
    const updated = parseSchedule({ ...fired, enabled: true, runAt: "2030-01-01T00:20:00Z", message: "Export the next report" })
    f.host.saveSchedule(f.bot.id, updated, fired)
    f.advance(600_000)
    f.host.resume()
    f.host.resume()
    expect(f.triggers()).toHaveLength(2)
    const second = f.triggers().find(task => task.id !== first.id)!
    expect(second).toMatchObject({ workId: f.work.id, threadId: f.work.threadId, message: updated.message, state: "queued" })
    expect(f.host.snapshot().schedules[0].pendingOccurrenceId).toBe(second.id)
    expect(f.store.getTask(first.id).state).toBe("running")
    f.store.settle(first.id, "completed", null)
    expect(f.store.nextQueued([])?.id).toBe(second.id)
  })

  it("coalesces a desktop work recurrence until the previous peer and command chain finishes", () => {
    const f = fixture()
    const peer = f.store.create({ name: "Reviewer", instructions: "", color: "#345678", modelRef: null })
    f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
    const tick = () => {
      f.advance(601_000)
      f.host.resume()
    }
    tick()
    const [first] = f.triggers()
    f.store.transition(first.id, "running")
    const assignment = f.host.delegate(first.id, peer.id, "Check the result", "review")
    f.store.settle(first.id, "completed", null, BOT_ROUTINE_SILENT)
    f.store.transition(assignment.id, "running")
    tick()
    expect(f.triggers()).toHaveLength(1)
    f.store.settle(assignment.id, "completed", null, "Result checked")
    tick()
    expect(f.triggers()).toHaveLength(1)
    f.store.flushReplies()
    const reply = f.store.recentTasks().find(task => task.requestId === `reply-${assignment.id}`)!
    tick()
    expect(f.triggers()).toHaveLength(1)
    f.store.transition(reply.id, "running")
    f.store.acceptCommand(reply.id, { id: "verified-check", threadId: f.work.threadId,
      command: "check", cwd: "/reports", startedAt: Date.now() })
    f.store.settle(reply.id, "completed", null, BOT_ROUTINE_SILENT)
    f.store.settleCommand({ id: "verified-check", threadId: f.work.threadId,
      output: "Checked", exitCode: 0, cancelled: false, truncated: false })
    const checked = f.store.recentTasks().find(task => task.origin.kind === "notification" && task.origin.key === "verified-check")!
    f.store.transition(checked.id, "running")
    const followUp = f.host.delegate(checked.id, peer.id, "Read the check results", "final-review")
    f.store.settle(checked.id, "completed", null, BOT_ROUTINE_SILENT)
    f.store.transition(followUp.id, "running")
    tick()
    expect(f.triggers()).toHaveLength(1)
    f.store.settle(followUp.id, "completed", null, "Check complete")
    f.store.flushReplies()
    const finalReply = f.store.recentTasks().find(task => task.requestId === `reply-${followUp.id}`)!
    f.store.transition(finalReply.id, "running")
    f.store.settle(finalReply.id, "completed", null, "Check complete")
    tick()
    expect(f.triggers()).toHaveLength(2)
  })

  it.each([true, false])("coalesces only the finite command of the prior desktop recurrence (%s)", notifyOnComplete => {
    const f = fixture()
    const { threadId } = f.work
    f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
    const tick = () => {
      f.advance(601_000)
      f.host.resume()
    }
    tick()
    const [first] = f.triggers()
    f.store.transition(first.id, "running")
    f.store.acceptCommand(first.id, { id: "command", threadId, command: "check", cwd: "/reports",
      startedAt: Date.now(), notifyOnComplete })
    f.store.settle(first.id, "completed", null, BOT_ROUTINE_SILENT)
    tick()
    expect(f.triggers()).toHaveLength(notifyOnComplete ? 1 : 2)
    if (!notifyOnComplete) return
    f.store.settleCommand({ id: "command", threadId, output: "Checked", exitCode: 0, cancelled: false, truncated: false })
    const reply = f.store.recentTasks().find(item => item.origin.kind === "notification" && item.origin.key === "command")!
    tick()
    expect(f.triggers()).toHaveLength(1)
    f.store.transition(reply.id, "running")
    f.store.settle(reply.id, "completed", null, BOT_ROUTINE_SILENT)
    tick()
    expect(f.triggers()).toHaveLength(2)
  })

  it("coalesces missed intervals under user control and preserves the binding when paused and resumed", () => {
    const f = fixture()
    const saved = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
    const control = (action: "take" | "return") =>
      f.host.changeWorkControl({
        botId: f.bot.id,
        workId: f.work.id,
        action,
        operationId: action,
        ...(action === "return" ? { confirmedTaskIds: f.host.workControlPending(f.bot.id, f.work.id).items.map(item => item.taskId) } : {}),
        expectedVersion: f.store.getWork(f.bot.id, f.work.id).version
      })
    control("take")
    f.advance(1_800_000)
    f.host.resume()
    f.advance(1_800_000)
    f.host.resume()
    expect(f.triggers()).toHaveLength(1)
    const held = f.triggers()[0]
    expect(f.store.workDispatchToken(held.id)).toBeNull()
    expect(f.store.nextQueued([])).toBeNull()
    control("return")
    expect(f.store.nextQueued([])?.id).toBe(held.id)
    const current = f.store.schedules()[0]
    const paused = f.host.saveSchedule(f.bot.id, { ...interval, enabled: false }, current)
    expect(paused).toMatchObject({
      id: saved.id,
      workId: f.work.id,
      desktopWork: true,
      enabled: false
    })
    expect(f.store.getTask(held.id).state).toBe("cancelled")
    f.advance(600_001)
    f.host.resume()
    expect(f.triggers()).toHaveLength(1)
    f.host.saveSchedule(f.bot.id, interval, paused)
    f.advance(600_001)
    f.host.resume()
    expect(f.triggers().filter((task) => task.state === "queued")).toMatchObject([
      {
        workId: f.work.id,
        threadId: f.work.threadId,
        origin: { kind: "schedule", scheduleId: saved.id }
      }
    ])
  })

  it("projects a held work routine separately from the user's runnable input", async () => {
    const f = fixture()
    f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
    f.host.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: f.work.version,
      operationId: "take-before-routine", action: "take"
    })
    f.advance(600_000)
    f.host.resume()
    const [held] = f.triggers()
    expect(held.state).toBe("queued")
    expect(f.store.workDispatchToken(held.id)).toBeNull()
    expect(f.store.nextQueued([f.bot.threadId])).toBeNull()
    const projections = () => [
      f.store.getWork(f.bot.id, f.work.id),
      f.store.listWorks(f.bot.id, undefined, "", "desktop").items[0],
      f.store.workSummaries(f.bot.id, [f.work.id])[0]
    ]
    for (const summary of projections()) {
      expect.soft(summary).toMatchObject({
        executionState: "completed", userControl: { settling: false, heldInputs: 1 }
      })
    }

    const input = await f.host.sendDesktopMessage({
      botId: f.bot.id, workId: f.work.id, requestId: "manual-during-takeover",
      message: "Check the current report now"
    })
    for (const summary of projections()) {
      expect(summary).toMatchObject({
        executionState: "queued", userControl: { settling: false, heldInputs: 1 }
      })
    }
    expect(f.store.nextQueued([f.bot.threadId])?.id).toBe(input.id)
    f.store.transition(input.id, "running")
    expect(f.store.getWork(f.bot.id, f.work.id).executionState).toBe("running")
    f.store.settle(input.id, "completed", null, "Checked the current report")
    const pending = f.host.workControlPending(f.bot.id, f.work.id)
    expect(pending.items.map(item => item.taskId)).toEqual([held.id])
    f.host.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: pending.version,
      operationId: "return-for-routine", action: "return", confirmedTaskIds: [held.id]
    })
    expect(f.store.getWork(f.bot.id, f.work.id).executionState).toBe("queued")
    expect(f.store.nextQueued([f.bot.threadId])?.id).toBe(held.id)
  })

  it("keeps a held one-shot occurrence when its automatically disabled schedule is renamed", () => {
    const f = fixture()
    const input = parseSchedule({ ...interval, frequency: "once", runAt: "2030-01-01T00:10:00Z" })
    f.host.saveSchedule(f.bot.id, input, undefined, undefined, f.binding)
    f.host.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: f.store.getWork(f.bot.id, f.work.id).version,
      operationId: "take", action: "take"
    })
    f.advance(600_000)
    f.host.resume()
    const [fired] = f.store.schedules()
    const [trigger] = f.triggers()
    expect(fired).toMatchObject({ enabled: false, nextRunAt: null })
    expect(f.store.workDispatchToken(trigger.id)).toBeNull()

    const renamed = f.host.saveSchedule(f.bot.id, parseSchedule({ ...fired, name: "Rename only" }), fired)
    expect(renamed).toMatchObject({ name: "Rename only", enabled: false, lastTriggeredAt: fired.lastTriggeredAt })
    const pending = f.host.workControlPending(f.bot.id, f.work.id)
    expect(pending.items.map(item => item.taskId)).toEqual([trigger.id])
    f.host.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: pending.version,
      operationId: "return", action: "return", confirmedTaskIds: [trigger.id]
    })
    expect(f.store.nextQueued([])?.id).toBe(trigger.id)
  })

  it.each(["completed", "stopped", "deleting"] as const)(
    "pauses a due routine without enqueueing against %s work",
    (state) => {
      const f = fixture()
      const saved = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
      const work = f.store.getWork(f.bot.id, f.work.id)
      if (state === "completed")
        f.store.changeWork(f.bot.id, work.id, work.version, "done", "complete")
      if (state === "stopped") f.host.stopWork(f.bot.id, work.id)
      if (state === "deleting")
        f.store.beginWorkDeletion({
          botId: f.bot.id,
          workId: work.id,
          threadId: work.threadId,
          version: work.version,
          incarnation: null
        })
      f.advance(600_001)
      f.host.resume()
      f.host.resume()
      expect(f.triggers()).toHaveLength(0)
      const paused = f.store.schedules()[0]
      expect(paused).toMatchObject({
        id: saved.id,
        enabled: false,
        nextRunAt: null,
        workUnavailable: true
      })
      expect(() => f.host.saveSchedule(f.bot.id, interval, paused)).toThrow("任务")
    }
  )
})

describe("read-only scheduled work observations", () => {
  function observe(
    f: ReturnType<typeof fixture>,
    mode: BotWorkScheduleMonitorInput["mode"],
    expiresAt?: string,
    input = interval,
    requestId = "ask-to-watch"
  ) {
    const request = f.store.enqueue({
      botId: f.bot.id,
      requestId,
      message: "Watch the report"
    })
    f.store.transition(request.id, "running")
    const save = (callId: string) =>
      f.store.saveSchedule(
        f.bot.id,
        input,
        input.runAt ?? "2030-01-01T00:10:00Z",
        undefined,
        undefined,
        undefined,
        {
          input: { workId: f.work.id, mode, expiresAt },
          source: { taskId: request.id, callId, key: "watch" }
        }
      )
    const saved = save("create")
    expect(save("retry")).toEqual(saved)
    f.store.settle(request.id, "completed", null)
    return saved
  }

  function begin(f: ReturnType<typeof fixture>, schedule: BotSchedule) {
    f.store.fireSchedule(schedule, schedule.frequency === "once" ? null : "2030-01-01T00:20:00Z")
    expect(f.store.nextQueued([])).toBeNull()
    const trigger = f.store.nextQueued([], true, true)!
    expect(trigger).toMatchObject({
      threadId: f.bot.threadId,
      origin: {
        kind: "schedule",
        scheduleId: schedule.id,
        observation: { workId: f.work.id }
      }
    })
    expect(trigger.workId).toBeUndefined()
    f.store.transition(trigger.id, "running")
    return trigger.id
  }

  function settleReports(f: ReturnType<typeof fixture>) {
    f.store.flushReplies()
    for (const task of f.store.recentTasks()) {
      if (task.origin.kind !== "work_result" || task.state !== "queued") continue
      f.store.transition(task.id, "running")
      f.store.settle(task.id, "completed", null)
    }
  }

  it.each([false, true])("reports the current execution and whether its result changed (new=%s)", (changed) => {
    const f = fixture()
    settleReports(f)
    const monitor = observe(f, "report")
    if (changed) {
      const revision = f.store.enqueue({
        botId: f.bot.id, workId: f.work.id, requestId: "new-report", message: "Update the report"
      })
      f.store.transition(revision.id, "running")
      f.store.settle(revision.id, "completed", null, "Updated report")
      settleReports(f)
    }
    const trigger = begin(f, monitor)
    f.store.settleScheduledWorkObservation(trigger)
    f.store.settleScheduledWorkObservation(trigger)
    const publications = f.store.pendingScheduledWorkPublications()
    expect(publications).toHaveLength(1)
    expect(publications[0].text).toContain("当前执行已完成。")
    expect(publications[0].text).toContain(changed ? "较上次记录有新结果。" : "较上次记录没有新结果。")
    expect(publications[0].text).not.toContain("仍在跟进")
  })

  function beginReviewedRevision(f: ReturnType<typeof fixture>, requestId: string) {
    f.advance(1)
    const user = f.store.enqueue({
      botId: f.bot.id, requestId, message: "Verify the existing report"
    })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    const revision = f.store.sendWork({ taskId: user.id, callId: "send", key: "send" }, f.work.id, user.message)
    f.store.settle(user.id, "completed", null)
    f.store.transition(revision.id, "running")
    f.store.recordPreparedInput(revision.id, revision.message)
    expect(f.store.armWorkResultReview(revision.id, "incarnation")).toBe(true)
    return revision
  }

  function publishReviewedResult(
    f: ReturnType<typeof fixture>, conclusion: { kind: "ready" | "blocked"; summary: string }
  ) {
    f.store.flushReplies()
    const review = f.store.nextQueued([])!
    expect(review.origin).toMatchObject({ kind: "work_result", review: { phase: "review" } })
    f.store.transition(review.id, "running")
    expect(f.store.commitWorkResultReview(review.id, { ...conclusion, evidenceIds: [] }).state).toBe("publish")
    f.store.settle(review.id, "completed", null)
    f.store.flushReplies()
    const publication = f.store.nextQueued([])!
    expect(publication.origin).toMatchObject({ kind: "work_result", review: { phase: "publish" } })
    f.store.transition(publication.id, "running")
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    f.store.settle(publication.id, "completed", null)
    expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(conclusion)
  }

  function fillRecentCommandHistory(f: ReturnType<typeof fixture>, suffix = "") {
    const owner = f.store.enqueue({ botId: f.bot.id, requestId: `other-jobs${suffix}`, message: "Other jobs" })
    f.store.transition(owner.id, "running")
    for (let i = 0; i <= 200; i++) {
      const id = `other-job-${i}${suffix}`
      f.advance(1)
      f.store.acceptCommand(owner.id, { id, threadId: owner.threadId, command: "check",
        cwd: "/reports", startedAt: Date.now(), notifyOnComplete: false })
      f.store.settleCommand({ id, threadId: owner.threadId, exitCode: 0, output: "", cancelled: false, truncated: false })
    }
    f.store.settle(owner.id, "completed", null)
  }

  it("distinguishes renaming a queued one-shot observation from explicitly pausing it", async () => {
    const f = fixture()
    const input = parseSchedule({ ...interval, frequency: "once", runAt: "2030-01-01T00:10:00Z" })
    observe(f, "report", undefined, input)
    const request = f.store.enqueue({ botId: f.bot.id, requestId: "edit-watch", message: "Rename the observation" })
    f.store.transition(request.id, "running")
    f.advance(600_000)
    f.host.resume()
    const [fired] = f.store.schedules()
    const [trigger] = f.triggers()
    expect(fired).toMatchObject({ enabled: false, nextRunAt: null })
    expect(trigger.state).toBe("queued")

    const [tool] = createBotScheduleTools(f.bot, request, () => f.host, new AbortController().signal)
    const call = { type: "tool_call" as const, name: tool.name }
    const rename = await tool.invoke({ ...call, id: "rename", args: { action: "save", id: fired.id, name: "New title" } })
    expect(rename.status).not.toBe("error")
    expect(f.store.schedules()[0]).toMatchObject({ name: "New title", workMonitor: fired.workMonitor })
    expect(f.store.getTask(trigger.id).state).toBe("queued")

    const pause = await tool.invoke({ ...call, id: "pause", args: { action: "save", id: fired.id, enabled: false } })
    expect(pause.status).not.toBe("error")
    expect(f.store.getTask(trigger.id).state).toBe("cancelled")
  })

  it("only reports a new physical result and never reopens or dispatches the observed work", () => {
    const f = fixture()
    const monitor = observe(f, "new_result")
    const first = f.store.settleScheduledWorkObservation(begin(f, monitor))
    expect(first.kind).toBe("silent")
    const later = f.store.enqueue({
      botId: f.bot.id,
      workId: f.work.id,
      requestId: "revision",
      message: "Revise"
    })
    f.store.transition(later.id, "running")
    f.store.settle(later.id, "completed", null)
    const trigger = begin(f, f.store.schedules()[0])
    expect(f.store.readScheduledWorkObservation(trigger)).toMatchObject({
      workState: "active",
      result: { taskId: later.id, state: "completed" }
    })
    const result = f.store.settleScheduledWorkObservation(trigger)
    expect(result).toMatchObject({ kind: "notify", snapshot: { result: { taskId: later.id } } })
    expect(f.store.settleScheduledWorkObservation(trigger)).toEqual(result)
    expect(f.store.pendingWorkFamily(f.bot.id, f.work.id)).toEqual([])
  })

  it("keeps the verified result and suppresses a new-result notice after a quiet work routine", () => {
    const f = fixture()
    settleReports(f)
    const revision = beginReviewedRevision(f, "verify-existing-report")
    f.store.settle(revision.id, "completed", null, "The report checks passed")
    const conclusion = { kind: "ready" as const, summary: "Verified report" }
    publishReviewedResult(f, conclusion)

    const monitor = observe(f, "new_result")
    const expectedResult = { taskId: revision.id, state: "completed", review: "ready" }
    expect(monitor.workMonitor?.lastSuccessful?.result).toEqual(expectedResult)
    const routine = f.host.saveSchedule(f.bot.id, {
      ...interval, message: "Refresh the report if the data changed"
    }, undefined, undefined, f.binding)
    f.advance(600_000)
    f.store.fireSchedule(routine, new Date(Date.now() + 600_000).toISOString())
    const quiet = f.store.nextQueued([])!
    expect(quiet.origin).toMatchObject({ kind: "schedule", scheduleId: routine.id })
    f.store.transition(quiet.id, "running")
    f.store.settle(quiet.id, "completed", null, BOT_ROUTINE_SILENT)
    f.store.flushReplies()
    expect(f.store.nextQueued([])).toBeNull()

    expect.soft(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(conclusion)
    const unchanged = f.store.settleScheduledWorkObservation(begin(f, monitor))
    expect.soft(unchanged).toMatchObject({ kind: "silent", snapshot: { result: expectedResult } })
    expect.soft(f.store.pendingScheduledWorkPublications()).toEqual([])

    f.advance(31 * DAY)
    fillRecentHistory(f)
    expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
    const { store } = f.reopen()
    expect.soft(store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(conclusion)

    const nextRoutine = store.schedules().find(schedule => schedule.id === routine.id)!
    store.fireSchedule(nextRoutine, new Date(Date.now() + 600_000).toISOString())
    const changed = store.nextQueued([])!
    expect(changed.origin).toMatchObject({ kind: "schedule", scheduleId: routine.id })
    store.transition(changed.id, "running")
    store.settle(changed.id, "completed", null, "The updated report is ready")
    expect(store.getWork(f.bot.id, f.work.id).resultConclusion).toBeUndefined()
    const nextMonitor = store.schedules().find(schedule => schedule.id === monitor.id)!
    const priorPublications = store.pendingScheduledWorkPublications().map(item => item.id)
    store.fireSchedule(nextMonitor, new Date(Date.now() + 600_000).toISOString(), true)
    expect(store.pendingScheduledWorkPublications().filter(item => !priorPublications.includes(item.id)))
      .toMatchObject([{ text: expect.stringContaining("最近一次执行结果为已完成") }])
    expect(store.schedules().find(schedule => schedule.id === monitor.id)?.workMonitor?.lastSuccessful?.result)
      .toEqual({ taskId: changed.id, state: "completed" })
  })

  it.each(["ready", "blocked"] as const)(
    "replaces the published %s conclusion when a quiet routine's delegated result arrives",
    (kind) => {
      const f = fixture()
      settleReports(f)
      const original = beginReviewedRevision(f, "verify-original-report")
      const conclusion = { kind, summary: "The earlier report's review conclusion" }
      f.store.settle(original.id, "completed", null, "Earlier report delivered for review")
      publishReviewedResult(f, conclusion)
      const monitor = observe(f, "new_result")
      const peer = f.store.create({ name: "Reviewer", instructions: "", color: "#345678", modelRef: null })
      const routine = f.host.saveSchedule(f.bot.id, {
        ...interval, message: "Ask Reviewer to inspect the new report. Report the findings once they arrive."
      }, undefined, undefined, f.binding)
      f.advance(600_000)
      f.store.fireSchedule(routine, new Date(Date.now() + 600_000).toISOString())
      const trigger = f.store.nextQueued([])!
      expect(trigger.origin).toMatchObject({ kind: "schedule", scheduleId: routine.id })
      f.store.transition(trigger.id, "running")
      const assignment = f.host.delegate(trigger.id, peer.id, "Inspect the new report", "review")
      f.store.settle(trigger.id, "completed", null, BOT_ROUTINE_SILENT)
      expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(conclusion)

      f.advance(1)
      f.store.transition(assignment.id, "running")
      f.store.settle(assignment.id, "completed", null, "The new report has no final page")
      f.store.flushReplies()
      const callback = f.store.nextQueued([])!
      expect(callback).toMatchObject({ workId: f.work.id,
        origin: { kind: "bot", rootTaskId: trigger.id, expectsReply: false } })
      f.store.transition(callback.id, "running")
      f.store.settle(callback.id, "completed", null, "The new report is blocked. It has no final page.")
      settleReports(f)

      const latestMonitor = f.store.schedules().find(schedule => schedule.id === monitor.id)!
      const observation = f.store.settleScheduledWorkObservation(begin(f, latestMonitor))
      const result = { taskId: callback.id, state: "completed" }
      expect(observation).toMatchObject({ kind: "notify", snapshot: { result } })
      expect(observation.snapshot?.result).toEqual(result)
      expect(f.store.acknowledgeScheduledWorkPublication(observation.taskId)).toBe(true)
      expect.soft(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toBeUndefined()

      f.advance(31 * DAY)
      fillRecentHistory(f)
      expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
      expect(() => f.store.getTask(trigger.id)).toThrow()
      expect(f.store.getTask(callback.id).state).toBe("completed")
      const { store } = f.reopen()
      expect.soft(store.getWork(f.bot.id, f.work.id).resultConclusion).toBeUndefined()
      const reopenedMonitor = store.schedules().find(schedule => schedule.id === monitor.id)!
      expect(reopenedMonitor.workMonitor?.lastSuccessful?.result).toEqual(result)
      store.fireSchedule(reopenedMonitor, new Date(Date.now() + 600_000).toISOString(), true)
      expect(store.schedules().find(schedule => schedule.id === monitor.id)?.workMonitor?.lastSuccessful?.result)
        .toEqual(result)
      expect(store.pendingScheduledWorkPublications()).toEqual([])
    }
  )

  it.each(["changed", "attachment", "unchanged", "failed"] as const)(
    "observes the %s command return from a later routine",
    (outcome) => {
      const quiet = outcome === "unchanged"
      const failed = outcome === "failed"
      const f = fixture()
      settleReports(f)
      const original = beginReviewedRevision(f, "verify-previous-report")
      const conclusion = { kind: "ready" as const, summary: "The earlier report is verified" }
      f.store.settle(original.id, "completed", null, "Earlier report delivered for review")
      publishReviewedResult(f, conclusion)
      const monitor = observe(f, "new_result")
      const peer = f.store.create({ name: "Reviewer", instructions: "", color: "#345678", modelRef: null })
      const routine = f.host.saveSchedule(f.bot.id, {
        ...interval, message: "Ask Reviewer whether a report check is needed, then run the check if requested."
      }, undefined, undefined, f.binding)
      f.advance(600_000)
      f.store.fireSchedule(routine, new Date(Date.now() + 600_000).toISOString())
      const trigger = f.store.nextQueued([])!
      expect(trigger.origin).toMatchObject({ kind: "schedule", scheduleId: routine.id })
      f.store.transition(trigger.id, "running")
      const assignment = f.host.delegate(trigger.id, peer.id, "Check whether verification is needed", "needs-check")
      f.store.settle(trigger.id, "completed", null, BOT_ROUTINE_SILENT)
      f.advance(1)
      f.store.transition(assignment.id, "running")
      f.store.settle(assignment.id, "completed", null, "Verify the report checksum in the original workspace")
      f.store.flushReplies()
      const integration = f.store.nextQueued([])!
      expect(integration).toMatchObject({
        workId: f.work.id, origin: { kind: "bot", rootTaskId: trigger.id, expectsReply: false }
      })
      f.store.transition(integration.id, "running")
      // The independent peer return has the normal detached lifecycle. The routine
      // itself keeps foreground commands in its existing turn.
      const lifecycle = f.host.commandLifecycle(integration.id)
      const command = { id: "verify-checksum", threadId: integration.threadId }
      lifecycle.accepted({ ...command, command: "verify-report-checksum", cwd: "/reports",
        startedAt: Date.now(), notifyOnComplete: true })
      f.store.settle(integration.id, "completed", null, "Checksum verification is running")
      expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(conclusion)
      settleReports(f)

      const activity = () => f.store.getWork(f.bot.id, f.work.id).activity!
      f.host.markRead("work", f.work.id, activity().version)
      expect(activity().unread).toBe(false)
      f.advance(1)
      lifecycle.settled({ ...command, exitCode: failed ? 1 : 0,
        output: failed ? "Checksum check failed" : quiet ? "Unchanged" : "New checksum",
        cancelled: false, truncated: false })
      const callback = f.store.nextQueued([])!
      expect(callback).toMatchObject({
        workId: f.work.id, origin: { kind: "notification", notificationKind: "command", key: command.id }
      })
      expect.soft(activity().unread).toBe(false)
      f.store.transition(callback.id, "running")
      const files = outcome === "attachment"
        ? [{ name: "report.md", filePath: "/reports/report.md", attachmentPath: "/retained/report.md", size: 8 }]
        : undefined
      const state = failed ? "failed" : "completed"
      f.store.settle(callback.id, state, failed ? "Checksum check failed" : null,
        outcome === "changed" ? "The updated report passed its checksum check" : BOT_ROUTINE_SILENT, files)
      expect.soft(activity().unread).toBe(!quiet)
      if (failed)
        expect(resolveBotWorkStatus(f.store.getWork(f.bot.id, f.work.id)).label).toBe("执行失败")
      settleReports(f)

      const expectedResult = quiet
        ? { taskId: original.id, state: "completed", review: "ready" }
        : { taskId: callback.id, state, ...(failed ? { commandOutcome: "failed" } : {}) }
      expect(f.store.settleScheduledWorkObservation(begin(f, monitor))).toMatchObject({
        kind: quiet ? "silent" : "notify", snapshot: { result: expectedResult }
      })
      expect(f.store.pendingScheduledWorkPublications()).toHaveLength(quiet ? 0 : 1)
      expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(quiet ? conclusion : undefined)
      fillRecentCommandHistory(f)
      expect(f.db.exec("SELECT id FROM bot_commands WHERE id='verify-checksum'")[0].values).toEqual([])
      f.advance(31 * DAY)
      fillRecentHistory(f)
      expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
      expect(f.store.getTask(expectedResult.taskId).state).toBe(expectedResult.state)
      const { store } = f.reopen()
      expect(store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(quiet ? conclusion : undefined)
      const restartedMonitor = store.schedules().find(schedule => schedule.id === monitor.id)!
      store.fireSchedule(restartedMonitor, new Date(Date.now() + 600_000).toISOString(), true)
      expect(store.schedules().find(schedule => schedule.id === monitor.id)?.workMonitor?.lastSuccessful?.result)
        .toEqual(expectedResult)
      expect(store.pendingScheduledWorkPublications()).toHaveLength(quiet ? 0 : 1)
      expect(observe({ ...f, store }, "new_result", undefined, interval, "watch-after-retention")
        .workMonitor?.lastSuccessful?.result).toEqual(expectedResult)
    }
  )

  it.each([
    { returnKind: "peer", state: "failed", kind: "ready", status: "成果已就绪" },
    { returnKind: "command", state: "interrupted", kind: "blocked", status: "成果待核对" }
  ] as const)(
    "keeps showing and observing the current $kind result after a late $returnKind return is $state",
    ({ returnKind, state, kind, status }) => {
      const f = fixture()
      settleReports(f)
      const peer = f.store.create({ name: "Reviewer", instructions: "", color: "#345678", modelRef: null })
      const routine = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
      f.advance(600_000)
      f.store.fireSchedule(routine, new Date(Date.now() + 600_000).toISOString())
      const trigger = f.store.nextQueued([])!
      expect(trigger.origin).toMatchObject({ kind: "schedule", scheduleId: routine.id })
      f.store.transition(trigger.id, "running")
      const assignment = f.host.delegate(trigger.id, peer.id, "Inspect the earlier report", "inspect-early")
      f.store.transition(assignment.id, "running")
      f.store.settle(trigger.id, "completed", null, BOT_ROUTINE_SILENT)

      const current = beginReviewedRevision(f, "verify-current-report")
      const reviewer = f.store.create({ name: "Current reviewer", instructions: "", color: "#445678", modelRef: null })
      const currentAssignment = f.host.delegate(current.id, reviewer.id, "Verify current report", "inspect-current")
      f.store.transition(currentAssignment.id, "running")
      f.store.settle(current.id, "completed", null, "Current report handed off")
      f.store.settle(currentAssignment.id, "completed", null, "Current report checks passed")
      f.store.flushReplies()
      const currentReturn = f.store.nextQueued([])!
      expect(currentReturn.origin).toMatchObject({ kind: "bot", rootTaskId: current.id, expectsReply: false })
      f.store.transition(currentReturn.id, "running")
      f.store.settle(currentReturn.id, "completed", null, "Current report checks passed")
      const conclusion = { kind, summary: kind === "ready" ? "The current report is verified" : "Review a missing page" }
      publishReviewedResult(f, conclusion)
      const monitor = observe(f, "new_result")
      const result = { taskId: currentReturn.id, state: "completed", review: kind }
      expect(monitor.workMonitor?.lastSuccessful?.result).toEqual(result)
      f.advance(31 * DAY)
      fillRecentHistory(f)
      f.store.settle(assignment.id, "completed", null, "The earlier report had a missing page")
      f.store.flushReplies()
      const callback = f.store.nextQueued([])!
      expect(callback).toMatchObject({
        workId: f.work.id, origin: { kind: "bot", rootTaskId: trigger.id, expectsReply: false }
      })
      f.store.transition(callback.id, "running")
      expect(resolveBotWorkStatus(f.store.getWork(f.bot.id, f.work.id)).label).toBe("正在处理")
      const commandId = "old-report-check"
      let lateResult = callback
      if (returnKind === "command") {
        const lifecycle = f.host.commandLifecycle(callback.id)
        const command = { id: commandId, threadId: callback.threadId }
        lifecycle.accepted({ ...command, command: "verify-old-report", cwd: "/reports",
          startedAt: Date.now(), notifyOnComplete: true })
        f.store.settle(callback.id, "completed", null, "Checking the earlier report")
        settleReports(f)
        f.advance(1)
        lifecycle.settled({ ...command, exitCode: 1, output: "Missing page",
          cancelled: false, truncated: false })
        const returned = f.store.nextQueued([])!
        expect(returned).toMatchObject({
          workId: f.work.id, origin: { kind: "notification", notificationKind: "command", key: command.id }
        })
        f.store.transition(returned.id, "running")
        lateResult = returned
      }
      f.store.settle(lateResult.id, state, "The earlier report did not pass its final check")
      expect(f.store.getTask(lateResult.id).state).toBe(state)
      f.store.flushReplies()
      expect(f.store.nextQueued([])?.origin).toMatchObject({
        kind: "work_result", executionTaskId: lateResult.id, executionState: state
      })
      settleReports(f)

      const observation = f.store.settleScheduledWorkObservation(begin(f, monitor))
      expect.soft(observation).toMatchObject({
        kind: "silent", snapshot: { executionState: "completed", result }
      })
      expect.soft(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(conclusion)
      expect.soft(resolveBotWorkStatus(f.store.getWork(f.bot.id, f.work.id)).label).toBe(status)
      if (returnKind === "command") {
        fillRecentCommandHistory(f)
        expect(f.db.exec("SELECT id FROM bot_commands WHERE id='old-report-check'")[0].values).toEqual([])
        const nextMonitor = f.store.schedules().find(schedule => schedule.id === monitor.id)!
        expect.soft(f.store.settleScheduledWorkObservation(begin(f, nextMonitor))).toMatchObject({
          kind: "silent", snapshot: { result }
        })
      }
      expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
      expect(f.store.getTask(current.id).state).toBe("completed")
      expect(f.store.getTask(currentReturn.id).state).toBe("completed")
      const { store } = f.reopen()
      expect.soft(store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(conclusion)
      expect.soft(resolveBotWorkStatus(store.getWork(f.bot.id, f.work.id)).label).toBe(status)
      const restartedMonitor = store.schedules().find(schedule => schedule.id === monitor.id)!
      store.fireSchedule(restartedMonitor, new Date(Date.now() + 600_000).toISOString(), true)
      expect(store.schedules().find(schedule => schedule.id === monitor.id)?.workMonitor?.lastSuccessful?.result)
        .toEqual(result)
      expect(store.pendingScheduledWorkPublications()).toEqual([])
      expect(observe({ ...f, store }, "new_result", undefined, interval, "watch-after-retention")
        .workMonitor?.lastSuccessful?.result).toEqual(result)
    }
  )

  it("keeps the current reviewed result when a replaced request's peer returns late", () => {
    const f = fixture()
    settleReports(f)
    const old = beginReviewedRevision(f, "review-earlier-report")
    const peer = f.store.create({ name: "Reviewer", instructions: "", color: "#345678", modelRef: null })
    const assignment = f.host.delegate(old.id, peer.id, "Check the earlier report", "earlier-review")
    f.store.transition(assignment.id, "running")
    f.store.settle(old.id, "completed", null, "The earlier report is waiting for review")

    const request = f.store.enqueue({
      botId: f.bot.id, requestId: "replace-earlier-report", message: "Stop automatic review of the earlier report."
    })
    f.store.transition(request.id, "running")
    f.store.recordPreparedInput(request.id, request.message)
    expect(f.store.controlWorkResultReview(request.id, f.work.id, "pause")).toBe(true)
    f.store.settle(request.id, "completed", null)
    const current = beginReviewedRevision(f, "review-current-report")
    f.store.settle(current.id, "completed", null, "Current report checks passed")
    const conclusion = { kind: "ready" as const, summary: "The current report is verified" }
    publishReviewedResult(f, conclusion)
    const monitor = observe(f, "new_result")

    f.advance(1)
    f.store.settle(assignment.id, "completed", null, "The earlier report had a missing page")
    f.store.flushReplies()
    const callback = f.store.nextQueued([])!
    expect(callback).toMatchObject({ workId: f.work.id,
      origin: { kind: "bot", rootTaskId: old.id, expectsReply: false } })
    f.store.transition(callback.id, "running")
    f.store.settle(callback.id, "completed", null, "The earlier report had a missing page")

    const observation = f.store.settleScheduledWorkObservation(begin(f, monitor))
    expect(observation).toMatchObject({
      kind: "silent", snapshot: { result: { taskId: current.id, state: "completed", review: "ready" } }
    })
    expect(f.reopen().store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(conclusion)
  })

  it("keeps the desktop conclusion when the same Bot processes group feedback", () => {
    const f = fixture()
    settleReports(f)
    const current = beginReviewedRevision(f, "verify-desktop-report")
    f.store.settle(current.id, "completed", null, "Desktop report checked")
    const conclusion = { kind: "ready" as const, summary: "The desktop report is verified" }
    publishReviewedResult(f, conclusion)
    const monitor = observe(f, "new_result")
    const owner = f.store.create({ name: "Group owner", instructions: "", color: "#345678", modelRef: null })
    const group = f.store.saveGroup({ name: "Group report", memberIds: [owner.id, f.bot.id] })
    f.store.sendGroup({ groupId: group.id, requestId: "group-report",
      text: "Implement a separate report", targetBotIds: [owner.id] })
    const parent = f.store.recentTasks().find(task => task.botId === owner.id && task.origin.kind === "group")!
    f.store.transition(parent.id, "running")
    const assignment = f.store.delegate(parent.id, f.bot.id, "Implement group report", "assign-report")
    f.store.transition(assignment.id, "running")
    const feedback = f.store.delegate(parent.id, f.bot.id, "Keep the existing group report format", "feedback", [], assignment.id)
    expect(feedback.origin).toMatchObject({ feedbackForTaskId: assignment.id, expectsReply: false })
    expect(f.store.injectIntoRun(feedback.id, assignment.id)).toBe(true)
    f.store.settleRun(assignment.id, [feedback.id], "completed", null, "The separate group report is ready")
    expect(f.store.getTask(feedback.id).state).toBe("completed")

    const observation = f.store.settleScheduledWorkObservation(begin(f, monitor))
    expect(observation).toMatchObject({
      kind: "silent", snapshot: { result: { taskId: current.id, state: "completed", review: "ready" } }
    })
    expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toEqual(conclusion)
  })

  it.each(["failed", "completed"] as const)(
    "reports a %s work routine with a silent marker when its outcome is actionable",
    (state) => {
      const f = fixture()
      settleReports(f)
      const monitor = observe(f, "new_result")
      const routine = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
      f.advance(600_000)
      f.store.fireSchedule(routine, new Date(Date.now() + 600_000).toISOString())
      const run = f.store.nextQueued([])!
      expect(run.origin).toMatchObject({ kind: "schedule", scheduleId: routine.id })
      f.store.transition(run.id, "running")
      const files = state === "completed"
        ? [{ name: "report.md", filePath: "/reports/report.md", attachmentPath: "/retained/report.md", size: 8 }]
        : undefined
      f.store.settle(run.id, state, state === "failed" ? "Report checks failed" : null, BOT_ROUTINE_SILENT, files)
      settleReports(f)

      expect(f.store.settleScheduledWorkObservation(begin(f, monitor))).toMatchObject({
        kind: "notify", snapshot: { result: { taskId: run.id, state } }
      })
      expect(f.store.pendingScheduledWorkPublications()).toHaveLength(1)
    }
  )

  it.each<{
    exitCode: number | null
    reviewKind?: "ready" | "blocked" | "needs_user"
    notice?: string
  }>([
    { exitCode: 0 },
    { exitCode: 1, notice: "后台命令执行失败" },
    { exitCode: null, notice: "后台命令结果待确认" },
    { exitCode: 0, reviewKind: "ready", notice: "成果已核查" },
    { exitCode: 1, reviewKind: "blocked", notice: "成果仍有阻碍或待核验" },
    { exitCode: 0, reviewKind: "needs_user", notice: "成果需要你确认" },
    { exitCode: 1, reviewKind: "ready", notice: "成果已核查" }
  ])("waits for the real settlement (review=$reviewKind, exit=$exitCode)", ({ reviewKind, exitCode, notice }) => {
    const f = fixture()
    settleReports(f)
    const monitor = observe(f, "new_result")
    const revision = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "run-report", message: "Run the report and deliver the result"
    })
    f.store.transition(revision.id, "running")
    f.store.recordPreparedInput(revision.id, revision.message)
    if (reviewKind) expect(f.store.armWorkResultReview(revision.id, "incarnation", true)).toBe(true)
    f.store.acceptCommand(revision.id, {
      id: "report-job", threadId: revision.threadId, command: "generate-report", cwd: "/reports",
      startedAt: Date.now(), notifyOnComplete: true
    })
    f.store.settle(revision.id, "completed", null, "The background job is still running")
    const check = (schedule = f.store.schedules()[0]) => f.store.settleScheduledWorkObservation(begin(f, schedule))
    const first = check(monitor)
    expect(first).toMatchObject({ kind: "silent", snapshot: { backgroundBusy: true } })
    expect(first.snapshot?.result).toEqual(monitor.workMonitor?.lastSuccessful?.result)

    if (exitCode === null) f.store.recover()
    else f.store.settleCommand({
      id: "report-job", threadId: revision.threadId, exitCode, output: "Report job outcome",
      cancelled: false, truncated: false
    })
    const callback = f.store.recentTasks().find(task => task.state === "queued" && task.origin.kind === "notification")!
    f.store.transition(callback.id, "running")
    expect(check().kind).toBe("silent")
    // The adapter completes the reporting turn when the model successfully
    // describes the command's failure, uncertainty or successful output.
    f.store.settle(callback.id, "completed", null,
      exitCode === 0 ? BOT_ROUTINE_SILENT : "The original command did not produce a confirmed report")
    if (reviewKind) {
      expect(check().kind).toBe("silent")
      f.store.flushReplies()
      const review = f.store.recentTasks().find(task =>
        task.state === "queued" && task.origin.kind === "work_result" && task.origin.review?.phase === "review")!
      f.store.transition(review.id, "running")
      expect(f.store.commitWorkResultReview(review.id, {
        kind: reviewKind, summary: "Report job outcome", evidenceIds: []
      })).toMatchObject({ state: "publish" })
      f.store.settle(review.id, "completed", null)
      f.store.flushReplies()
      const publication = f.store.nextQueued([])!
      expect(publication.origin).toMatchObject({ kind: "work_result", review: { phase: "publish" } })
      const pending = f.store.schedules()[0]
      f.store.fireSchedule(pending, "2030-01-01T00:20:00Z", true)
      expect(f.store.schedules()[0].workMonitor?.lastSuccessful?.result).toEqual(first.snapshot?.result)
      expect(f.store.pendingScheduledWorkPublications()).toEqual([])
      f.store.transition(publication.id, "running")
      expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
      f.store.settle(publication.id, "completed", null)
    } else if (exitCode !== 0) {
      settleReports(f)
      fillRecentCommandHistory(f)
      expect(f.db.exec("SELECT id FROM bot_commands WHERE id='report-job'")[0].values).toEqual([])
      f.advance(31 * DAY)
      fillRecentHistory(f)
      expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
      expect(f.store.getTask(callback.id).state).toBe("completed")
    }
    const result = { taskId: callback.id, state: "completed",
      ...(reviewKind ? { review: reviewKind } : exitCode !== 0
        ? { commandOutcome: exitCode === null ? "outcome_unknown" : "failed" } : {}) }
    expect(check()).toMatchObject({
      kind: "notify", snapshot: { backgroundBusy: false, result }
    })
    if (notice) {
      const [publication] = f.store.pendingScheduledWorkPublications()
      expect(publication.text).toContain(notice)
      expect(publication.text).not.toContain("最近一次执行结果为已完成")
    }
    expect(check().kind).toBe("silent")
    if (reviewKind === "blocked") {
      f.advance(1)
      const next = f.store.enqueue({
        botId: f.bot.id, workId: f.work.id, requestId: "recover-report", message: "Deliver the corrected report"
      })
      f.store.transition(next.id, "running")
      f.store.settle(next.id, "completed", null, "The corrected report is ready")
      settleReports(f)
      expect(check()).toMatchObject({
        kind: "notify", snapshot: { result: { taskId: next.id, state: "completed" } }
      })
    }
  })

  it.each(["failed", "outcome_unknown", "failed_and_unknown"] as const)(
    "preserves %s from parallel commands when the final callback succeeds",
    outcome => {
      const f = fixture()
      settleReports(f)
      const monitor = observe(f, "new_result")
      const send = (requestId: string) => f.store.enqueue({
        botId: f.bot.id, workId: f.work.id, requestId, message: "Generate the requested report"
      })
      const launcher = send("parallel-report")
      f.advance(1)
      f.store.transition(launcher.id, "running")
      const results = [
        ...(outcome !== "outcome_unknown" ? [{ id: "failing-command", exitCode: 1 }] : []),
        ...(outcome !== "failed" ? [{ id: "unknown-command", exitCode: null }] : []),
        { id: "successful-command", exitCode: 0 }
      ]
      for (const { id } of results) f.store.acceptCommand(launcher.id, {
        id, threadId: launcher.threadId, command: id, cwd: "/reports", startedAt: Date.now(), notifyOnComplete: true
      })
      f.store.settle(launcher.id, "completed", null, "Parallel commands started")
      let finalId = ""
      for (const { id, exitCode } of results) {
        f.advance(1)
        f.store.settleCommand({ id, threadId: launcher.threadId, exitCode, output: "Result",
          cancelled: false, truncated: false }, exitCode === null)
        const callback = f.store.recentTasks().find(task => task.origin.kind === "notification" && task.origin.key === id)!
        f.store.transition(callback.id, "running")
        f.store.settle(callback.id, "completed", null, "Reported the command outcome")
        finalId = callback.id
        if (outcome === "failed" && exitCode === 1) {
          fillRecentCommandHistory(f)
          expect(f.db.exec("SELECT id FROM bot_commands WHERE id='failing-command'")[0].values).toEqual([])
        }
      }
      const receipt = f.store.settleScheduledWorkObservation(begin(f, monitor))
      expect(receipt).toMatchObject({
        kind: "notify", snapshot: { result: { taskId: finalId, state: "completed", commandOutcome: outcome } }
      })
      const [publication] = f.store.pendingScheduledWorkPublications()
      expect(publication.text).toContain(outcome === "outcome_unknown" ? "待确认" : "失败")
      if (outcome === "failed_and_unknown") expect(publication.text).toContain("待确认")
      expect(publication.text).not.toContain("最近一次执行结果为已完成")
      expect(publication.text).not.toContain("当前执行已完成")

      f.advance(1)
      const independent = send("independent-report")
      f.store.transition(independent.id, "running")
      f.store.acceptCommand(independent.id, {
        id: "independent-command", threadId: independent.threadId, command: "generate-report", cwd: "/reports",
        startedAt: Date.now(), notifyOnComplete: true
      })
      f.store.settle(independent.id, "completed", null, "Independent command started")
      f.advance(1)
      f.store.settleCommand({ id: "independent-command", threadId: independent.threadId, exitCode: 0,
        output: "Success", cancelled: false, truncated: false })
      const callback = f.store.recentTasks().find(task =>
        task.origin.kind === "notification" && task.origin.key === "independent-command")!
      f.store.transition(callback.id, "running")
      f.store.settle(callback.id, "completed", null, "Independently verified and delivered")
      const next = f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0]))
      expect(next.snapshot?.result).toEqual({ taskId: callback.id, state: "completed" })
    }
  )

  it("reports a finite background command as pending after its launcher turn ends", () => {
    const f = fixture()
    settleReports(f)
    const run = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "launch-report", message: "Generate the report in the background"
    })
    f.store.transition(run.id, "running")
    const monitor = observe(f, "report")
    f.store.acceptCommand(run.id, {
      id: "report-job", threadId: run.threadId, command: "generate-report", cwd: "/reports",
      startedAt: Date.now(), notifyOnComplete: true
    })
    f.store.settle(run.id, "completed", null, "The background job is still running")

    const receipt = f.store.settleScheduledWorkObservation(begin(f, monitor))
    expect(receipt).toMatchObject({ kind: "notify", snapshot: { executionState: null, backgroundBusy: true } })
    expect(receipt.snapshot?.result).toEqual(monitor.workMonitor?.lastSuccessful?.result)
    const [publication] = f.store.pendingScheduledWorkPublications()
    expect(publication.text).toContain("后台工作仍在进行")
    expect(publication.text).not.toContain("当前执行已完成")
  })

  it("keeps the previous result when a new observer starts during a finite command and the command is stopped", () => {
    const f = fixture()
    settleReports(f)
    const revision = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "later-report", message: "Generate a new report"
    })
    f.store.transition(revision.id, "running")
    f.store.acceptCommand(revision.id, {
      id: "later-job", threadId: revision.threadId, command: "generate-report", cwd: "/reports",
      startedAt: Date.now(), notifyOnComplete: true
    })
    f.store.settle(revision.id, "completed", null, "Job started")

    const monitor = observe(f, "new_result")
    const previous = { taskId: f.task.id, state: "completed" }
    expect(monitor.workMonitor?.lastSuccessful).toMatchObject({
      result: previous, executionState: null, backgroundBusy: true
    })
    f.host.stopWork(f.bot.id, f.work.id)
    f.store.settleCommand({
      id: "later-job", threadId: revision.threadId, exitCode: null, output: "", cancelled: true, truncated: false
    })
    expect(f.store.settleScheduledWorkObservation(begin(f, monitor))).toMatchObject({
      kind: "silent", snapshot: { result: previous, backgroundBusy: false, dispatchStopped: true }
    })
    expect(f.store.pendingScheduledWorkPublications()).toEqual([])
  })

  it.each(["command", "history", "interrupted"] as const)(
    "reports the right result instead of the late callback through %s retention",
    (retention) => {
      const f = fixture()
      settleReports(f)
      const monitor = observe(f, "new_result")
      const submit = (requestId: string, message: string) => {
        const task = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId, message })
        f.store.transition(task.id, "running")
        f.store.recordPreparedInput(task.id, message)
        expect(f.store.armWorkResultReview(task.id, "incarnation", true)).toBe(true)
        return task
      }
      const original = submit("original-report", "Generate a report in the background")
      f.store.acceptCommand(original.id, {
        id: "old-job", threadId: original.threadId, command: "generate-report", cwd: "/reports",
        startedAt: Date.now(), notifyOnComplete: true
      })
      f.store.settle(original.id, "completed", null, "Waiting for the generator")
      const replacement = submit("replacement-report", "Use the saved report instead and disregard the generator")
      f.store.settle(replacement.id, "completed", null, "Verified the saved report")
      let expected = replacement.id
      if (retention !== "command") {
        // An independent routine can finish while the original finite command is still running.
        f.advance(1)
        const routine = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
        f.store.fireSchedule(routine, "2030-01-01T00:20:00Z")
        const scheduled = f.store.nextQueued([])!
        expect(scheduled.origin).toMatchObject({ kind: "schedule", scheduleId: routine.id })
        f.store.transition(scheduled.id, "running")
        f.store.settle(scheduled.id, "completed", null)
        expected = scheduled.id
        f.advance(1)
      }
      f.store.settleCommand({
        id: "old-job", threadId: original.threadId, exitCode: 1, output: "Old generator failed",
        cancelled: false, truncated: false
      })
      const callback = f.store.recentTasks().find(task => task.state === "queued" && task.origin.kind === "notification")!
      f.store.transition(callback.id, "running")
      if (retention === "command") {
        const owner = f.store.enqueue({ botId: f.bot.id, requestId: "other-job-owner", message: "Run other checks" })
        f.store.transition(owner.id, "running")
        for (let index = 0; index < 201; index++) {
          const id = `other-job-${index}`
          f.advance(1)
          f.store.acceptCommand(owner.id, {
            id, threadId: owner.threadId, command: "check", cwd: "/reports",
            startedAt: Date.now(), notifyOnComplete: false
          })
          f.store.settleCommand({ id, threadId: owner.threadId, exitCode: 0, output: "ok",
            cancelled: false, truncated: false })
        }
        f.store.settle(owner.id, "completed", null)
        f.store.flushReplies()
        expect(f.store.recentTasks().some(task =>
          task.state === "queued" && task.origin.kind === "work_result" && task.origin.review?.phase === "review"
        )).toBe(false)
      }
      f.store.settle(callback.id, "failed", "Old generator failed")
      f.store.flushReplies()
      const review = f.store.recentTasks().find(task =>
        task.state === "queued" && task.origin.kind === "work_result" && task.origin.review?.phase === "review")!
      expect(review.origin).toMatchObject({ executionTaskId: replacement.id })
      f.store.transition(review.id, "running")
      if (retention === "interrupted") {
        f.store.settle(review.id, "interrupted", "Interrupted during review")
        settleReports(f)
      } else {
        expect(f.store.commitWorkResultReview(review.id, {
          kind: "ready", summary: "Verified the saved report", evidenceIds: []
        })).toMatchObject({ state: "publish" })
        f.store.settle(review.id, "completed", null)
        f.store.flushReplies()
        const publication = f.store.recentTasks().find(task =>
          task.state === "queued" && task.origin.kind === "work_result" && task.origin.review?.phase === "publish")!
        expect(publication.origin).toMatchObject({ kind: "work_result", review: { phase: "publish" } })
        f.store.transition(publication.id, "running")
        expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
        f.store.settle(publication.id, "completed", null)
      }
      if (retention === "history") {
        settleReports(f)
        f.advance(31 * DAY)
        fillRecentHistory(f)
        expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
      }

      const check = (schedule = f.store.schedules()[0]) => f.store.settleScheduledWorkObservation(begin(f, schedule))
      expect(check(monitor)).toMatchObject({
        kind: "notify", snapshot: { executionState: "completed", result: { taskId: expected, state: "completed" } }
      })
      expect(f.store.pendingScheduledWorkPublications()[0].text).not.toContain("失败")
      expect(check().kind).toBe("silent")

      const finish = (taskId: string) => {
        f.store.transition(taskId, "running")
        f.store.settle(taskId, "completed", null)
        expect(check()).toMatchObject({ kind: "notify", snapshot: { result: { taskId, state: "completed" } } })
      }
      f.advance(1)
      const manual = f.store.enqueue({
        botId: f.bot.id, workId: f.work.id, requestId: "later-manual", message: "Verify the latest report"
      })
      finish(manual.id)
      f.advance(1)
      const routine = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, {
        ...f.binding, operationId: "later-routine"
      })
      f.store.fireSchedule(routine, "2030-01-01T00:20:00Z")
      const scheduled = f.store.nextQueued([])!
      expect(scheduled.origin).toMatchObject({ kind: "schedule", scheduleId: routine.id })
      finish(scheduled.id)
    }
  )

  it("does not publish a withdrawn job or block a later manual run in a stopped work", () => {
    const f = fixture()
    settleReports(f)
    const monitor = observe(f, "new_result")
    const revision = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "withdraw-report", message: "Run the report"
    })
    f.store.transition(revision.id, "running")
    f.store.acceptCommand(revision.id, {
      id: "withdrawn-job", threadId: revision.threadId, command: "generate-report", cwd: "/reports",
      startedAt: Date.now(), notifyOnComplete: true
    })
    f.store.settle(revision.id, "completed", null, "Job started")
    expect(f.store.settleScheduledWorkObservation(begin(f, monitor))).toMatchObject({
      kind: "silent", snapshot: { backgroundBusy: true, result: { taskId: f.task.id } }
    })
    f.host.stopWork(f.bot.id, f.work.id)
    f.store.settleCommand({
      id: "withdrawn-job", threadId: revision.threadId, exitCode: null, output: "",
      cancelled: true, truncated: false
    })
    expect(f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0]))).toMatchObject({
      kind: "silent", snapshot: { dispatchStopped: true, result: { taskId: f.task.id } }
    })

    f.advance(1)
    const unrelated = f.store.enqueue({ botId: f.bot.id, requestId: "unrelated", message: "Other work" })
    f.store.transition(unrelated.id, "running")
    for (let index = 0; index <= 200; index++) {
      const id = `unrelated-command-${index}`
      f.store.acceptCommand(unrelated.id, {
        id, threadId: unrelated.threadId, command: "check unrelated data", cwd: "/reports",
        startedAt: Date.now(), notifyOnComplete: false
      })
      f.store.settleCommand({
        id, threadId: unrelated.threadId, exitCode: 0, output: "", cancelled: false, truncated: false
      })
    }
    f.store.settle(unrelated.id, "completed", null)
    expect(f.db.exec("SELECT id FROM bot_commands WHERE id='withdrawn-job'")[0].values).toEqual([])
    expect(f.store.getTask(revision.id).state).toBe("completed")
    expect(f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0]))).toMatchObject({
      kind: "silent", snapshot: { dispatchStopped: true, result: { taskId: f.task.id } }
    })
    expect(f.store.pendingScheduledWorkPublications()).toEqual([])

    const manual = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "manual-report", message: "Manually check the saved report"
    })
    f.store.transition(manual.id, "running")
    f.store.settle(manual.id, "completed", null, "Verified saved report")
    expect(f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0]))).toMatchObject({
      kind: "notify", snapshot: { dispatchStopped: true, result: { taskId: manual.id, state: "completed" } }
    })
  })

  it("reports the last real settlement when observing after an ordinary Stop", () => {
    const f = fixture()
    settleReports(f)
    const revision = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "later-report", message: "Generate a new report"
    })
    f.store.transition(revision.id, "running")
    f.store.acceptCommand(revision.id, {
      id: "stopped-job", threadId: revision.threadId, command: "generate-report", cwd: "/reports",
      startedAt: Date.now(), notifyOnComplete: true
    })
    f.store.settle(revision.id, "completed", null, "Job started")
    f.advance(31 * DAY)
    fillRecentHistory(f)
    expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)

    f.host.stopConversation(f.bot.id, undefined, f.work.id)
    f.store.settleCommand({
      id: "stopped-job", threadId: revision.threadId, exitCode: null, output: "",
      cancelled: true, truncated: false
    })

    const report = observe(f, "report")
    expect(f.store.settleScheduledWorkObservation(begin(f, report))).toMatchObject({
      kind: "notify",
      snapshot: { dispatchStopped: false, backgroundBusy: false, result: { taskId: f.task.id, state: "completed" } }
    })
    expect(f.store.pendingScheduledWorkPublications()[0]?.text).toContain("最近一次执行结果为已完成")
  })

  it.each(["queued", "running", "completed", "legacy"] as const)(
    "reports the real settlement after a %s command callback",
    async callbackState => {
      const f = fixture(callbackState === "running" ? {
        acquire: (_bot, task) => task.origin.kind === "notification" ? {
          execute: signal => new Promise<{ state: "completed" }>(resolve => {
            // The Host derives cancellation from the aborted signal.
            if (signal.aborted) resolve({ state: "completed" })
            else signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true })
          }),
          release: () => {}
        } : null
      } : undefined)
      settleReports(f)
      f.host.changeWorkControl({ botId: f.bot.id, workId: f.work.id,
        expectedVersion: f.store.getWork(f.bot.id, f.work.id).version, operationId: "take", action: "take" })
      f.advance(1)
      const launcher = await f.host.sendDesktopMessage({
        botId: f.bot.id, workId: f.work.id, requestId: "launch-revision", message: "Generate a new report"
      })
      f.store.transition(launcher.id, "running")
      f.store.acceptCommand(launcher.id, {
        id: "revision-job", threadId: launcher.threadId, command: "generate-report", cwd: "/reports",
        startedAt: Date.now(), notifyOnComplete: true
      })
      f.store.settle(launcher.id, "completed", null, "Job started")
      f.advance(1)
      f.store.settleCommand({ id: "revision-job", threadId: launcher.threadId, exitCode: 0,
        output: "Report generated", cancelled: false, truncated: false })
      f.host.resume()
      await new Promise<void>(resolve => setImmediate(resolve))
      const callback = f.store.recentTasks().find(task => task.origin.kind === "notification")!
      expect(callback.state).toBe(callbackState === "running" ? "running" : "queued")
      f.advance(1)
      const completed = callbackState === "completed" || callbackState === "legacy"
      if (completed) {
        f.store.transition(callback.id, "running")
        f.store.settle(callback.id, "completed", null, "Verified the new report")
        if (callbackState === "legacy") {
          f.db.run("UPDATE bot_tasks SET origin_json=json_remove(origin_json,'$.observationAwaitingResult') WHERE id=?",
            [callback.id])
          fillRecentCommandHistory(f)
          expect(f.db.exec("SELECT id FROM bot_commands WHERE id='revision-job'")[0].values).toEqual([])
        }
      } else {
        f.host.stopWork(f.bot.id, f.work.id)
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(f.store.getTask(callback.id).state).toBe("cancelled")
      }
      settleReports(f)

      const expected = { taskId: completed ? callback.id : f.task.id, state: "completed" }
      const report = observe(f, "report")
      expect(f.store.settleScheduledWorkObservation(begin(f, report))).toMatchObject({
        kind: "notify", snapshot: {
          result: expected, executionState: completed ? "completed" : "cancelled"
        }
      })
      const [notice] = f.store.pendingScheduledWorkPublications()
      expect(notice.text).toContain("最近一次执行结果为已完成")
      if (!completed) expect(notice.text).toContain("当前执行已停止")
      f.store.acknowledgeScheduledWorkPublication(notice.taskId)

      f.advance(31 * DAY)
      fillRecentHistory(f)
      expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
      expect(f.store.getTask(expected.taskId).state).toBe("completed")
      if (!completed) expect(() => f.store.getTask(callback.id)).toThrow()
      const afterRetention = observe(f, "report", undefined, interval, "observe-after-callback-retention")
      expect(afterRetention.workMonitor?.lastSuccessful?.result).toEqual(expected)

      if (callbackState === "queued") {
        fillRecentCommandHistory(f)
        expect(f.db.exec("SELECT id FROM bot_commands WHERE id='revision-job'")[0].values).toEqual([])
        expect(f.store.getTask(launcher.id).state).toBe("completed")
        const afterReceiptPruning = observe(f, "report", undefined, interval, "observe-after-command-retention")
        expect(afterReceiptPruning.workMonitor?.lastSuccessful?.result).toEqual(expected)
      }
    }
  )

  it.each(["stopped", "legacy", "completed", "independent", "recovered", "recovered-completed", "legacy-upgrade"] as const)(
    "observes the latest settled outcome across nested command callbacks (%s)",
    outcome => {
      const f = fixture()
      settleReports(f)
      f.host.changeWorkControl({ botId: f.bot.id, workId: f.work.id,
        expectedVersion: f.store.getWork(f.bot.id, f.work.id).version, operationId: "take", action: "take" })
      const send = (requestId: string) => f.store.enqueue({
        botId: f.bot.id, workId: f.work.id, requestId, message: "Generate and verify the report"
      })
      const runBackground = (launcher: ReturnType<typeof send>, id: string, recover = false) => {
        f.advance(1)
        f.store.transition(launcher.id, "running")
        f.store.acceptCommand(launcher.id, { id, threadId: launcher.threadId, command: id,
          cwd: "/reports", startedAt: Date.now(), notifyOnComplete: true })
        f.store.settle(launcher.id, "completed", null, "Job started")
        f.advance(1)
        if (recover) f.store.recover()
        else f.store.settleCommand({ id, threadId: launcher.threadId, exitCode: 0, output: "OK",
          cancelled: false, truncated: false })
        return f.store.recentTasks().find(task => task.origin.kind === "notification" && task.origin.key === id)!
      }
      const original = send("report-revision")
      const recovered = outcome === "recovered" || outcome === "recovered-completed" || outcome === "legacy-upgrade"
      const intermediate = runBackground(original, "generate", recovered)
      const final = runBackground(intermediate, "verify")
      expect(f.db.exec("SELECT source_task_id FROM bot_commands ORDER BY id")[0].values)
        .toEqual([[original.id], [recovered ? intermediate.id : original.id]])
      expect(f.store.getTask(intermediate.id).origin).toMatchObject({ observationAwaitingResult: 1 })
      if (outcome === "legacy") {
        f.db.run("UPDATE bot_tasks SET origin_json=json_remove(origin_json,'$.observationAwaitingResult') WHERE id=?",
          [intermediate.id])
      }
      if (outcome === "legacy-upgrade") {
        // The pre-upgrade database still has both exact receipts. The nested
        // receipt must preserve its original execution before the parent ages out.
        f.db.run("DROP INDEX bot_commands_observation_root")
        f.db.run("ALTER TABLE bot_commands DROP COLUMN observation_root_task_id")
        f.reopen()
        expect(f.db.exec("SELECT observation_root_task_id FROM bot_commands WHERE id='verify'")[0].values)
          .toEqual([[original.id]])
        fillRecentCommandHistory(f, "-pre-migration-result")
        expect(f.db.exec("SELECT id FROM bot_commands WHERE id='generate'")[0].values).toEqual([])
        f.advance(31 * DAY)
        fillRecentHistory(f, "-pre-migration-result")
        expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
        expect(f.store.getTask(original.id).state).toBe("completed")
      }

      let expectedTaskId = f.task.id
      f.advance(1)
      if (outcome === "completed" || outcome === "recovered-completed" || outcome === "legacy-upgrade") {
        // A separate queued request must not make this final callback intermediate.
        const unrelated = send("unrelated-work-input")
        f.store.transition(final.id, "running")
        f.store.settle(final.id, "completed", null, BOT_ROUTINE_SILENT)
        expect(f.store.getTask(final.id).origin).toMatchObject({ observationAwaitingResult: 0 })
        f.store.transition(unrelated.id, "cancelled")
        expectedTaskId = final.id
      } else {
        f.host.stopWork(f.bot.id, f.work.id)
        expect(f.store.getTask(final.id).state).toBe("cancelled")
        if (outcome === "independent") {
          const next = runBackground(send("independent-report"), "independent")
          f.advance(1)
          f.store.transition(next.id, "running")
          f.store.settle(next.id, "completed", null, "Delivered the independently verified report")
          expectedTaskId = next.id
        }
      }
      settleReports(f)
      const expected = { taskId: expectedTaskId, state: "completed",
        ...(recovered && expectedTaskId === final.id ? { commandOutcome: "outcome_unknown" } : {}) }
      const report = observe(f, "report")
      expect(f.store.settleScheduledWorkObservation(begin(f, report))).toMatchObject({
        kind: "notify", snapshot: { result: expected }
      })

      fillRecentCommandHistory(f)
      expect(f.db.exec("SELECT id FROM bot_commands WHERE id IN ('generate','verify','independent')")[0].values).toEqual([])
      expect(observe(f, "report", undefined, interval, "observe-after-command-retention")
        .workMonitor?.lastSuccessful?.result).toEqual(expected)
      f.advance(31 * DAY)
      fillRecentHistory(f)
      expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
      expect(f.store.getTask(expectedTaskId).state).toBe("completed")
      expect(observe(f, "report", undefined, interval, "observe-after-task-retention")
        .workMonitor?.lastSuccessful?.result).toEqual(expected)
    }
  )

  it("finds a newer result beyond a page of stopped background launches without querying each launch", async () => {
    const cancelBackground = vi.fn()
    const f = fixture({
      cancelBackground,
      scheduleObservationPublication: { persist() {}, async announce() {} }
    })
    const report = observe(f, "report")
    expect(report.workMonitor?.lastSuccessful?.result).toEqual({
      taskId: f.task.id, state: "completed"
    })
    f.host.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: f.store.getWork(f.bot.id, f.work.id).version,
      operationId: "take-report", action: "take"
    })
    async function startWorkTurn(requestId: string, message: string) {
      const task = await f.host.sendDesktopMessage({ botId: f.bot.id, workId: f.work.id, requestId, message })
      f.store.transition(task.id, "running")
      return task
    }

    f.advance(1)
    const result = await startWorkTurn("revised-report", "Revise the report")
    f.store.settle(result.id, "completed", null, "The revised report is ready")
    // Same timestamps force the cursor to use rowid across the page boundary.
    for (let index = 0; index < 34; index++) {
      const id = `stopped-report-job-${index}`
      const launcher = await startWorkTurn(id, "Regenerate the report in the background")
      const commands = f.host.commandLifecycle(launcher.id)
      commands.accepted({
        id, threadId: launcher.threadId, command: "generate-report",
        cwd: "/reports", startedAt: Date.now(), notifyOnComplete: true
      })
      f.store.settle(launcher.id, "completed", null, "Job started")
      f.host.stopConversation(f.bot.id, undefined, f.work.id)
      commands.settled({
        id, threadId: launcher.threadId, exitCode: null, output: "", cancelled: true, truncated: false
      })
    }
    expect(cancelBackground).toHaveBeenCalledTimes(34)

    const prepare = vi.spyOn(f.db, "prepare")
    f.advance(600_000)
    f.host.resume()

    expect(f.store.schedules().find(item => item.id === report.id)?.workMonitor?.lastSuccessful?.result)
      .toEqual({ taskId: result.id, state: "completed" })
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("AS launcher_without_result"))).toHaveLength(3)
  })

  it("keeps the previous settlement when Stop withdraws a command result before admission", () => {
    const f = fixture()
    settleReports(f)
    const launcher = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "revision", message: "Regenerate the report"
    })
    f.store.transition(launcher.id, "running")
    f.store.acceptCommand(launcher.id, { id: "generate", threadId: launcher.threadId, command: "generate",
      cwd: "/reports", startedAt: Date.now(), notifyOnComplete: true })
    f.store.settle(launcher.id, "completed", null, "Job started")
    // Seed exactly the admission boundary without dispatching other work.
    f.db.run(`WITH RECURSIVE queued(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM queued WHERE n<500)
      INSERT INTO bot_tasks(id,bot_id,request_id,thread_id,message,state,created_at,updated_at,origin_json)
      SELECT 'queued-'||n,?, 'queued-'||n, ?, 'Other pending work', 'queued', ?, ?, '{"kind":"user"}' FROM queued`,
      [f.bot.id, f.bot.threadId, Date.now(), Date.now()])
    f.store.settleCommand({ id: "generate", threadId: launcher.threadId, exitCode: 0, output: "OK",
      cancelled: false, truncated: false })
    expect(f.store.hasPendingCommandNotifications()).toBe(true)
    f.host.stopConversation(f.bot.id, undefined, f.work.id)
    expect(f.store.hasPendingCommandNotifications()).toBe(false)
    f.db.run("DELETE FROM bot_tasks WHERE id LIKE 'queued-%'")
    settleReports(f)
    const expected = { taskId: f.task.id, state: "completed" }
    expect(observe(f, "report").workMonitor?.lastSuccessful?.result).toEqual(expected)

    fillRecentCommandHistory(f)
    expect(f.db.exec("SELECT id FROM bot_commands WHERE id='generate'")[0].values).toEqual([])
    expect(observe(f, "report", undefined, interval, "observe-after-command-retention")
      .workMonitor?.lastSuccessful?.result).toEqual(expected)
  })

  it("keeps the previous settlement after an exact peer callback is withdrawn", () => {
    const f = fixture()
    settleReports(f)
    f.advance(1)
    const peer = f.store.create({ name: "Peer", instructions: "", color: "#123456", modelRef: null })
    const launcher = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "launch-peer", message: "Ask the peer for a report"
    })
    f.store.transition(launcher.id, "running")
    const delegated = f.store.delegate(launcher.id, peer.id, "Generate report", "peer")
    f.store.transition(delegated.id, "running")
    f.store.settle(launcher.id, "completed", null, "Waiting for report")
    f.advance(1)
    f.store.settle(delegated.id, "completed", null, "Generated report")
    f.store.flushReplies()
    const callback = f.store.recentTasks().find(task => task.requestId === `reply-${delegated.id}`)!
    f.host.stopWork(f.bot.id, f.work.id)
    expect(f.store.getTask(callback.id).state).toBe("cancelled")
    settleReports(f)
    const report = observe(f, "report")
    const expected = { taskId: f.task.id, state: "completed" }
    expect(f.store.settleScheduledWorkObservation(begin(f, report))).toMatchObject({
      kind: "notify", snapshot: { result: expected, executionState: "cancelled" }
    })
    f.advance(31 * DAY)
    fillRecentHistory(f)
    expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
    const afterRetention = observe(f, "report", undefined, interval, "observe-after-peer-retention")
    expect(afterRetention.workMonitor?.lastSuccessful?.result).toEqual(expected)
  })

  it.each(["completed", "failed"] as const)(
    "keeps an already published outcome when Stop withdraws the next queued publication (%s execution)",
    (executionState) => {
      const f = fixture()
      settleReports(f)
      const original = beginReviewedRevision(f, "reviewed-report")
      f.store.settle(original.id, "completed", null, "Verified report")
      publishReviewedResult(f, { kind: "ready", summary: "Verified report" })
      const previousResult = { taskId: original.id, state: "completed", review: "ready" }
      const monitor = observe(f, "new_result")
      expect(monitor.workMonitor?.lastSuccessful?.result).toEqual(previousResult)
      const progress = observe(f, "change", undefined, interval, "watch-execution-changes")

      const revision = beginReviewedRevision(f, "review-to-withdraw")
      const failed = executionState === "failed"
      const summary = failed ? "Could not generate revised report" : "Revised report verified"
      f.store.settle(revision.id, executionState, failed ? "Generation failed" : null, summary)
      f.store.flushReplies()
      const review = f.store.nextQueued([])!
      expect(review.origin).toMatchObject({ kind: "work_result", review: { phase: "review" } })
      f.store.transition(review.id, "running")
      expect(f.store.commitWorkResultReview(review.id, {
        kind: failed ? "blocked" : "ready", summary, evidenceIds: []
      })).toMatchObject({ state: "publish" })
      f.store.settle(review.id, "completed", null)
      f.store.flushReplies()
      const publication = f.store.nextQueued([])!
      expect(publication.origin).toMatchObject({ kind: "work_result", review: { phase: "publish" } })
      expect(publication.state).toBe("queued")
      const pendingWork = f.store.getWork(f.bot.id, f.work.id)
      expect(pendingWork.resultConclusion).toBeUndefined()
      if (failed) expect(resolveBotWorkStatus(pendingWork).label).toBe("执行失败")

      f.host.stopWork(f.bot.id, f.work.id)
      expect(f.store.getTask(publication.id).state).toBe("cancelled")
      expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toBeUndefined()
      const { store } = f.reopen()
      const reopenedMonitor = store.schedules().find(schedule => schedule.id === monitor.id)!
      store.fireSchedule(reopenedMonitor, "2030-01-01T00:20:00Z", true)
      expect(store.schedules().find(schedule => schedule.id === monitor.id)?.workMonitor?.lastSuccessful)
        .toMatchObject({ dispatchStopped: true, executionState, result: previousResult })
      expect(store.pendingScheduledWorkPublications()).toEqual([])

      const reopenedProgress = store.schedules().find(schedule => schedule.id === progress.id)!
      store.fireSchedule(reopenedProgress, "2030-01-01T00:20:00Z", true)
      const [notice] = store.pendingScheduledWorkPublications()
      expect(notice.text).toContain("最近一次成果已核查")
      expect(notice.text).toContain("已停止自动派发")
      expect(notice.text).not.toContain(summary)
      expect(notice.text).not.toContain("当前执行已完成")
      if (failed) expect(notice.text).toContain("当前执行执行失败")
    }
  )

  it.each([
    { executionState: "interrupted", action: "stop" },
    { executionState: "interrupted", action: "acknowledge" },
    { executionState: "outcome_unknown", action: "stop" },
    { executionState: "outcome_unknown", action: "acknowledge" }
  ] as const)(
    "keeps the previous result until the paused review's $executionState publication receives $action",
    ({ executionState, action }) => {
      const f = fixture()
      settleReports(f)
      const original = beginReviewedRevision(f, "verified-report")
      f.store.settle(original.id, "completed", null, "Verified report")
      publishReviewedResult(f, { kind: "ready", summary: "Verified report" })
      const monitor = observe(f, "new_result")
      const previousResult = { taskId: original.id, state: "completed", review: "ready" }
      expect(monitor.workMonitor?.lastSuccessful?.result).toEqual(previousResult)

      const revision = beginReviewedRevision(f, "revision-to-interrupt")
      const pause = f.store.enqueue({ botId: f.bot.id, requestId: "pause-review",
        message: "Keep running, but pause automatic review and repair" })
      f.store.transition(pause.id, "running")
      f.store.recordPreparedInput(pause.id, pause.message)
      expect(f.store.requestWorkReviewPause({ taskId: pause.id, callId: "pause", key: "pause" },
        f.work.id, f.store.getWork(f.bot.id, f.work.id).version).reviewPaused).toBe(true)
      f.store.settle(pause.id, "completed", null)
      if (executionState === "interrupted") f.store.recover()
      else f.store.settle(revision.id, executionState, "Command outcome not confirmed")

      f.store.flushReplies()
      const publication = f.store.nextQueued([])!
      expect(publication).toMatchObject({ state: "queued", origin: {
        kind: "work_result", executionTaskId: revision.id, review: { phase: "publish" }
      } })
      expect(publication.requestId).toMatch(/-interrupted$/)
      const check = () => {
        const schedule = f.store.schedules().find(item => item.id === monitor.id)!
        f.advance(600_000)
        f.store.fireSchedule(schedule, new Date(Date.now() + 600_000).toISOString(), true)
        return f.store.schedules().find(item => item.id === monitor.id)?.workMonitor?.lastSuccessful
      }
      expect.soft(check()).toMatchObject({ executionState, result: previousResult })
      expect.soft(f.store.getWork(f.bot.id, f.work.id).executionState).toBe(executionState)
      expect.soft(f.store.pendingScheduledWorkPublications()).toEqual([])

      if (action === "stop") {
        f.host.stopWork(f.bot.id, f.work.id)
        expect(f.store.getTask(publication.id).state).toBe("cancelled")
        expect(check()).toMatchObject({ dispatchStopped: true, executionState, result: previousResult })
        expect(f.store.pendingScheduledWorkPublications()).toEqual([])
      } else {
        f.store.transition(publication.id, "running")
        expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
        f.store.settle(publication.id, "completed", null)
        const result = { taskId: revision.id, state: executionState }
        expect(check()).toMatchObject({ executionState, result })
        expect(f.store.pendingScheduledWorkPublications()).toMatchObject([
          { text: expect.stringContaining("最近一次执行结果") }
        ])
        const [notice] = f.store.pendingScheduledWorkPublications()
        expect(f.store.acknowledgeScheduledWorkPublication(notice.taskId)).toBe(true)
        expect(check()).toMatchObject({ executionState, result })
        expect(f.store.pendingScheduledWorkPublications()).toEqual([])
      }
    }
  )

  it.each([
    ["interrupted", "已中断"],
    ["outcome_unknown", "结果待确认"]
  ] as const)("reports a current %s revision separately from the previous verified result", (executionState, stateLabel) => {
    const f = fixture()
    settleReports(f)
    const original = beginReviewedRevision(f, "verified-report-before-interruption")
    f.store.settle(original.id, "completed", null, "Verified report")
    publishReviewedResult(f, { kind: "ready", summary: "Verified report" })
    const previousResult = { taskId: original.id, state: "completed", review: "ready" }
    const report = observe(f, "report", undefined, interval, "report-current-progress")
    const change = observe(f, "change", undefined, interval, "watch-progress-changes")
    const newResult = observe(f, "new_result", undefined, interval, "watch-new-result")
    const routine = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)

    const revision = beginReviewedRevision(f, "revision-that-stops")
    if (executionState === "interrupted") f.store.recover()
    else f.store.settle(revision.id, executionState, "Command outcome not confirmed")
    expect(f.store.getWork(f.bot.id, f.work.id)).toMatchObject({
      executionState, resultReviewState: "interrupted"
    })
    f.store.flushReplies()
    const publication = f.store.nextQueued([])!
    expect(f.store.getTask(publication.id)).toMatchObject({
      state: "queued",
      origin: { kind: "work_result", executionTaskId: revision.id, review: { phase: "publish" } }
    })
    expect(publication.requestId).toMatch(/-interrupted$/)

    const check = (id: string) => {
      const schedule = f.store.schedules().find(item => item.id === id)!
      f.store.fireSchedule(schedule, new Date(Date.now() + 600_000).toISOString(), true)
      return f.store.schedules().find(item => item.id === id)?.workMonitor?.lastSuccessful
    }
    const checkObservations = (expectChangeNotice: boolean) => {
      f.advance(600_000)
      expect.soft(check(report.id)).toMatchObject({ executionState, result: previousResult })
      const notices = f.store.pendingScheduledWorkPublications()
      expect(notices).toHaveLength(1)
      expect.soft(notices[0].text).toContain(stateLabel)
      expect(notices[0].text).toContain("最近一次成果已核查")
      expect(f.store.acknowledgeScheduledWorkPublication(notices[0].taskId)).toBe(true)
      expect.soft(check(change.id)).toMatchObject({ executionState, result: previousResult })
      const changes = f.store.pendingScheduledWorkPublications()
      expect(changes).toHaveLength(expectChangeNotice ? 1 : 0)
      if (expectChangeNotice) {
        expect(changes[0].text).toContain(stateLabel)
        expect(changes[0].text).toContain("最近一次成果已核查")
        expect(f.store.acknowledgeScheduledWorkPublication(changes[0].taskId)).toBe(true)
      }
      expect.soft(check(newResult.id)).toMatchObject({ executionState, result: previousResult })
      expect(f.store.pendingScheduledWorkPublications()).toEqual([])
    }
    checkObservations(true)

    f.store.transition(publication.id, "running")
    expect(f.store.getWorkResultPublication(publication.id)?.kind).toBe("interrupted")
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    f.store.settle(publication.id, "completed", null)

    const taking = f.store.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: f.store.getWork(f.bot.id, f.work.id).version,
      operationId: "take-interrupted-work", action: "take"
    })
    expect(taking.userControl).toMatchObject({ settling: true })
    expect(f.store.finishWorkControlHandoffs(new Set())).toBe(true)
    f.store.fireSchedule(routine, new Date(Date.now() + 600_000).toISOString())
    expect(f.triggers().find(task => task.origin.kind === "schedule" && task.origin.scheduleId === routine.id))
      .toMatchObject({ state: "queued", workId: f.work.id })
    expect(f.store.getWork(f.bot.id, f.work.id)).toMatchObject({
      executionState, resultReviewState: "interrupted", userControl: { settling: false, heldInputs: 1 }
    })
    expect(f.store.nextQueued([])).toBeNull()
    checkObservations(false)
  })

  it.each([
    ["interrupted", "已中断"],
    ["outcome_unknown", "结果待确认"]
  ] as const)("keeps the current %s revision observable after withdrawing automatic review", (executionState, stateLabel) => {
    const f = fixture()
    settleReports(f)
    const original = beginReviewedRevision(f, "verified-report-before-withdrawal")
    f.store.settle(original.id, "completed", null, "Verified report")
    publishReviewedResult(f, { kind: "ready", summary: "Verified report" })
    const previousResult = { taskId: original.id, state: "completed", review: "ready" }
    const change = observe(f, "change", undefined, interval, "watch-withdrawn-review")
    const newResult = observe(f, "new_result", undefined, interval, "watch-new-report")

    const revision = beginReviewedRevision(f, "revision-before-withdrawal")
    if (executionState === "interrupted") f.store.recover()
    else f.store.settle(revision.id, executionState, "Command outcome not confirmed")
    f.store.flushReplies()
    const publication = f.store.nextQueued([])!
    expect(publication.requestId).toMatch(/-interrupted$/)
    f.store.transition(publication.id, "running")
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    f.store.settle(publication.id, "completed", null)

    const user = f.store.enqueue({ botId: f.bot.id, requestId: "withdraw-review",
      message: "Stop checking this report automatically, and keep watching its progress" })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    expect(f.store.requestWorkReviewPause({ taskId: user.id, callId: "pause", key: "pause" },
      f.work.id, f.store.getWork(f.bot.id, f.work.id).version))
      .toMatchObject({ scope: "review", reviewPaused: true })
    f.store.settle(user.id, "completed", null)
    const work = f.store.getWork(f.bot.id, f.work.id)
    expect(work.executionState).toBe(executionState)
    expect(work.resultReviewState).toBeUndefined()
    expect(work.dispatchStopped).toBeFalsy()

    const check = (id: string) => {
      const schedule = f.store.schedules().find(item => item.id === id)!
      f.store.fireSchedule(schedule, new Date(Date.now() + 600_000).toISOString(), true)
      return f.store.schedules().find(item => item.id === id)?.workMonitor?.lastSuccessful
    }
    f.advance(600_000)
    expect(check(change.id)).toMatchObject({ executionState, result: previousResult })
    const notices = f.store.pendingScheduledWorkPublications()
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toContain(stateLabel)
    expect(notices[0].text).toContain("最近一次成果已核查")
    expect(f.store.acknowledgeScheduledWorkPublication(notices[0].taskId)).toBe(true)
    expect(check(newResult.id)).toMatchObject({ executionState, result: previousResult })
    expect(f.store.pendingScheduledWorkPublications()).toEqual([])

    f.advance(600_000)
    expect(check(change.id)).toMatchObject({ executionState, result: previousResult })
    expect(f.store.pendingScheduledWorkPublications()).toEqual([])
  })

  it.each(["ready", "blocked"] as const)("waits for the resumed review's final %s acknowledgement even after acknowledging its interruption", (kind) => {
    const f = fixture()
    settleReports(f)
    const original = beginReviewedRevision(f, "first-verified-report")
    f.store.settle(original.id, "completed", null, "Verified report")
    publishReviewedResult(f, { kind: "ready", summary: "Verified report" })
    const monitor = observe(f, "new_result")
    const previousResult = { taskId: original.id, state: "completed", review: "ready" }
    expect(monitor.workMonitor?.lastSuccessful?.result).toEqual(previousResult)

    const revision = beginReviewedRevision(f, "interrupted-report")
    f.store.recover()
    expect(resolveBotWorkStatus(f.store.getWork(f.bot.id, f.work.id))).toEqual({
      label: "需要核对结果", tone: "error", icon: "alert"
    })
    f.store.flushReplies()
    const interrupted = f.store.nextQueued([])!
    expect(interrupted.requestId).toMatch(/-interrupted$/)
    f.store.transition(interrupted.id, "running")
    expect(f.store.acknowledgeWorkResultPublication(interrupted.id)).toBe(true)
    f.store.settle(interrupted.id, "completed", null)

    const user = f.store.enqueue({ botId: f.bot.id, requestId: "resume-review",
      message: "Continue checking the saved report without running it again" })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    const source = { taskId: user.id, callId: "continue", key: "continue" }
    const waiting = f.store.changeWork(f.bot.id, f.work.id, f.store.getWork(f.bot.id, f.work.id).version,
      source.callId, "continue", source)
    expect(waiting).toMatchObject({ executionState: "interrupted", resultReviewState: "waiting" })
    expect.soft(resolveBotWorkStatus(waiting).label).toBe("等待回传")
    f.store.settle(user.id, "completed", null)
    f.store.flushReplies()
    const resumed = f.store.nextQueued([])!
    expect(resumed.origin).toMatchObject({
      kind: "work_result", executionTaskId: revision.id, review: { phase: "review" }
    })
    f.store.transition(resumed.id, "running")
    const checking = f.store.getWork(f.bot.id, f.work.id)
    expect(checking).toMatchObject({ executionState: "interrupted", resultReviewState: "checking" })
    expect.soft(resolveBotWorkStatus(checking).label).toBe("正在整理结果")
    expect(f.store.getWorkResultReview(resumed.id)?.outcome.state).toBe("interrupted")
    const summary = kind === "ready" ? "The saved report checks out" : "The saved report is missing its final page"
    expect(f.store.commitWorkResultReview(resumed.id,
      { kind, summary, evidenceIds: [] }).state).toBe("publish")
    f.store.settle(resumed.id, "completed", null)
    f.store.flushReplies()
    const publication = f.store.nextQueued([])!
    expect(publication.requestId).toMatch(/-final$/)
    expect(publication.state).toBe("queued")
    const pending = f.store.getWork(f.bot.id, f.work.id)
    expect(pending.resultConclusion).toBeUndefined()
    expect(resolveBotWorkStatus(pending)).toEqual({ label: "需要核对结果", tone: "error", icon: "alert" })

    const check = () => {
      const schedule = f.store.schedules().find(item => item.id === monitor.id)!
      f.advance(600_000)
      f.store.fireSchedule(schedule, new Date(Date.now() + 600_000).toISOString(), true)
      return f.store.schedules().find(item => item.id === monitor.id)?.workMonitor?.lastSuccessful
    }
    expect.soft(check()).toMatchObject({ executionState: "interrupted", result: previousResult })
    expect.soft(f.store.pendingScheduledWorkPublications()).toEqual([])

    f.store.transition(publication.id, "running")
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    f.store.settle(publication.id, "completed", null)
    const published = f.store.getWork(f.bot.id, f.work.id)
    expect(published).toMatchObject({ executionState: "interrupted", resultConclusion: { kind, summary } })
    expect.soft(resolveBotWorkStatus(published)).toMatchObject({
      label: kind === "ready" ? "成果已就绪" : "成果待核对",
      summary
    })
    expect(check()).toMatchObject({
      executionState: "interrupted", result: { taskId: revision.id, state: "interrupted", review: kind }
    })
    expect(f.store.pendingScheduledWorkPublications()).toMatchObject([
      { text: expect.stringContaining(kind === "ready" ? "最近一次成果已核查" : "成果仍有阻碍或待核验") }
    ])
  })

  it.each(["running", "late callback", "newer routine result"] as const)(
    "keeps a previously delivered settlement after stopping a newer review (%s)",
    (revisionState) => {
      const f = fixture()
      settleReports(f)
      const sendRevision = (requestId: string) => {
        f.advance(1)
        const user = f.store.enqueue({ botId: f.bot.id, requestId, message: "Revise the existing report" })
        f.store.transition(user.id, "running")
        f.store.recordPreparedInput(user.id, user.message)
        const revision = f.store.sendWork({ taskId: user.id, callId: "send", key: "send" },
          f.work.id, user.message)
        f.store.settle(user.id, "completed", null)
        f.store.transition(revision.id, "running")
        f.store.recordPreparedInput(revision.id, revision.message)
        expect(f.store.armWorkResultReview(revision.id, "incarnation")).toBe(true)
        return revision
      }

      const original = sendRevision("reviewed-report")
      f.store.settle(original.id, "completed", null, "Verified report")
      f.store.flushReplies()
      const review = f.store.nextQueued([])!
      expect(review.origin).toMatchObject({ kind: "work_result", review: { phase: "review" } })
      f.store.transition(review.id, "running")
      f.store.commitWorkResultReview(review.id, { kind: "ready", summary: "Verified report", evidenceIds: [] })
      f.store.settle(review.id, "completed", null)
      f.store.flushReplies()
      const publication = f.store.nextQueued([])!
      expect(publication.origin).toMatchObject({ kind: "work_result", review: { phase: "publish" } })
      f.store.transition(publication.id, "running")
      expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
      f.store.settle(publication.id, "completed", null)
      let previous: NonNullable<BotScheduledWorkSnapshot["result"]> = {
        taskId: original.id, state: "completed", review: "ready"
      }
      if (revisionState === "newer routine result") {
        f.advance(1)
        const routine = f.host.saveSchedule(f.bot.id, interval, undefined, undefined, f.binding)
        f.store.fireSchedule(routine, "2030-01-01T00:20:00Z")
        const execution = f.store.nextQueued([])!
        expect(execution.origin).toMatchObject({ kind: "schedule", scheduleId: routine.id })
        f.store.transition(execution.id, "running")
        f.store.settle(execution.id, "failed", "The scheduled update failed")
        settleReports(f)
        previous = { taskId: execution.id, state: "failed" }
      }

      const revision = sendRevision("revision-to-stop")
      if (revisionState === "late callback") {
        f.store.acceptCommand(revision.id, {
          id: "older-revision-job", threadId: revision.threadId, command: "generate-report",
          cwd: "/reports", startedAt: Date.now(), notifyOnComplete: true
        })
        f.store.settle(revision.id, "completed", null, "Background generator started")
        const newer = sendRevision("use-saved-report")
        f.store.settle(newer.id, "completed", null, "New report awaits verification")
        f.advance(1)
        f.store.settleCommand({ id: "older-revision-job", threadId: revision.threadId,
          exitCode: 1, output: "Older generator failed", cancelled: false, truncated: false })
        const callback = f.store.nextQueued([])!
        expect(callback.origin).toMatchObject({ kind: "notification", notificationKind: "command" })
        f.store.transition(callback.id, "running")
        f.store.settle(callback.id, "failed", "Older generator failed")
        const pending = observe(f, "report", undefined, interval, "observe-pending-review")
        expect(pending.workMonitor?.lastSuccessful).toMatchObject({ executionState: null, result: previous })
        f.store.removeSchedule(pending.id, pending.version)
      }
      f.host.stopWork(f.bot.id, f.work.id)
      const cancelled = revisionState !== "late callback"
      if (cancelled) f.store.settle(revision.id, "cancelled", null)

      const report = observe(f, "report")
      expect(f.store.settleScheduledWorkObservation(begin(f, report))).toMatchObject({
        kind: "notify", snapshot: {
          dispatchStopped: true, result: previous,
          ...(cancelled ? { executionState: "cancelled" } : {})
        }
      })
      const [notice] = f.store.pendingScheduledWorkPublications()
      expect(notice.text).toContain(previous.state === "completed" ? "最近一次成果已核查" : "最近一次执行结果为执行失败")
      if (cancelled) expect(notice.text).toContain("当前执行已停止")
      f.store.acknowledgeScheduledWorkPublication(notice.taskId)

      f.advance(31 * DAY)
      fillRecentHistory(f)
      expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
      expect(f.store.getTask(previous.taskId).state).toBe(previous.state)
      const afterRetention = observe(f, "report", undefined, interval, "observe-after-retention")
      expect(afterRetention.workMonitor?.lastSuccessful?.result).toEqual(previous)
    }
  )

  it("observes the original integration result after its peer returns", () => {
    const f = fixture()
    settleReports(f)
    const peer = f.store.create({ name: "Peer", instructions: "", color: "#123456", modelRef: null })
    const revision = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "peer-report", message: "Ask the peer for a report"
    })
    f.store.transition(revision.id, "running")
    const delegated = f.store.delegate(revision.id, peer.id, "Generate report", "peer")
    f.store.transition(delegated.id, "running")
    f.store.settle(revision.id, "completed", null, "Waiting for report")
    const monitor = observe(f, "new_result")
    expect(monitor.workMonitor?.lastSuccessful).toMatchObject({ result: { taskId: f.task.id }, pendingPeers: 1 })
    expect(f.store.settleScheduledWorkObservation(begin(f, monitor)).kind).toBe("silent")
    f.store.settle(delegated.id, "completed", null, "Generated report")
    expect(f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0])).kind).toBe("silent")
    f.store.flushReplies()
    const returned = f.store.recentTasks().find(task => task.requestId === `reply-${delegated.id}`)!
    f.store.transition(returned.id, "running")
    f.store.settle(returned.id, "completed", null, "Report checked")
    // The legacy main-chat report is a separate inbox entry, not another work result.
    settleReports(f)
    expect(f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0]))).toMatchObject({
      kind: "notify", snapshot: { result: { taskId: returned.id, state: "completed" } }
    })
  })

  it.each([true, false])("uses existing service readiness for observation (%s)", (verified) => {
    const f = fixture()
    settleReports(f)
    const monitor = observe(f, "new_result")
    const revision = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "service-report", message: "Keep the preview service running"
    })
    f.store.transition(revision.id, "running")
    const { threadId } = revision
    f.store.acceptCommand(revision.id, {
      id: "preview", threadId, command: "serve", cwd: "/reports", startedAt: 1, notifyOnComplete: false
    })
    if (verified) {
      f.store.acceptCommand(revision.id, {
        id: "check", threadId, command: "check", cwd: "/reports", startedAt: 2, notifyOnComplete: false
      })
      f.store.settleCommand({ id: "check", threadId, exitCode: 0, output: "ready", cancelled: false, truncated: false })
      f.store.retainReadyWorkService(revision.id, "preview", "check", "User requested a live preview")
    }
    f.store.settle(revision.id, "completed", null, "Preview result")
    const result = f.store.settleScheduledWorkObservation(begin(f, monitor))
    expect(result).toMatchObject({ kind: verified ? "notify" : "silent", snapshot: { backgroundBusy: true } })
    if (verified) expect(result.snapshot?.result).toMatchObject({ taskId: revision.id, state: "completed" })
  })

  it.each([false, true])("does not report retention as a change (later cancellation: %s)", (cancelled) => {
    const f = fixture()
    if (cancelled) {
      const later = f.store.enqueue({
        botId: f.bot.id, workId: f.work.id, requestId: "cancelled", message: "Withdraw this revision"
      })
      f.store.settle(later.id, "cancelled", null)
    }
    settleReports(f)
    const monitor = observe(f, "change")
    const before = f.store.settleScheduledWorkObservation(begin(f, monitor))
    expect(before.kind).toBe("silent")
    // A withdrawn, unstarted input did not replace the completed result.
    expect(before.snapshot?.executionState).toBe("completed")
    expect(before.snapshot?.result?.state).toBe("completed")

    f.advance(31 * DAY)
    fillRecentHistory(f)
    expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
    const after = f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0]))
    expect(after.kind).toBe("silent")
    expect(after.snapshot).toEqual({ ...before.snapshot, executionState: "completed" })
    expect(f.store.pendingScheduledWorkPublications()).toEqual([])
  })

  it("reports actual changes in active execution before and after withdrawal", () => {
    const f = fixture()
    settleReports(f)
    const monitor = observe(f, "change")
    const later = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "started-revision", message: "Revise the report"
    })
    f.store.transition(later.id, "running")
    const started = f.store.settleScheduledWorkObservation(begin(f, monitor))
    expect(started).toMatchObject({ kind: "notify", snapshot: { executionState: "running" } })

    f.store.settle(later.id, "cancelled", null)
    settleReports(f)
    const withdrawn = f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0]))
    expect(withdrawn).toMatchObject({ kind: "notify", snapshot: { executionState: "cancelled" } })
    expect(withdrawn.snapshot?.result).toEqual(started.snapshot?.result)

    f.host.stopWork(f.bot.id, f.work.id)
    const stopped = f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0]))
    expect(stopped).toMatchObject({ kind: "notify", snapshot: { dispatchStopped: true } })
    expect(stopped.snapshot?.result).toEqual(started.snapshot?.result)
  })

  it("retains only the latest result while the work remains available, even without an observer", () => {
    const f = fixture()
    settleReports(f)
    const input: BotScheduleInput = { ...interval, frequency: "once", intervalMinutes: undefined,
      runAt: new Date(Date.now() + 60 * DAY).toISOString() }
    const monitor = observe(f, "new_result", undefined, input)
    const initial = monitor.workMonitor!.lastSuccessful!.result!
    const paused = f.store.saveSchedule(f.bot.id, { ...input, enabled: false }, null, monitor)

    f.advance(DAY)
    const revision = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "new-result", message: "Revise the report"
    })
    f.store.transition(revision.id, "running")
    f.store.settle(revision.id, "completed", null)
    const cancelled = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "cancelled-revision", message: "A later change"
    })
    f.store.settle(cancelled.id, "cancelled", null)
    settleReports(f)

    f.advance(54 * DAY)
    fillRecentHistory(f)
    expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)
    expect(() => f.store.getTask(initial.taskId)).toThrow()
    expect(() => f.store.getTask(cancelled.id)).toThrow()
    expect(f.store.getTask(revision.id).state).toBe("completed")

    const resumed = f.store.saveSchedule(f.bot.id, input, input.runAt!, paused)
    f.advance(5 * DAY)
    const result = f.store.settleScheduledWorkObservation(begin(f, resumed))
    expect(result).toMatchObject({ kind: "notify", snapshot: { result: { taskId: revision.id, state: "completed" } } })
    expect(f.store.pendingScheduledWorkPublications()).toHaveLength(1)

    const current = f.store.schedules()[0]
    f.store.removeSchedule(current.id, current.version)
    f.store.pruneTaskHistory()
    expect(f.store.getTask(revision.id).state).toBe("completed")
  })

  it.each(["completed", "failed", "interrupted"] as const)(
    "reports the latest %s result when observation starts after history retention",
    (state) => {
      const f = fixture()
      settleReports(f)
      const revision = f.store.enqueue({
        botId: f.bot.id, workId: f.work.id, requestId: "latest-result", message: "Update report"
      })
      f.store.transition(revision.id, "running")
      f.store.settle(revision.id, state, state === "completed" ? null : "Execution stopped")
      settleReports(f)
      f.advance(31 * DAY)
      fillRecentHistory(f)
      expect(f.store.pruneTaskHistory()).toBeGreaterThan(0)

      const reopened = f.reopen()
      expect(reopened.store.getWork(f.bot.id, f.work.id).executionState).toBe(state)
      const monitor = observe(f, "report")
      const result = f.store.settleScheduledWorkObservation(begin(f, monitor))
      expect(result).toMatchObject({
        kind: "notify", snapshot: { executionState: state, result: { taskId: revision.id, state } }
      })
      expect(f.store.pendingScheduledWorkPublications()).toHaveLength(1)
    }
  )

  it("reports business completion once, separately from execution completion", () => {
    const f = fixture()
    const monitor = observe(f, "until_work_completed", "2030-01-01T01:00:00Z")
    expect(f.store.settleScheduledWorkObservation(begin(f, monitor)).kind).toBe("silent")
    const work = f.store.getWork(f.bot.id, f.work.id)
    f.store.changeWork(f.bot.id, work.id, work.version, "complete", "complete")
    expect(f.store.settleScheduledWorkObservation(begin(f, f.store.schedules()[0]))).toMatchObject({
      kind: "notify",
      snapshot: { workState: "completed", executionState: "completed" }
    })
    const finished = f.store.schedules()[0]
    expect(finished).toMatchObject({
      enabled: false,
      nextRunAt: null,
      workMonitor: { ended: "condition" }
    })
    expect(() =>
      f.store.saveSchedule(f.bot.id, interval, "2030-01-02T00:00:00Z", finished)
    ).toThrow("原观察条件已经满足")
    f.advance(61 * 60_000)
    const renamed = f.host.saveSchedule(f.bot.id, { ...parseSchedule(finished), name: "Completed review" },
      { id: finished.id, version: finished.version })
    expect(renamed).toMatchObject({ name: "Completed review", workMonitor: { ended: "condition" } })
  })

  it("edits the existing desktop observation's target and mode without changing its source", () => {
    const f = fixture()
    const original = observe(f, "report", "2030-01-01T01:00:00Z")
    const other = f.store.create({ name: "Other", instructions: "", color: "#123456", modelRef: null })
    const { work: foreign } = f.store.createWork({
      botId: other.id, operationId: "foreign", title: "Foreign", goal: "Unrelated"
    })
    const { work: replacement } = f.store.createWork({
      botId: f.bot.id, operationId: "replacement", title: "Replacement", goal: "Review another report"
    })
    const input = parseSchedule(original)
    const reference = { id: original.id, version: original.version }
    expect(() => f.host.saveSchedule(f.bot.id, input, {
      ...reference, workMonitor: { workId: foreign.id, mode: "new_result" }
    })).toThrow()
    const updated = f.host.saveSchedule(f.bot.id, input, {
      ...reference, workMonitor: { workId: replacement.id, mode: "new_result" }
    })
    expect(updated).toMatchObject({
      sourceTaskId: original.sourceTaskId, audienceKey: "desktop", nextRunAt: original.nextRunAt,
      workMonitor: {
        workId: replacement.id, mode: "new_result", expiresAt: original.workMonitor!.expiresAt,
        generation: original.workMonitor!.generation + 1, lastSuccessful: { workId: replacement.id }
      }
    })
    expect(updated.workId).toBeUndefined()
    expect(updated.desktopWork).toBeUndefined()
    expect(() => f.host.saveSchedule(f.bot.id, input, {
      ...reference, workMonitor: { workId: f.work.id, mode: "report" }
    })).toThrow("例行任务已改变")
  })

  it("keeps the renewal action after editing an expired desktop observation's condition", () => {
    const f = fixture()
    observe(f, "report", "2030-01-01T00:15:00Z")
    f.advance(16 * 60_000)
    f.host.resume()
    const [expired] = f.store.schedules()
    expect(expired.workMonitor?.ended).toBe("expired")
    const edited = f.host.saveSchedule(f.bot.id, parseSchedule(expired), {
      id: expired.id, version: expired.version, workMonitor: { workId: f.work.id, mode: "change" }
    })
    expect(edited).toMatchObject({
      enabled: false, nextRunAt: null,
      workMonitor: { mode: "change", ended: "expired", generation: expired.workMonitor!.generation + 1 }
    })
  })

  it("keeps successful evidence on failure and fences old decisions from edited configurations", () => {
    const f = fixture()
    const monitor = observe(f, "report")
    const first = f.store.settleScheduledWorkObservation(begin(f, monitor))
    const running = begin(f, f.store.schedules()[0])
    const edited = f.store.saveSchedule(
      f.bot.id,
      { ...interval, intervalMinutes: 15 },
      "2030-01-01T00:25:00Z",
      f.store.schedules()[0]
    )
    expect(edited.workMonitor?.generation).toBeGreaterThan(monitor.workMonitor!.generation)
    expect(f.store.settleScheduledWorkObservation(running).kind).toBe("notify")
    expect(f.store.schedules()[0]).toEqual(edited)
    const work = f.store.getWork(f.bot.id, f.work.id)
    f.store.beginWorkDeletion({
      botId: f.bot.id,
      workId: work.id,
      threadId: work.threadId,
      version: work.version,
      incarnation: null
    })
    expect(f.store.settleScheduledWorkObservation(begin(f, edited)).kind).toBe("failed")
    expect(f.store.schedules()[0]).toMatchObject({
      enabled: false,
      workMonitor: {
        ended: "unavailable",
        lastSuccessful: first.snapshot
      }
    })
  })

  it("does not queue an observation after its explicit expiry", () => {
    const f = fixture()
    const monitor = observe(f, "report", "2030-01-01T00:15:00Z")
    f.advance(900_001)
    f.store.fireSchedule(monitor, "2030-01-01T00:20:00Z")
    expect(f.store.nextQueued([], true, true)).toBeNull()
    expect(f.store.schedules()[0]).toMatchObject({
      enabled: false,
      workMonitor: { ended: "expired" }
    })
  })

  it("renews an expired observation without changing its authorization, conditions or last check", () => {
    const f = fixture()
    const prior = observe(f, "new_result", "2030-01-01T00:15:00Z")
    const first = f.store.settleScheduledWorkObservation(begin(f, prior))
    f.advance(900_001)
    f.host.resume()
    const [expired] = f.store.schedules()
    expect(expired.workMonitor?.ended).toBe("expired")
    const input = parseSchedule({ ...expired, enabled: true })
    const expiresAt = "2030-01-01T01:00:00.000Z"
    const renewed = f.host.saveSchedule(f.bot.id, input, { id: expired.id, version: expired.version, expiresAt })
    expect(renewed).toMatchObject({ id: prior.id, sourceTaskId: prior.sourceTaskId, audienceKey: prior.audienceKey,
      enabled: true, workMonitor: { workId: f.work.id, mode: "new_result", expiresAt, lastSuccessful: first.snapshot } })
    expect(renewed.workMonitor?.ended).toBeUndefined()
    expect(renewed.workMonitor?.generation).toBe(expired.workMonitor!.generation + 1)
  })

  it("settles through the enabled Host without running a model and retries one pending publication after reopen", async () => {
    const f = fixture()
    const monitor = observe(f, "report")
    f.store.fireSchedule(monitor, "2030-01-01T00:20:00Z")
    expect(f.store.nextQueued([])).toBeNull()
    await f.host.stop()
    const history = new Map<string, string>()
    const announce = vi.fn(async () => {})
    const acquire = vi.fn<BotRunPort["acquire"]>(() => ({
      execute: async () => ({ state: "completed" }),
      release() {}
    }))
    const persist = vi.fn<NonNullable<BotRunPort["scheduleObservationPublication"]>["persist"]>(
      (_, item) => {
        history.set(item.id, item.text)
        throw new Error("Desktop write was committed before the acknowledgment arrived")
      }
    )
    const first = f.reopen({ acquire, scheduleObservationPublication: { persist, announce } })
    await vi.waitFor(() => expect(persist).toHaveBeenCalled())
    const [item] = first.store.pendingScheduledWorkPublications()
    expect(item).toBeDefined()
    expect(history.has(item.id)).toBe(true)
    expect(persist.mock.calls.every(([, publication]) => publication.id === item.id)).toBe(true)
    expect(announce).not.toHaveBeenCalled()
    await first.host.stop()
    const resumedPersist = vi.fn<
      NonNullable<BotRunPort["scheduleObservationPublication"]>["persist"]
    >((_, publication) => {
      expect(history.get(publication.id)).toBe(publication.text)
    })
    const restarted = f.reopen({
      acquire,
      scheduleObservationPublication: { persist: resumedPersist, announce }
    })
    await vi.waitFor(() => expect(announce).toHaveBeenCalledExactlyOnceWith(item))
    restarted.host.resume()
    await Promise.resolve()
    expect(restarted.store.pendingScheduledWorkPublications()).toEqual([])
    expect(resumedPersist).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledTimes(1)
    expect(acquire.mock.calls.every(([, task]) => task.origin.kind !== "schedule")).toBe(true)
  })

  it("prunes the exact observation retry receipt when its task ages out without losing pending delivery", async () => {
    const f = fixture()
    settleReports(f)
    const monitor = observe(f, "report")
    const publishedId = begin(f, monitor)
    const published = f.store.settleScheduledWorkObservation(publishedId)
    expect(f.store.settleScheduledWorkObservation(publishedId)).toEqual(published)
    expect(f.store.acknowledgeScheduledWorkPublication(publishedId)).toBe(true)

    f.advance(1)
    const pendingId = begin(f, f.store.schedules()[0])
    const pending = f.store.settleScheduledWorkObservation(pendingId)
    const [publication] = f.store.pendingScheduledWorkPublications()
    expect(publication.taskId).toBe(pendingId)
    const pause = f.store.schedules()[0]
    const saved = f.store.saveSchedule(f.bot.id, { ...interval, enabled: false }, null, pause)
    expect(saved.workMonitor?.lastSuccessful).toEqual(pending.snapshot)
    const retryReceipts = (id: string) => {
      const key = `schedule-observation:${id}`
      return f.db.exec("SELECT receipt FROM bot_work_commands WHERE command_id=? AND fingerprint=?", [key, key])[0].values
    }
    const otherCommands = () => f.db.exec(
      "SELECT command_id,fingerprint,receipt FROM bot_work_commands WHERE command_id NOT GLOB 'schedule-observation:*' ORDER BY command_id"
    )[0].values
    const commands = otherCommands()
    expect(commands.length).toBeGreaterThan(0)
    expect(retryReceipts(publishedId)).toHaveLength(1)
    expect(retryReceipts(pendingId)).toHaveLength(1)

    f.advance(31 * DAY)
    fillRecentHistory(f)
    f.store.pruneTaskHistory()
    expect(() => f.store.getTask(publishedId)).toThrow()
    expect.soft(retryReceipts(publishedId)).toEqual([])
    expect(f.store.getTask(pendingId).state).toBe("completed")
    expect(retryReceipts(pendingId)).toHaveLength(1)
    expect(f.store.pendingScheduledWorkPublications()).toEqual([publication])
    expect(f.store.schedules()[0].workMonitor?.lastSuccessful).toEqual(pending.snapshot)
    expect(otherCommands()).toEqual(commands)
    await f.host.stop()

    const persist = vi.fn()
    const announce = vi.fn(async () => {})
    const runtime = { scheduleObservationPublication: { persist, announce } }
    const resumed = f.reopen(runtime)
    await vi.waitFor(() => expect(announce).toHaveBeenCalledExactlyOnceWith(publication))
    expect(persist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.bot.id }), publication)
    expect(resumed.store.pendingScheduledWorkPublications()).toEqual([])
    resumed.store.pruneTaskHistory()
    expect(() => resumed.store.getTask(pendingId)).toThrow()
    expect.soft(retryReceipts(pendingId)).toEqual([])
    expect(resumed.store.schedules()[0].workMonitor?.lastSuccessful).toEqual(pending.snapshot)
    expect(otherCommands()).toEqual(commands)
    await resumed.host.stop()

    const restarted = f.reopen(runtime)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(restarted.store.pendingScheduledWorkPublications()).toEqual([])
    expect(persist).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledTimes(1)
  })

  it("samples and publishes at the deadline while the main conversation and every Agent slot await answers", async () => {
    const f = fixture()
    await f.host.stop()
    settleReports(f)
    const due = "2030-01-01T00:10:00Z"
    const monitor = observe(f, "report", "2030-01-01T00:11:00Z", {
      ...interval, frequency: "once", runAt: due
    })
    const other = f.store.create({ name: "Other", instructions: "", color: "#123456", modelRef: null })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const acquire = vi.fn<BotRunPort["acquire"]>(() => ({
      async execute(_signal, waiting) {
        waiting(true)
        await held
        return { state: "completed" }
      },
      release() {}
    }))
    const persist = vi.fn()
    const announce = vi.fn<NonNullable<BotRunPort["scheduleObservationPublication"]>["announce"]>(async () => {})
    const { host, store } = f.reopen({ acquire, scheduleObservationPublication: { persist, announce } })
    const changed = vi.fn()
    const unsubscribe = host.subscribe(changed)
    try {
      const first = host.send({ botId: f.bot.id, requestId: "main", message: "Unrelated question" })
      const second = host.send({ botId: other.id, requestId: "other", message: "Other question" })
      await vi.waitFor(() => {
        expect(store.getTask(first.id).state).toBe("waiting_user")
        expect(store.getTask(second.id).state).toBe("waiting_user")
      })
      f.advance(600_000)
      host.resume()
      await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(1))
      const [trigger] = f.triggers()
      expect(trigger.state).toBe("completed")
      const publication = expect.objectContaining({
        id: `schedule-observation-${trigger.id}`, threadId: f.bot.threadId,
        text: expect.stringMatching(/^例行观察/), createdAt: Date.parse(due)
      })
      expect(persist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.bot.id }), publication)
      expect(announce).toHaveBeenCalledExactlyOnceWith(publication)
      expect(announce.mock.calls[0]?.[0]).not.toHaveProperty("reminder")
      expect(announce.mock.calls[0]?.[0].observedWorkId).toBe(f.work.id)
      expect(announce.mock.calls[0]?.[0].text).not.toContain("#bot-work/")
      expect(changed.mock.calls.filter(([event]) => event.reminder)).toEqual([[expect.objectContaining({
        reminder: expect.objectContaining({ id: `schedule-observation-${trigger.id}`, threadId: f.bot.threadId,
          content: expect.stringContaining(`[查看原任务](#bot-work/${f.work.id})`) })
      })]])
      expect(store.schedules().find(item => item.id === monitor.id)?.workMonitor?.ended).toBeUndefined()
      expect(store.getTask(first.id).state).toBe("waiting_user")
      expect(store.getTask(second.id).state).toBe("waiting_user")
      f.advance(65_000)
      host.resume()
      await Promise.resolve()
      expect(announce).toHaveBeenCalledTimes(1)
      expect(acquire).toHaveBeenCalledTimes(2)
      expect(store.pendingScheduledWorkPublications()).toEqual([])
    } finally {
      unsubscribe()
      release()
    }
  })
})

describe("fixed one-time reminders", () => {
  function reminder(f: ReturnType<typeof fixture>, expiresAt?: string) {
    const request = f.store.enqueue({
      botId: f.bot.id,
      requestId: "ask-to-remind",
      message: "Remind me to call"
    })
    f.store.transition(request.id, "running")
    const input = {
      name: "Call",
      message: "Call the report owner",
      frequency: "once" as const,
      runAt: "2030-01-01T00:10:00Z",
      enabled: true
    }
    const save = (callId: string, config: BotScheduleInput = input) =>
      f.store.saveSchedule(f.bot.id, config, input.runAt, undefined, undefined, undefined, {
        input: { kind: "fixed_reminder", expiresAt },
        source: { taskId: request.id, callId, key: "remind" }
      })
    expect(() => save("recurring", interval)).toThrow("固定提醒只能安排一次")
    const saved = save("create")
    expect(save("retry")).toEqual(saved)
    f.store.settle(request.id, "completed", null)
    return saved
  }

  it("does not accept rescheduling a fixed reminder to or beyond its expiry", () => {
    const f = fixture()
    const expiry = "2030-01-01T00:15:00Z"
    const saved = reminder(f, expiry)
    const reschedule = (runAt: string) => f.host.saveSchedule(f.bot.id, parseSchedule({ ...saved, runAt }), saved)
    for (const invalid of [expiry, "2030-01-01T00:20:00Z"])
      expect.soft(() => reschedule(invalid)).toThrow("下一次执行必须早于失效时间")
    expect(f.store.schedules()).toEqual([saved])
    const valid = reschedule("2030-01-01T00:14:00Z")
    f.advance(14 * 60_000)
    f.host.resume()
    expect(f.triggers()).toMatchObject([{ state: "completed", origin: { scheduleId: valid.id } }])
  })

  it("renews an expired reminder only when the new trigger precedes a future expiry", () => {
    const f = fixture()
    const prior = reminder(f, "2030-01-01T00:15:00Z")
    f.advance(900_001)
    f.host.resume()
    const [expired] = f.store.schedules()
    expect(expired.fixedReminder?.ended).toBe("expired")
    const runAt = "2030-01-01T00:20:00.000Z"
    const input = parseSchedule({ ...expired, runAt, enabled: true })
    const renew = (expiresAt: string) => f.host.saveSchedule(f.bot.id, input,
      { id: expired.id, version: expired.version, expiresAt })
    expect(() => renew(runAt)).toThrow("下一次执行必须早于失效时间")
    expect(() => renew(prior.fixedReminder!.expiresAt!)).toThrow("失效时间必须在未来")
    const expiresAt = "2030-01-01T00:30:00.000Z"
    const renewed = renew(expiresAt)
    expect(renewed).toMatchObject({ id: prior.id, sourceTaskId: prior.sourceTaskId,
      enabled: true, nextRunAt: runAt, fixedReminder: { kind: "fixed_reminder", expiresAt } })
    expect(renewed.fixedReminder?.ended).toBeUndefined()
    f.advance(300_000)
    f.host.resume()
    expect(f.triggers()).toMatchObject([{ state: "completed", origin: { scheduleId: renewed.id } }])
  })

  it("settles only the frozen reminder text and marks a delayed one-shot delivery", () => {
    const f = fixture()
    const schedule = reminder(f)
    f.advance(900_000)
    f.host.resume()
    f.host.resume()
    expect(f.store.nextQueued([], true, true)).toBeNull()
    const [trigger] = f.triggers()
    expect(trigger.origin).toMatchObject({
      kind: "schedule",
      scheduleId: schedule.id,
      fixedReminder: { kind: "fixed_reminder", scheduledAt: schedule.runAt }
    })
    const [fired] = f.store.schedules()
    const renamed = f.host.saveSchedule(f.bot.id, parseSchedule({ ...fired, name: "Rename only" }), fired)
    expect(renamed).toMatchObject({ name: "Rename only", enabled: false, fixedReminder: fired.fixedReminder })
    f.store.settleScheduledFixedReminder(trigger.id)
    f.store.settleScheduledFixedReminder(trigger.id)
    expect(f.store.pendingScheduledWorkPublications()).toMatchObject([
      {
        taskId: trigger.id,
        reminder: true,
        text: "Call the report owner\n\n这是一条延迟送达的提醒。"
      }
    ])
    expect(f.store.acknowledgeScheduledWorkPublication(trigger.id)).toBe(true)
    expect(f.store.acknowledgeScheduledWorkPublication(trigger.id)).toBe(false)
    expect(f.store.getTask(trigger.id).state).toBe("completed")
  })

  it("prunes only the aged fixed reminder receipt after its public delivery is confirmed", () => {
    const f = fixture()
    reminder(f)
    f.advance(600_000)
    f.host.resume()
    const [published] = f.store.pendingScheduledWorkPublications()
    expect(f.store.acknowledgeScheduledWorkPublication(published.taskId)).toBe(true)

    const [fired] = f.store.schedules()
    f.host.saveSchedule(f.bot.id, parseSchedule({ ...fired, enabled: true,
      runAt: new Date(Date.now() + 600_000).toISOString() }), fired)
    f.advance(600_000)
    f.host.resume()
    const [pending] = f.store.pendingScheduledWorkPublications()
    expect(pending.taskId).not.toBe(published.taskId)
    const retryReceipts = (id: string) => {
      const key = `fixed-reminder:${id}`
      return f.db.exec("SELECT receipt FROM bot_work_commands WHERE command_id=? AND fingerprint=?", [key, key])[0].values
    }
    const otherCommands = () => f.db.exec(
      "SELECT command_id,fingerprint,receipt FROM bot_work_commands WHERE command_id NOT GLOB 'fixed-reminder:*' ORDER BY command_id"
    )[0].values
    const commands = otherCommands()
    expect(commands.length).toBeGreaterThan(0)
    expect(retryReceipts(published.taskId)).toEqual([["true"]])
    expect(retryReceipts(pending.taskId)).toEqual([["true"]])

    f.advance(31 * DAY)
    fillRecentHistory(f)
    f.store.pruneTaskHistory()
    expect(() => f.store.getTask(published.taskId)).toThrow()
    expect.soft(retryReceipts(published.taskId)).toEqual([])
    expect(f.store.getTask(pending.taskId).state).toBe("completed")
    expect(retryReceipts(pending.taskId)).toEqual([["true"]])
    expect(f.store.pendingScheduledWorkPublications()).toEqual([pending])

    expect(f.store.acknowledgeScheduledWorkPublication(pending.taskId)).toBe(true)
    f.store.pruneTaskHistory()
    expect(() => f.store.getTask(pending.taskId)).toThrow()
    expect.soft(retryReceipts(pending.taskId)).toEqual([])
    expect(f.store.pendingScheduledWorkPublications()).toEqual([])
    expect(otherCommands()).toEqual(commands)
  })

  it.each([true, false])("uses bounded automatic one-shot delivery retries (recoverable=%s)", async recoverable => {
    vi.useFakeTimers()
    try {
      const failure = () => { throw new Error("Temporary transcript failure") }
      const persist = vi.fn<NonNullable<BotRunPort["scheduleObservationPublication"]>["persist"]>()
      if (recoverable) persist.mockImplementationOnce(failure)
      else persist.mockImplementation(failure)
      const announce = vi.fn(async () => {})
      const f = fixture({ scheduleObservationPublication: { persist, announce } })
      reminder(f)
      f.advance(600_000)
      f.host.resume()
      await vi.advanceTimersByTimeAsync(0)
      const [pending] = f.store.pendingScheduledWorkPublications()
      expect(pending).toBeDefined()
      expect(f.store.schedules()[0]).toMatchObject({ enabled: false, nextRunAt: null })
      expect(persist).toHaveBeenCalledOnce()
      for (let attempt = 0; attempt < 3; attempt++) {
        f.advance(5_000)
        await vi.advanceTimersByTimeAsync(5_000)
      }
      expect(persist.mock.calls.map(([, item]) => item.id)).toEqual(Array(recoverable ? 2 : 3).fill(pending.id))
      if (recoverable) expect(announce).toHaveBeenCalledExactlyOnceWith(pending)
      else expect(announce).not.toHaveBeenCalled()
      expect(f.triggers()).toHaveLength(1)
      expect(f.store.pendingScheduledWorkPublications()).toEqual(recoverable ? [] : [pending])
    } finally {
      vi.useRealTimers()
    }
  })

  it("delivers on time while the original conversation waits and all Agent slots are occupied", async () => {
    const f = fixture()
    await f.host.stop()
    reminder(f, "2030-01-01T00:11:00Z")
    const other = f.store.create({ name: "Other", instructions: "", color: "#123456", modelRef: null })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const acquire = vi.fn<BotRunPort["acquire"]>(() => ({
      async execute(_signal, waiting) {
        waiting(true)
        await held
        return { state: "completed" }
      },
      release() {}
    }))
    const persist = vi.fn(), announce = vi.fn(async () => {})
    const { host, store } = f.reopen({ acquire, scheduleObservationPublication: { persist, announce } })
    const changed = vi.fn()
    const unsubscribe = host.subscribe(changed)
    try {
      const first = host.send({ botId: f.bot.id, requestId: "main", message: "Another request" })
      const second = host.send({ botId: other.id, requestId: "other", message: "Other request" })
      await vi.waitFor(() => {
        expect(store.getTask(first.id).state).toBe("waiting_user")
        expect(store.getTask(second.id).state).toBe("waiting_user")
      })
      f.advance(600_000)
      host.resume()
      await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(1))
      expect(persist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.bot.id }),
        expect.objectContaining({ reminder: true, text: "Call the report owner" }))
      expect(changed.mock.calls.filter(([event]) => event.reminder)).toEqual([[expect.objectContaining({
        reminder: expect.objectContaining({ threadId: f.bot.threadId, content: "Call the report owner" })
      })]])
      expect(store.getTask(first.id).state).toBe("waiting_user")
      expect(store.getTask(second.id).state).toBe("waiting_user")
      f.advance(120_000)
      host.resume()
      expect(announce).toHaveBeenCalledTimes(1)
      expect(acquire).toHaveBeenCalledTimes(2)
      expect(store.pendingScheduledWorkPublications()).toEqual([])
    } finally {
      unsubscribe()
      release()
    }
  })

  it("marks a missed fixed reminder after explicit expiry without producing a publication", () => {
    const f = fixture()
    reminder(f, "2030-01-01T00:15:00Z")
    f.advance(900_001)
    f.host.resume()
    expect(f.store.nextQueued([], true, true)).toBeNull()
    expect(f.store.pendingScheduledWorkPublications()).toEqual([])
    expect(f.store.schedules()[0]).toMatchObject({
      enabled: false,
      fixedReminder: { ended: "expired" }
    })
  })
})
