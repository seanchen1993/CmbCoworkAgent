import { DatabaseSync } from "node:sqlite"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveBotWorkStatus } from "../../renderer/src/lib/bot/work-status"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { createBotDeliveryTools } from "./tools"
import { projectWorkResultProcess } from "./work-result-process"
import type { Message } from "../types"
import type { BotTask, BotTaskState } from "../../shared/bots/contracts"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"
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
  return { db, store, bot, ...created, advanceClock: (ms: number) => { now += ms } }
}
const notices = (store: BotStore) =>
  store.recentTasks().filter((task) => task.origin.kind === "work_result")
const privateReview = (store: BotStore) => {
  store.flushReplies()
  const task = notices(store).find(item => item.state === "queued" &&
    item.origin.kind === "work_result" && item.origin.review?.phase === "review")
  if (!task) throw new Error("Expected a queued private review")
  store.transition(task.id, "running")
  return task
}
function beginVerifiedWork(f: ReturnType<typeof fixture>) {
  f.store.transition(f.task.id, "running")
  f.store.recordPreparedInput(f.task.id, "Approved execution scope")
  expect(f.store.armWorkResultReview(f.task.id, "incarnation")).toBe(true)
}
function settle(
  store: BotStore,
  task: BotTask,
  state: BotTaskState = "completed",
  result = "周日下午三点，社区阅览室。"
) {
  store.transition(task.id, "running")
  store.settle(task.id, state, state === "failed" ? "模型连接失败" : null, result)
}

describe("private work result settlement", () => {
  it("reads a suppressed background cancellation receipt without resuming the stopped task", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.acceptCommand(f.task.id, { id: "cancelled-background", threadId: f.work.threadId,
      command: "wait then report", cwd: "/tmp", startedAt: 1000 })
    f.store.settle(f.task.id, "completed", null, "Background started")
    f.store.suppressCommands(f.work.threadId)
    f.store.settleCommand({ id: "cancelled-background", threadId: f.work.threadId, exitCode: 130,
      output: "Task cancelled by user.", cancelled: true, truncated: false })
    const before = f.store.recentTasks()
    expect(f.store.workHistoryCommands(f.bot.id, f.work.id, "incarnation")).toMatchObject({
      coverage: "partial", commands: [], backgroundCommands: [{ id: "cancelled-background",
        state: "cancelled", startedAt: "1970-01-01T00:00:01.000Z", observedAt: expect.any(String),
        result: { exitCode: 130, cancelled: true, output: "Task cancelled by user." } }]
    })
    expect(f.store.recentTasks()).toEqual(before)
    expect(f.store.workHistoryCommands(f.bot.id, f.work.id, "another-incarnation")).toEqual({
      coverage: "unavailable", commands: []
    })
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "new-input", message: "Continue with a different task" })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    const next = f.store.sendWork({ taskId: user.id, callId: "next", key: "next" }, f.work.id, user.message)
    f.store.transition(next.id, "running")
    f.store.recordPreparedInput(next.id, next.message)
    expect(f.store.armWorkResultReview(next.id, "incarnation")).toBe(true)
    expect(f.store.workHistoryCommands(f.bot.id, f.work.id, "incarnation")).not.toHaveProperty("backgroundCommands")
  })

  it("reads a cancelled command launched by a callback whose owner remains the original user", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.acceptCommand(f.task.id, { id: "first", threadId: f.work.threadId,
      command: "first step", cwd: "/tmp", startedAt: 1000 })
    f.store.settle(f.task.id, "completed", null, "Started")
    f.store.settleCommand({ id: "first", threadId: f.work.threadId, exitCode: 0,
      output: "First done", cancelled: false, truncated: false })
    const callback = f.store.recentTasks().find(task => task.origin.kind === "notification" && task.origin.key === "first")!
    f.store.transition(callback.id, "running")
    f.store.acceptCommand(callback.id, { id: "second", threadId: f.work.threadId,
      command: "second step", cwd: "/tmp", startedAt: 1010 })
    f.store.settle(callback.id, "completed", null, "Second pending")
    f.store.suppressCommands(f.work.threadId)
    f.store.settleCommand({ id: "second", threadId: f.work.threadId, exitCode: 130,
      output: "Task cancelled by user.", cancelled: true, truncated: false })
    const before = f.store.recentTasks()
    const result = f.store.workHistoryCommands(f.bot.id, f.work.id, "incarnation")
    expect(result).toMatchObject({ taskId: callback.id, backgroundCommands: [
      { id: "second", sourceTaskId: f.task.id, state: "cancelled", result: { cancelled: true, exitCode: 130 } },
      { id: "first", sourceTaskId: f.task.id, state: "completed", result: { exitCode: 0 } }
    ] })
    expect(f.store.recentTasks()).toEqual(before)
    // Retention can remove the first settled receipt while the second still runs.
    f.db.run("DELETE FROM bot_commands WHERE id=?", ["first"])
    expect(f.store.workHistoryCommands(f.bot.id, f.work.id, "incarnation")).toMatchObject({
      backgroundCommands: [{ id: "second", sourceTaskId: f.task.id, state: "cancelled" }]
    })
    expect(f.store.recentTasks()).toEqual(before)
  })

  it("reads retained command failure from a background callback without a new user-input preparation", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.acceptCommand(f.task.id, { id: "background", threadId: f.work.threadId,
      command: "check", cwd: "/tmp", startedAt: 1 })
    f.store.settle(f.task.id, "completed", null, "Background started")
    f.store.settleCommand({ id: "background", threadId: f.work.threadId, exitCode: 0,
      output: "Finished", cancelled: false, truncated: false })
    const callback = f.store.recentTasks().find(task => task.origin.kind === "notification" &&
      task.origin.key === "background")!
    expect(callback).toBeDefined()
    f.store.transition(callback.id, "running")
    f.store.recordWorkResultEvidence(callback.id, { foregroundCommand: {
      callId: "callback-check", command: "node --test", exitCode: 1, output: "fail 1", excerpt: false
    } })
    f.store.transition(callback.id, "cancelled")
    expect(f.store.workHistoryCommands(f.bot.id, f.work.id, "incarnation")).toMatchObject({
      coverage: "partial", taskId: callback.id, state: "cancelled",
      commands: [{ callId: "callback-check", exitCode: 1, output: "fail 1" }],
      backgroundCommands: [{ id: "background", state: "completed", result: { output: "Finished", exitCode: 0 } }]
    })
  })

  it.each([false, true])("reads retained command failure after cancellation without reviving work (injected=%s)", (injected) => {
    const f = fixture()
    beginVerifiedWork(f)
    if (injected) {
      const supplement = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
        requestId: "supplement", message: "Use the revised format" })
      f.store.recordPreparedInput(supplement.id, supplement.message)
      expect(f.store.injectIntoRun(supplement.id, f.task.id)).toBe(true)
    }
    for (let index = 0; index < 5; index++)
      f.store.recordWorkResultEvidence(f.task.id, { foregroundCommand: {
        callId: `command-${index}`, command: "Compound shell command", exitCode: 0,
        output: index === 4 ? "EXIT=1; fail 1" : "earlier output", excerpt: false
      } })
    f.store.transition(f.task.id, "cancelled")
    const before = f.store.recentTasks()
    const result = f.store.workHistoryCommands(f.bot.id, f.work.id, "incarnation")
    expect(result).toMatchObject({ coverage: "partial", taskId: f.task.id, state: "cancelled" })
    expect(result.commands).toHaveLength(3)
    expect(result.commands.at(-1)).toMatchObject({ exitCode: 0, output: "EXIT=1; fail 1" })
    expect(f.store.workHistoryCommands(f.bot.id, f.work.id, "replacement")).toEqual({
      coverage: "unavailable", commands: []
    })
    expect(() => f.store.workHistoryCommands("another-bot", f.work.id, "incarnation")).toThrow()
    expect(f.store.recentTasks()).toEqual(before)
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "resume", message: "Try the revised task" })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    const next = f.store.sendWork({ taskId: user.id, callId: "send", key: "send" }, f.work.id, user.message)
    expect(f.store.workHistoryCommands(f.bot.id, f.work.id, "incarnation")).toMatchObject({
      coverage: "unavailable", commands: []
    })
    f.store.transition(next.id, "running")
    f.store.recordPreparedInput(next.id, next.message)
    expect(f.store.armWorkResultReview(next.id, "incarnation")).toBe(true)
    expect(f.store.workHistoryCommands(f.bot.id, f.work.id, "incarnation")).toMatchObject({
      taskId: next.id, coverage: "unavailable", commands: []
    })
  })

  const ready = { kind: "ready" as const, summary: "核验完成。", evidenceIds: [] as string[] }

  it("retains a verified command that exits while another tool waits for the user", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.transition(f.task.id, "waiting_user")
    const foregroundCommand = { callId: "during-question", command: "npm test", directory: "packages/web",
      exitCode: 1, output: "Test assertion failed", excerpt: false }
    f.store.recordWorkResultEvidence(f.task.id, { foregroundCommand })
    const file = { name: "report.txt", filePath: "/work/report.txt", attachmentPath: "/saved/report.txt", size: 5 }
    f.store.recordWorkResultEvidence(f.task.id, { callId: "deliver-during-question", files: [file] })
    f.store.recordWorkResultEvidence(f.task.id, { callId: "deliver-during-question", assistantMessageId: "delivery-card" })
    f.store.transition(f.task.id, "running")
    f.store.settle(f.task.id, "completed", null, "Result ready")
    const reviewTask = privateReview(f.store)
    const review = f.store.getWorkResultReview(reviewTask.id)!
    expect(review.evidence[0].foregroundCommands).toEqual([{ ...foregroundCommand, observedAt: expect.any(Number) }])
    expect(review.evidence[0].deliveries).toMatchObject([{ file, assistantMessageId: "delivery-card" }])
    expect(f.store.commitWorkResultReview(reviewTask.id, ready)).toMatchObject({ state: "publish", publication: {
      attachmentLinkVersion: 1, attachments: [{ file, assistantMessageId: "delivery-card" }]
    } })
  })

  function publishOriginalResult(f: ReturnType<typeof fixture>, kind: "ready" | "blocked") {
    const { store } = f
    beginVerifiedWork(f)
    store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(store)
    const decision = { ...ready, kind }
    expect(store.commitWorkResultReview(review.id, decision).state).toBe("publish")
    store.settle(review.id, "completed", null)
    store.flushReplies()
    const publication = notices(store).find(item => item.state === "queued")!
    store.transition(publication.id, "running")
    expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    store.settle(publication.id, "completed", null)
    return { kind, summary: decision.summary }
  }

  it.each([
    ["ready", "delete"], ["blocked", "pause"]
  ] as const)("preserves %s after withdrawing an unstarted work schedule via %s", (kind, action) => {
    const f = fixture()
    const { store, bot, work } = f
    const resultConclusion = publishOriginalResult(f, kind)
    const input = { name: "Refresh report", message: "Check the newer data",
      frequency: "once" as const, enabled: true, runAt: "2030-01-01T00:00:00.000Z" }
    const schedule = store.saveSchedule(bot.id, input, input.runAt, undefined, undefined,
      { workId: work.id, operationId: "refresh-report" })
    store.fireSchedule(schedule, null)
    const trigger = store.nextQueued([])!
    expect(trigger).toMatchObject({ workId: work.id, state: "queued",
      origin: { kind: "schedule", scheduleId: schedule.id } })
    expect(store.getWork(bot.id, work.id).executionState).toBe("queued")

    const fired = store.schedules()[0]
    if (action === "delete") store.removeSchedule(fired.id, fired.version)
    else store.saveSchedule(bot.id, { ...input, enabled: false }, null, { ...fired, pauseRequested: true })
    expect(store.getTask(trigger.id).state).toBe("cancelled")
    for (const projected of [store.getWork(bot.id, work.id), store.listWorks(bot.id).items[0],
      store.workSummaries(bot.id, [work.id])[0], new BotStore(f.db).getWork(bot.id, work.id)]) {
      expect(projected).toMatchObject({ state: "active", executionState: "completed", resultConclusion })
      expect(projected.dispatchStopped).toBeUndefined()
    }
  })

  it.each(["ready", "blocked"] as const)("preserves %s after Host cancels an unstarted forwarded follow-up", async kind => {
    const f = fixture()
    const { store, bot, work } = f
    const resultConclusion = publishOriginalResult(f, kind)
    let host: LocalBotHost
    let withdrawn: BotTask | undefined
    host = new LocalBotHost(store, {
      onAvailable: () => () => {},
      acquire: (_bot, task) => task.workId ? null : ({
        release() {},
        async execute() {
          host.recordPreparedInput(task.id, task.id, task.message)
          const followUp = host.sendWork({ taskId: task.id, callId: "forward", key: "forward" }, work.id, task.message)
          expect(followUp).toMatchObject({ state: "queued", origin: { kind: "work", dispatch: "follow_up" } })
          host.cancel(followUp.id)
          withdrawn = store.getTask(followUp.id)
          return { state: "completed" }
        }
      })
    })
    hosts.push(host)
    const user = host.send({ botId: bot.id, requestId: "appendix", message: "Add an appendix" })
    await vi.waitFor(() => expect(store.getTask(user.id).state).toBe("completed"))
    expect(withdrawn?.state).toBe("cancelled")
    expect(store.getWork(bot.id, work.id)).toMatchObject({ state: "active", executionState: "completed", resultConclusion })
  })

  it.each(["running", "checkpoint"] as const)("keeps the actual cancellation of a started work schedule (%s)", stage => {
    const f = fixture()
    const { store, bot, work } = f
    publishOriginalResult(f, "ready")
    const input = { name: "Refresh report", message: "Check the newer data",
      frequency: "once" as const, enabled: true, runAt: "2030-01-01T00:00:00.000Z" }
    const schedule = store.saveSchedule(bot.id, input, input.runAt, undefined, undefined,
      { workId: work.id, operationId: "refresh-report" })
    store.fireSchedule(schedule, null)
    const trigger = store.nextQueued([])!
    expect(trigger.origin).toMatchObject({ kind: "schedule", scheduleId: schedule.id })
    store.transition(trigger.id, "running")
    if (stage === "checkpoint") {
      store.deferTask(trigger.id, "after-report-read")
      expect(store.getTask(trigger.id).state).toBe("queued")
      expect(store.taskCheckpoint(trigger.id)).toBe("after-report-read")
      const fired = store.schedules()[0]
      store.removeSchedule(fired.id, fired.version)
      expect(store.getTask(trigger.id).state).toBe("queued")
    }
    store.settle(trigger.id, "cancelled", null)
    const projected = store.getWork(bot.id, work.id)
    expect(projected).toMatchObject({ state: "active", executionState: "cancelled" })
    expect(projected.resultConclusion).toBeUndefined()
  })

  it.each(["needs_user", "ready", "blocked"] as const)("shows the published %s decision until newer user input passes its hook", (kind) => {
    const f = fixture()
    const { store, bot, work } = f
    const summary = "请确认要采用哪个发布口径。"
    const projections = () => [
      store.getWork(bot.id, work.id),
      store.listWorks(bot.id, undefined, "", "desktop").items[0],
      store.workSummaries(bot.id, [work.id])[0]
    ]
    const shown = (expected?: string) => {
      for (const item of projections()) {
        expect(item.resultNeedsUser).toBe(kind === "needs_user" ? expected : undefined)
        expect(item.resultConclusion).toEqual(kind !== "needs_user" && expected ? { kind, summary: expected } : undefined)
        expect(item.resultReviewState).toBeUndefined()
      }
    }

    beginVerifiedWork(f)
    store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(store)
    expect(store.commitWorkResultReview(review.id, { ...ready, kind, summary }).state)
      .toBe("publish")
    store.settle(review.id, "completed", null)
    store.flushReplies()
    const publication = notices(store).find(item => item.state === "queued")!
    store.transition(publication.id, "running")
    shown()
    expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    store.settle(publication.id, "completed", null)
    shown(summary)
    expect(store.listWorks(bot.id, undefined, "", "desktop", "model").items[0].resultNeedsUser)
      .toBeUndefined()
    expect(store.listWorks(bot.id, undefined, "", "desktop", "model").items[0].resultConclusion)
      .toBeUndefined()

    const stopped = store.stopWorkDispatch(bot.id, work.id)
    shown()
    const continued = store.changeWork(bot.id, work.id, stopped.version, "continue-decision", "continue")
    shown(summary)
    const completed = store.changeWork(bot.id, work.id, continued.version, "complete-decision", "complete")
    shown()
    store.changeWork(bot.id, work.id, completed.version, "reopen-decision", "continue")
    shown(summary)

    const unrelated = store.enqueue({ botId: bot.id, requestId: "unrelated-chat", message: "Tell me the time" })
    store.transition(unrelated.id, "running")
    store.recordPreparedInput(unrelated.id, unrelated.message)
    store.settle(unrelated.id, "completed", null)
    shown(summary)

    const rejected = store.enqueue({ botId: bot.id, workId: work.id,
      requestId: "rejected-decision", message: "Use the first option" })
    store.transition(rejected.id, "running")
    store.beginInputPreparation(rejected.id)
    shown(summary)
    store.settle(rejected.id, "failed", "Hook refused", undefined, undefined, false,
      { outcome: "error", code: "prompt_blocked" })
    shown(kind === "needs_user" ? summary : undefined)

    const approved = store.enqueue({ botId: bot.id, workId: work.id,
      requestId: "approved-decision", message: "Use the second option" })
    store.transition(approved.id, "running")
    store.beginInputPreparation(approved.id)
    store.recordPreparedInput(approved.id, approved.message)
    store.settle(approved.id, "completed", null, "Revised outcome")
    shown()
  })

  it.each(["waiting", "checking"] as const)("does not complete work while its result is still %s", phase => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const review = phase === "checking" ? privateReview(f.store) : undefined
    const user = phase === "waiting"
      ? f.store.enqueue({ botId: f.bot.id, requestId: "other-work", message: "Handle another request first" })
      : undefined
    f.store.flushReplies()
    if (user) expect(notices(f.store)).toHaveLength(0)
    const before = f.store.getWork(f.bot.id, f.work.id)
    expect(before.resultReviewState).toBe(phase)
    expect(() => f.store.changeWork(f.bot.id, f.work.id, before.version, "complete-review", "complete"))
      .toThrow("待处理结果仍未结束")
    expect(f.store.getWork(f.bot.id, f.work.id)).toMatchObject({
      state: "active", version: before.version, resultReviewState: phase
    })

    if (user) settle(f.store, user)
    const pending = review ?? privateReview(f.store)
    expect(f.store.commitWorkResultReview(pending.id, ready).state).toBe("publish")
    f.store.settle(pending.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
    f.store.settle(publication.id, "completed", null)
    const current = f.store.getWork(f.bot.id, f.work.id)
    expect(f.store.changeWork(f.bot.id, f.work.id, current.version, "complete-review", "complete").state)
      .toBe("completed")
    expect(f.store.getTask(f.task.id).state).toBe("completed")
  })

  it.each(["ready", "blocked"] as const)("does not reuse %s after a later unreviewed scheduled result", kind => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(f.store)
    f.store.commitWorkResultReview(review.id, { ...ready, kind })
    f.store.settle(review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    f.store.acknowledgeWorkResultPublication(publication.id)
    f.store.settle(publication.id, "completed", null)
    expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion?.kind).toBe(kind)
    const input = { name: "Read changed input", message: "Read today's changed input",
      frequency: "once" as const, enabled: true, runAt: "2030-01-01T00:00:00.000Z" }
    const schedule = f.store.saveSchedule(f.bot.id, input, input.runAt, undefined, undefined,
      { workId: f.work.id, operationId: "later-routine" })
    f.store.fireSchedule(schedule, null)
    const later = f.store.nextQueued([])!
    expect(later.origin).toMatchObject({ kind: "schedule", scheduleId: schedule.id })
    settle(f.store, later, "completed", "A different unreviewed result")
    expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toBeUndefined()
    f.store.flushReplies()
    const notice = f.store.nextQueued([])!
    settle(f.store, notice, "completed")
    f.advanceClock(31 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 105; i++) {
      const unrelated = f.store.enqueue({ botId: f.bot.id, requestId: `unrelated-${i}`, message: "Other work" })
      settle(f.store, unrelated, "completed")
    }
    f.store.pruneTaskHistory()
    // Keep the current review's input as the ordering anchor, even when a
    // newer routine is the visible result. Retention must not revive its verdict.
    expect(f.store.getTask(f.task.id).state).toBe("completed")
    expect(f.store.getTask(later.id).state).toBe("completed")
    const reopened = new BotStore(f.db)
    expect(reopened.getWork(f.bot.id, f.work.id).resultConclusion).toBeUndefined()
  })

  it("retains the acknowledged blocked explanation after a failed execution", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "failed", "Connection closed", "Retained partial output")
    const review = privateReview(f.store)
    f.store.commitWorkResultReview(review.id, { kind: "blocked", summary: "报告缺少末页，请核对已有附件。", evidenceIds: [] })
    f.store.settle(review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    f.store.acknowledgeWorkResultPublication(publication.id)
    f.store.settle(publication.id, "completed", null)
    expect(f.store.getWork(f.bot.id, f.work.id)).toMatchObject({
      executionState: "failed", resultConclusion: { kind: "blocked", summary: "报告缺少末页，请核对已有附件。" }
    })
  })

  it("shows a verified attachment after a failed execution only once its ready publication is acknowledged", async () => {
    const f = fixture()
    const { bot, store, task, work } = f
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "bot-failed-ready-")))
    try {
      beginVerifiedWork(f)
      const report = "周日下午三点，社区阅览室。\n"
      await writeFile(join(workspace, "report.md"), report)
      const [deliver] = createBotDeliveryTools(workspace, new AbortController().signal, (files, callId) => {
        store.recordWorkResultEvidence(task.id, { callId, files, assistantMessageId: "delivery-card" })
      })
      const call = { type: "tool_call" as const, id: "deliver-report", name: deliver.name, args: { files: ["report.md"] } }
      const delivered = await deliver.invoke(call)
      expect(deliver.name).toBe("bot_deliver_files")
      expect(delivered.status).not.toBe("error")
      const file = parseBotFileDelivery(delivered.content)?.[0]
      expect(file?.attachmentPath).toBeDefined()
      expect(await readFile(file!.attachmentPath!, "utf8")).toBe(report)

      store.settleRun(task.id, [], "failed", "Connection closed after file delivery", undefined, undefined, false,
        { outcome: "error", code: "provider_error" })
      const review = privateReview(store)
      const delivery = { sourceTaskId: task.id, callId: call.id, assistantMessageId: "delivery-card", fileIndex: 0, file }
      expect(store.getWorkResultReview(review.id)).toMatchObject({
        executionTaskId: task.id, outcome: { state: "failed" }, evidence: [{ deliveries: [delivery] }]
      })
      const summary = "已核查正式报告，确认活动时间和地点齐全。"
      expect(store.commitWorkResultReview(review.id, { ...ready, summary })).toMatchObject({
        state: "publish", publication: { kind: "ready", summary, attachments: [delivery] }
      })
      store.settle(review.id, "completed", null)
      store.flushReplies()
      const publication = notices(store).find(item => item.state === "queued")!
      store.transition(publication.id, "running")
      const pending = store.getWork(bot.id, work.id)
      expect(pending.executionState).toBe("failed")
      expect(pending.resultConclusion).toBeUndefined()
      expect(resolveBotWorkStatus(pending)).toEqual({ label: "执行失败", tone: "error", icon: "alert" })

      expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
      store.settle(publication.id, "completed", null)
      const published = store.getWork(bot.id, work.id)
      expect(published).toMatchObject({ executionState: "failed", resultConclusion: { kind: "ready", summary } })
      expect(store.getTask(task.id)).toMatchObject({ state: "failed", error: "Connection closed after file delivery" })
      expect.soft(resolveBotWorkStatus(published)).toEqual({ label: "成果已就绪", tone: "complete", icon: "ready", summary })
      expect(resolveBotWorkStatus({ ...published, backgroundBusy: true }).label).toBe("后台处理中")
      expect(resolveBotWorkStatus({ ...published, userControl: { settling: false, heldInputs: 1 } }).label).toBe("等待归还")
      expect(resolveBotWorkStatus({ ...published, dispatchStopped: true }).label).toBe("已停止")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it.each([false, true])("keeps an already committed result deliverable after manual completion (interrupted=%s)", interrupted => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.recordWorkResultEvidence(f.task.id, { finalMessageId: "original-result" })
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(f.store)
    if (interrupted) f.store.recover()
    else {
      f.store.commitWorkResultReview(review.id, ready)
      f.store.settle(review.id, "completed", null)
    }
    const work = f.store.getWork(f.bot.id, f.work.id)
    expect(f.store.changeWork(f.bot.id, f.work.id, work.version, "complete-settled", "complete").state)
      .toBe("completed")
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    expect(f.store.getWorkResultPublication(publication.id)).toMatchObject({
      kind: interrupted ? "interrupted" : "ready", executionTaskId: f.task.id, finalMessageId: "original-result"
    })
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
  })

  it("requires a genuine prepared submission and keeps the legacy result when no review was armed", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.recordPreparedInput(f.task.id, null)
    expect(f.store.armWorkResultReview(f.task.id, "incarnation")).toBe(false)
    f.store.settle(f.task.id, "completed", null, "Legacy outcome")
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(1)
    expect(notices(f.store)[0].origin).not.toHaveProperty("review")
  })

  it.each([
    { reviewed: true, state: "completed", unreadAtSettlement: false },
    { reviewed: true, state: "failed", unreadAtSettlement: false },
    { reviewed: true, state: "cancelled", unreadAtSettlement: true },
    { reviewed: false, state: "completed", unreadAtSettlement: true }
  ] as const)("settles an injected supplement with its physical run (reviewed=$reviewed, state=$state)", ({
    reviewed, state, unreadAtSettlement
  }) => {
    const f = fixture()
    const { store, bot, work, task } = f
    if (reviewed) beginVerifiedWork(f)
    else store.transition(task.id, "running")
    const user = store.enqueue({ botId: bot.id, requestId: "appendix", message: "Add an appendix." })
    store.transition(user.id, "running")
    store.recordPreparedInput(user.id, user.message)
    const supplement = store.sendWork({ taskId: user.id, callId: "send", key: "appendix" }, work.id, user.message)
    store.recordPreparedInput(supplement.id, supplement.message)
    expect(store.injectIntoRun(supplement.id, task.id)).toBe(true)
    store.settle(user.id, "completed", null)
    store.markWorksRead(bot.id, store.workActivities()[0].version)
    expect(store.workActivities()[0].unread).toBe(false)

    store.settleRun(task.id, [supplement.id], state, state === "failed" ? "Report check failed" : null)
    expect(store.getTask(supplement.id).state).toBe(state)
    expect(store.workActivities()[0].unread).toBe(unreadAtSettlement)
    if (unreadAtSettlement) return

    expect(store.getWork(bot.id, work.id).resultReviewState).toBe("waiting")
    const review = privateReview(store)
    const decision = state === "failed" ? { ...ready, kind: "blocked" as const, summary: "报告检查失败。" } : ready
    expect(store.commitWorkResultReview(review.id, decision).state).toBe("publish")
    store.settle(review.id, "completed", null)
    store.flushReplies()
    const publication = notices(store).find(item => item.state === "queued")!
    store.transition(publication.id, "running")
    expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(store.workActivities()[0]).toMatchObject({ unread: true, preview: decision.summary })
  })

  it("uses only user requests present at work dispatch when choosing the review authority", () => {
    const { store, bot } = fixture()
    const initial = store.enqueue({ botId: bot.id, requestId: "initial", message: "Prepare a local report" })
    store.transition(initial.id, "running")
    store.recordPreparedInput(initial.id, "Prepare a local report. Do not send it outside the workspace.")
    const supplement = store.enqueue({ botId: bot.id, requestId: "approved-supplement", message: "Use the latest data" })
    store.recordPreparedInput(supplement.id, "Use the approved February data")
    expect(store.injectIntoRun(supplement.id, initial.id)).toBe(true)
    const { task } = store.createWork({ botId: bot.id, operationId: "delegated", title: "Report", goal: "Prepare a local report" },
      { taskId: initial.id, callId: "dispatch", key: "dispatch" })
    expect(task.origin).toMatchObject({ sourceMessageIds: [initial.requestId, supplement.requestId] })

    const unrelated = store.enqueue({ botId: bot.id, requestId: "unrelated", message: "Separately, send the newsletter" })
    store.recordPreparedInput(unrelated.id, unrelated.message)
    expect(store.injectIntoRun(unrelated.id, initial.id)).toBe(true)
    store.settleRun(initial.id, [supplement.id, unrelated.id], "completed", null)
    store.transition(task.id, "running")
    store.recordPreparedInput(task.id, task.message)
    expect(store.armWorkResultReview(task.id, "incarnation")).toBe(true)
    store.settle(task.id, "completed", null, "Report created")
    expect(store.getWorkResultReview(privateReview(store).id)?.requests).toEqual([
      { id: initial.id, text: "Prepare a local report. Do not send it outside the workspace." },
      { id: supplement.id, text: "Use the approved February data" },
      { id: task.id, text: task.message }
    ])
    expect(task.message).toContain("Do not send it outside the workspace.")
    expect(task.message).toContain("Use the approved February data")
    expect(task.message).not.toContain(unrelated.message)
  })

  it.each(["assignment", "injected supplement"])("excludes main-chat prose after the target rewrites the %s", rewritten => {
    const { store, bot } = fixture()
    const raw = "Use the original sample TEST_ONLY_RAW"
    const source = store.enqueue({ botId: bot.id, requestId: "source", message: raw })
    store.transition(source.id, "running")
    store.recordPreparedInput(source.id, source.message)
    const { work, task } = store.createWork({ botId: bot.id, operationId: "dispatch", title: "Report",
      goal: rewritten === "assignment" ? raw : "Build the report" },
      { taskId: source.id, callId: "dispatch", key: "dispatch" })
    store.settle(source.id, "completed", null, "Dispatched")
    store.transition(task.id, "running")
    const approved = "Build the report using the approved sample"
    const assignment = rewritten === "assignment" ? approved : task.message
    store.recordPreparedInput(task.id, assignment)
    expect(store.armWorkResultReview(task.id, "incarnation")).toBe(true)
    const supplement = store.enqueue({ botId: bot.id, workId: work.id, requestId: "supplement",
      message: rewritten === "assignment" ? "Keep the output local" : raw })
    const accepted = rewritten === "assignment" ? supplement.message : approved
    store.recordPreparedInput(supplement.id, accepted)
    expect(store.injectIntoRun(supplement.id, task.id)).toBe(true)
    store.settleRun(task.id, [supplement.id], "completed", null, "Report created")
    const review = store.getWorkResultReview(privateReview(store).id)
    expect(review?.requests).toEqual([{ id: task.id, text: assignment }, { id: supplement.id, text: accepted }])
    expect(review?.remainingRepairs).toBe(2)
    expect(store.getTask(source.id).message).toBe(raw)
  })

  it("publishes one fixed decision with exact physical message and selected call snapshot", () => {
    const f = fixture()
    beginVerifiedWork(f)
    const file = { filePath: "/source/same.md", attachmentPath: "/retained/v1/same.md", name: "same.md", size: 8 }
    f.store.recordWorkResultEvidence(f.task.id, { finalMessageId: "final", callId: "delivery", files: [file] })
    f.store.settle(f.task.id, "completed", null, "Verified work")
    const review = privateReview(f.store)
    expect(f.store.getWorkResultReview(review.id)).toMatchObject({
      executionTaskId: f.task.id, incarnation: "incarnation", remainingRepairs: 2,
      requests: [{ id: f.task.id, text: "Approved execution scope" }],
      evidence: [{ taskId: f.task.id, finalMessageId: "final" }]
    })
    const decision = { ...ready, attachments: ["a".repeat(64)] }
    expect(() => f.store.commitWorkResultReview(review.id, decision, [
      { sourceTaskId: f.task.id, callId: "wrong", fileIndex: 0 }
    ])).toThrow("成果附件版本")
    const reference = { sourceTaskId: f.task.id, callId: "delivery", fileIndex: 0 }
    const committed = f.store.commitWorkResultReview(review.id, decision, [reference])
    expect(committed).toMatchObject({
      state: "publish", publication: { summary: ready.summary, finalMessageId: "final", attachments: [{ ...reference, file }] }
    })
    expect(f.store.commitWorkResultReview(review.id, decision, [reference])).toEqual(committed)
    f.store.settle(review.id, "completed", null, "Private scratch")
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    expect(f.store.getWorkResultPublication(publication.id)).toMatchObject({ summary: ready.summary })
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
    expect(notices(f.store)).toHaveLength(2)
  })

  it("rejects two versions of one file before committing a publication", () => {
    const f = fixture()
    beginVerifiedWork(f)
    const older = {
      filePath: "/source/report.csv", attachmentPath: "/retained/v1/report.csv", name: "report.csv", size: 8
    }
    const newer = { ...older, attachmentPath: "/retained/v2/report.csv" }
    const olderRef = { sourceTaskId: f.task.id, callId: "first-delivery", fileIndex: 0 }
    const newerRef = { ...olderRef, callId: "second-delivery" }
    f.store.recordWorkResultEvidence(f.task.id, { callId: olderRef.callId, files: [older] })
    f.store.recordWorkResultEvidence(f.task.id, { callId: newerRef.callId, files: [newer] })
    f.store.settle(f.task.id, "completed", null, "Both versions are retained")
    const review = privateReview(f.store)
    const oldId = "a".repeat(64)
    const newId = "b".repeat(64)

    expect(() => f.store.commitWorkResultReview(
      review.id, { ...ready, attachments: [oldId, newId] }, [olderRef, newerRef]
    )).toThrow("同一成果文件只能选择一个版本")
    f.store.flushReplies()
    expect(notices(f.store)).toEqual([expect.objectContaining({ id: review.id, state: "running" })])
    expect(f.store.commitWorkResultReview(review.id, { ...ready, attachments: [oldId] }, [olderRef]))
      .toMatchObject({ state: "publish", publication: { attachments: [{ ...olderRef, file: older }] } })
  })

  it.each([
    { kind: "ready", omit: true },
    { kind: "blocked", omit: true },
    { kind: "needs_user", omit: true },
    { kind: "ready", omit: false }
  ] as const)("settles $kind with formal snapshots only if the attachment selection is omitted ($omit)", ({ kind, omit }) => {
    const f = fixture()
    beginVerifiedWork(f)
    const file = { filePath: "/source/report.zip", attachmentPath: "/retained/report.zip", name: "report.zip", size: 8 }
    const reference = { sourceTaskId: f.task.id, callId: "delivery", fileIndex: 0 }
    f.store.recordWorkResultEvidence(f.task.id, {
      finalMessageId: "final", assistantMessageId: "original-file-card", callId: reference.callId, files: [file]
    })
    f.store.settle(f.task.id, "completed", null, "Original result")
    const review = privateReview(f.store)
    const decision = { ...ready, kind, ...(omit ? {} : { attachments: [] }) }
    const committed = f.store.commitWorkResultReview(review.id, decision)
    expect(committed).toMatchObject({ state: "publish", publication: {
      kind,
      attachments: omit ? [{ ...reference, file, assistantMessageId: "original-file-card" }] : []
    } })
  })

  it("uses the latest same-chain formal version after repair and mirrors it once on acknowledgement", () => {
    const f = fixture()
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.task.createdAt - 1)
    let bindingId: string
    try {
      const route = f.store.imGateway.register("realm", "owner", {
        id: "binding", botId: f.bot.id, kind: "dm", label: "IM", state: "active", version: 1,
        conversationKey: "personal-conversation", createdAt: new Date(0).toISOString(),
        expiresAt: new Date(f.task.createdAt + 90_000).toISOString()
      })
      bindingId = route.id
      f.store.im.importImBinding({
        id: route.id, botId: f.bot.id, kind: "dm", label: "IM", channelKey: "personal-channel", version: 1
      })
    } finally {
      clock.mockRestore()
    }
    beginVerifiedWork(f)
    const old = { filePath: "/source/report.zip", attachmentPath: "/retained/v1/report.zip", name: "report.zip", size: 8 }
    const next = { ...old, attachmentPath: "/retained/v2/report.zip" }
    f.store.recordWorkResultEvidence(f.task.id, { callId: "first-file", files: [old] })
    f.store.settle(f.task.id, "completed", null, "The original version needs a correction")
    const first = privateReview(f.store)
    const repair = f.store.commitWorkResultReview(first.id, {
      kind: "repair", gap: "Incorrect report", instruction: "Correct the report", evidenceIds: []
    })
    if (repair.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(first.id, "completed", null)
    f.store.transition(repair.task.id, "running")
    f.store.recordWorkResultEvidence(repair.task.id, {
      callId: "updated-file", assistantMessageId: "updated-file-card", files: [next]
    })
    f.store.settle(repair.task.id, "completed", null, "The corrected report is ready")
    const review = privateReview(f.store)
    const other = f.store.createWork({
      botId: f.bot.id, operationId: "other-work", title: "Other report", goal: "Build a separate report"
    })
    beginVerifiedWork({ ...f, ...other })
    f.store.recordWorkResultEvidence(other.task.id, {
      callId: "other-file", files: [{ ...old, attachmentPath: "/retained/other/report.zip" }]
    })
    const committed = f.store.commitWorkResultReview(review.id, ready)
    expect(committed).toMatchObject({ state: "publish", publication: { attachments: [{
      sourceTaskId: repair.task.id, callId: "updated-file", fileIndex: 0, assistantMessageId: "updated-file-card", file: next
    }] } })
    expect(f.store.commitWorkResultReview(review.id, ready)).toEqual(committed)
    f.store.settle(review.id, "completed", null)
    f.store.flushReplies()
    const [publication] = notices(f.store).filter(item => item.state === "queued")
    f.store.transition(publication.id, "running")
    expect(f.db.exec("SELECT id FROM bot_im_outbox")[0]?.values ?? []).toEqual([])
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
    f.store.settle(publication.id, "completed", null)
    f.store.flushReplies()
    expect(notices(f.store).filter(item => item.origin.kind === "work_result" && item.origin.review?.phase === "publish")).toHaveLength(1)
    const deliveryId = `im-personal-${publication.id}`
    const fileDeliveryId = `${deliveryId}:file:0`
    const rows = f.db.exec(`SELECT id,source_task_id,bot_id,work_id,binding_id,grant_version,text,files_json,file_delivery_id
      FROM bot_im_outbox ORDER BY rowid`)[0]?.values
    const owner = [publication.id, f.bot.id, f.work.id, bindingId, 1]
    expect(rows).toEqual([
      [deliveryId, ...owner, ready.summary, null, null],
      [fileDeliveryId, ...owner, "", expect.any(String), fileDeliveryId]
    ])
    expect(JSON.parse(String(rows?.[1][7]))).toEqual({ kind: "bot-file-delivery", files: [next] })
    expect(f.store.im.fileStatuses(f.bot.id, f.work.threadId, "updated-file"))
      .toEqual([{ id: fileDeliveryId, file: next, state: "pending", progress: 0 }])
    expect(f.store.im.fileStatuses(f.bot.id, f.work.threadId, "first-file")).toEqual([])
    expect(f.store.im.fileStatuses(f.bot.id, other.work.threadId, "updated-file")).toEqual([])
  })

  it.each([false, true])("bounds repairs across recovery (normal report=%s)", normal => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "First outcome")
    let store = f.store
    for (let index = 0; index < 2; index++) {
      const review = privateReview(store)
      expect(store.getWorkResultReview(review.id)?.remainingRepairs).toBe(2 - index)
      const decision = { kind: "repair" as const, gap: "Output needs a check", instruction: `Check ${index}`, evidenceIds: [] }
      const result = store.commitWorkResultReview(review.id, decision)
      expect(result.state).toBe("repair")
      if (result.state !== "repair") throw new Error("Expected original-work repair")
      expect(result.task).toMatchObject({ workId: f.work.id, threadId: f.work.threadId,
        origin: { kind: "work", dispatch: "repair", sourceTaskId: review.id } })
      expect(store.commitWorkResultReview(review.id, decision)).toEqual(result)
      store.settle(review.id, "completed", null)
      store = new BotStore(f.db)
      store.recover()
      expect(store.canDispatchWorkResultRepair(result.task.id)).toBe(true)
      settle(store, result.task, "completed", `Repair ${index} outcome`)
    }
    const review = privateReview(store)
    expect(store.getWorkResultReview(review.id)?.remainingRepairs).toBe(0)
    expect(() => store.commitWorkResultReview(review.id, { kind: "repair", gap: "Still missing",
      instruction: "Try again", evidenceIds: [] }, [], [], undefined, undefined, true)).toThrow("自动跟进已达上限")
    expect(store.getWorkResultReview(review.id)?.remainingRepairs).toBe(0)
    if (normal) {
      const response = { messageId: "bounded-normal-final", finalText: "已有成果保留，自动跟进达到上限。" }
      const result = store.commitWorkResultReview(review.id, null, [], [], undefined, response)
      expect(result).toMatchObject({ state: "publish", publication: { responseMessageId: response.messageId } })
      expect(store.commitWorkResultReview(review.id, null, [], [], undefined, response)).toEqual(result)
    } else {
      expect(store.commitWorkResultReview(review.id, { kind: "repair", gap: "Still missing",
        instruction: "Try again", evidenceIds: [] })).toMatchObject({ state: "publish", publication: { kind: "blocked" } })
    }
    expect(store.recentTasks().filter(task => task.origin.kind === "work" && task.origin.dispatch === "repair")).toHaveLength(2)
  })

  it("lets a newer main-chat request run first and resumes the same original result without consuming a repair", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(f.store)
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "progress", message: "Progress?" })
    expect(f.store.commitWorkResultReview(review.id, { ...ready, evidenceIds: [] })).toEqual({ state: "yielded" })
    f.store.settle(review.id, "superseded", null)
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(1)
    settle(f.store, user)
    const resumed = privateReview(f.store)
    expect(resumed.id).not.toBe(review.id)
    expect(f.store.getWorkResultReview(resumed.id)).toMatchObject({ executionTaskId: f.task.id, remainingRepairs: 2 })
  })

  it.each(["waiting", "checking"] as const)("replaces the %s execution only with approved detail input", phase => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const oldReview = phase === "checking" ? privateReview(f.store) : undefined
    const revised = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "detail-revision", message: "Use the revised format"
    })
    f.store.transition(revised.id, "running")
    f.store.beginInputPreparation(revised.id)
    expect(f.store.armWorkResultReview(revised.id, "incarnation")).toBe(false)
    f.store.recordPreparedInput(revised.id, "Use the approved revised format")
    expect(f.store.armWorkResultReview(revised.id, "incarnation")).toBe(true)
    f.store.settle(revised.id, "completed", null, "Revised outcome")
    if (oldReview) {
      expect(f.store.getWorkResultReview(oldReview.id)).toBeUndefined()
      expect(() => f.store.commitWorkResultReview(oldReview.id, {
        kind: "repair", gap: "Original format missing", instruction: "Restore the old format", evidenceIds: []
      })).toThrow("原执行或核查资格已变化")
      f.store.settle(oldReview.id, "cancelled", null)
    }
    const review = f.store.getWorkResultReview(privateReview(f.store).id)
    expect(review).toMatchObject({
      requestTaskId: f.task.id, executionTaskId: revised.id, remainingRepairs: 2,
      requests: [{ id: f.task.id, text: "Approved execution scope" }, { id: revised.id, text: "Use the approved revised format" }],
      outcome: { text: "Revised outcome" }
    })
  })

  it("does not replace approved detail output with a late command from the earlier execution", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.acceptCommand(f.task.id, {
      id: "old-check", threadId: f.work.threadId, command: "check", cwd: "/tmp", startedAt: 1
    })
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const revised = f.store.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "detail-revision", message: "Use the revised format"
    })
    f.store.transition(revised.id, "running")
    f.store.recordPreparedInput(revised.id, revised.message)
    expect(f.store.armWorkResultReview(revised.id, "incarnation")).toBe(true)
    f.store.settle(revised.id, "completed", null, "Revised outcome")
    f.store.flushReplies()
    expect(notices(f.store)).toEqual([])
    f.store.settleCommand({
      id: "old-check", threadId: f.work.threadId, exitCode: 0, output: "Previous format checked",
      cancelled: false, truncated: false
    })
    const receipt = f.store.recentTasks().find(task => task.origin.kind === "notification")!
    settle(f.store, receipt, "completed", "Previous check result")
    expect(f.store.getWorkResultReview(privateReview(f.store).id)).toMatchObject({
      requestTaskId: f.task.id, executionTaskId: revised.id, outcome: { text: "Revised outcome" }, commands: []
    })
  })

  it.each(["command", "peer"] as const)("keeps a newer completed work status after an old %s callback fails", kind => {
    const f = fixture()
    const { store, work, task, bot } = f
    beginVerifiedWork(f)
    const peer = store.create({ name: "Peer", instructions: "", color: "#123456", modelRef: null })
    const assignment = kind === "peer" ? store.delegate(task.id, peer.id, "Review old result", "old-peer") : undefined
    if (!assignment) store.acceptCommand(task.id, { id: "old-check", threadId: work.threadId,
      command: "check-old", cwd: "/tmp", startedAt: 1 })
    const input = store.enqueue({ botId: bot.id, workId: work.id, requestId: "new-format", message: "Use the new format" })
    store.recordPreparedInput(input.id, input.message)
    expect(store.injectIntoRun(input.id, task.id)).toBe(true)
    store.settleRun(task.id, [input.id], "completed", null, "New result ready for approval")
    if (assignment) settle(store, assignment, "completed", "Old peer result")
    else store.settleCommand({ id: "old-check", threadId: work.threadId, exitCode: 1,
      output: "Old check failed", cancelled: false, truncated: false })
    store.flushReplies()
    const callback = store.recentTasks().find(item => item.workId === work.id &&
      (item.origin.kind === "bot" || item.origin.kind === "notification"))!
    store.transition(callback.id, "running")
    expect(store.getWork(bot.id, work.id).executionState).toBe("running")
    store.settle(callback.id, "failed", "Obsolete result failed")
    const review = privateReview(store)
    expect(store.getWorkResultReview(review.id)?.outcome.state).toBe("completed")
    const decision = { ...ready, kind: "blocked" as const }
    expect(store.commitWorkResultReview(review.id, decision).state).toBe("publish")
    store.settle(review.id, "completed", null)
    store.flushReplies()
    const publication = notices(store).find(item => item.state === "queued")!
    store.transition(publication.id, "running")
    expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    store.settle(publication.id, "completed", null)
    expect(store.getTask(callback.id).state).toBe("failed")
    expect(store.getWork(bot.id, work.id)).toMatchObject({ executionState: "completed",
      resultConclusion: { kind: decision.kind, summary: decision.summary } })
    expect(store.listWorks(bot.id, undefined, "", "desktop", "model").items[0].executionState).toBe("completed")
  })

  it("shows only background evidence launched under the latest injected instruction", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.acceptCommand(f.task.id, { id: "before-input", threadId: f.work.threadId,
      command: "check-old", cwd: "/tmp", startedAt: 1 })
    const input = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "new-input",
      message: "Use the new output format" })
    f.store.recordPreparedInput(input.id, input.message)
    expect(f.store.injectIntoRun(input.id, f.task.id)).toBe(true)
    f.store.acceptCommand(f.task.id, { id: "after-input", threadId: f.work.threadId,
      command: "check-new", cwd: "/tmp", startedAt: 2 })
    f.store.settleRun(f.task.id, [input.id], "completed", null, "Checks started")
    for (const id of ["after-input", "before-input"]) {
      f.store.settleCommand({ id, threadId: f.work.threadId, exitCode: 0, output: id, cancelled: false, truncated: false })
      const callback = f.store.recentTasks().find(task => task.origin.kind === "notification" && task.origin.key === id)!
      expect(callback).toBeDefined()
      settle(f.store, callback, "completed", id === "before-input" ? "Obsolete check passed" : "Current check finished")
    }
    const review = f.store.getWorkResultReview(privateReview(f.store).id)!
    expect(review.commands.map(command => command.id)).toEqual(["after-input"])
    expect(review.outcome.text).toBe("Current check finished")
  })

  it.each([9, 10])("marks bounded request history as incomplete with %s supplements", count => {
    const f = fixture()
    beginVerifiedWork(f)
    const inputs = Array.from({ length: count }, (_, index) => {
      const input = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
        requestId: `scope-${index}`, message: `Approved constraint ${index}` })
      f.store.recordPreparedInput(input.id, input.message)
      expect(f.store.injectIntoRun(input.id, f.task.id)).toBe(true)
      return input
    })
    f.store.settleRun(f.task.id, inputs.map(input => input.id), "completed", null, "Result")
    const result = f.store.getWorkResultReview(privateReview(f.store).id)!
    expect(result.requestsOmitted).toBe(count > 9)
    expect(result.requests.slice(1).map(input => input.id)).toEqual(inputs.slice(-9).map(input => input.id))
  })

  it("uses the admitted supplement in the same physical result review without replenishing the budget", () => {
    const f = fixture()
    beginVerifiedWork(f)
    const earlier = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
      requestId: "earlier-supplement", message: "Keep this private" })
    f.store.recordPreparedInput(earlier.id, earlier.message)
    expect(f.store.injectIntoRun(earlier.id, f.task.id)).toBe(true)
    f.store.settleRun(f.task.id, [earlier.id], "completed", null, "First result")
    const first = privateReview(f.store)
    const repair = f.store.commitWorkResultReview(first.id, {
      kind: "repair", gap: "Check output", instruction: "Inspect the original report", evidenceIds: []
    })
    if (repair.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(first.id, "completed", null)
    f.store.transition(repair.task.id, "running")
    f.store.recordPreparedInput(repair.task.id, repair.task.message)
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "supplement", message: "Mention the file name" })
    f.store.transition(user.id, "running")
    const input = f.store.sendWork({ taskId: user.id, callId: "send", key: "send" }, f.work.id, user.message)
    f.store.recordPreparedInput(input.id, "Mention the approved file name and finish the planned verification")
    expect(f.store.injectIntoRun(input.id, repair.task.id)).toBe(true)
    expect(f.store.workResultReviewActiveForExecution(repair.task.id)).toBe(true)
    f.store.settle(user.id, "completed", null)
    f.store.recordWorkResultEvidence(repair.task.id, { finalMessageId: "repair-result" })
    f.store.settleRun(repair.task.id, [input.id], "completed", null, "The verification still failed")
    const second = privateReview(f.store)
    const review = f.store.getWorkResultReview(second.id)!
    expect(review).toMatchObject({
      executionTaskId: repair.task.id, requestTaskId: f.task.id, remainingRepairs: 1,
      executionSupplementRequestIds: [input.requestId],
      requests: [
        { id: f.task.id, text: "Approved execution scope" },
        { id: earlier.id, text: earlier.message },
        { id: input.id, text: "Mention the approved file name and finish the planned verification" }
      ]
    })
    const message = (id: string, role: Message["role"], content: string): Message =>
      ({ id, role, content, created_at: new Date() })
    const finalMessageId = review.evidence.at(-1)!.finalMessageId!
    const root = message(repair.task.requestId, "user", "Raw repair input")
    const progress = message("repair-progress", "assistant", "Verification is in progress")
    const final = message(finalMessageId, "assistant", "The verification still failed")
    const reviewProcess = (inputMessage: Message) => {
      const messages = [root, progress, inputMessage, final]
      return projectWorkResultProcess({ messages, total: messages.length, hasMore: true,
        beforeOrdinal: null, beforeMessageId: null }, {
        taskId: review.executionTaskId,
        requestId: review.executionRequestId,
        supplementRequestIds: review.executionSupplementRequestIds,
        finalMessageId,
        earlierExecutions: review.evidence.length > 1
      })
    }
    expect(reviewProcess(message(input.requestId, "user", input.message))).toEqual({
      coverage: "partial", steps: [{ text: progress.content }]
    })
    expect(reviewProcess(message(earlier.requestId, "user", earlier.message))).toEqual({
      coverage: "unavailable", steps: []
    })
    expect(notices(f.store).every(item => item.origin.kind === "work_result" && item.origin.review)).toBe(true)
  })

  it.each([true, false])("admits a newer follow-up before the queued repair, retaining its budget (accepted=%s)", accepted => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "First result")
    const first = privateReview(f.store)
    const decision = {
      kind: "repair" as const, gap: "Check output", instruction: "Run the original verification", evidenceIds: []
    }
    const repair = f.store.commitWorkResultReview(first.id, decision)
    if (repair.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(first.id, "completed", null)
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "new-user", message: "Use the revised format" })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    const next = f.store.sendWork({ taskId: user.id, callId: "send", key: "send" }, f.work.id, user.message)
    f.store.settle(user.id, "completed", null)

    const store = new BotStore(f.db)
    store.recover()
    expect(store.nextQueued([])?.id).toBe(next.id)
    expect(store.canDispatchWorkResultRepair(repair.task.id)).toBe(false)
    store.transition(next.id, "running")
    store.beginInputPreparation(next.id)
    if (!accepted) {
      store.settle(next.id, "failed", null, undefined, undefined, false, { outcome: "error", code: "prompt_blocked" })
      expect(store.nextQueued([])?.id).toBe(repair.task.id)
      expect(store.canDispatchWorkResultRepair(repair.task.id)).toBe(true)
      return
    }
    store.recordPreparedInput(next.id, "Use the approved revised format")
    expect(store.armWorkResultReview(next.id, "incarnation")).toBe(true)
    expect(store.getTask(repair.task.id).state).toBe("cancelled")
    store.settle(next.id, "completed", null, "Revised result")
    const review = privateReview(store)
    expect(store.getWorkResultReview(review.id)).toMatchObject({
      requestTaskId: f.task.id, executionTaskId: next.id, remainingRepairs: 1,
      requests: [{ id: f.task.id, text: "Approved execution scope" }, { id: next.id, text: "Use the approved revised format" }]
    })
    // The old attempt used budget at admission but never ran. Its instruction
    // fingerprint must not falsely claim that the revised result was already repaired.
    expect(store.commitWorkResultReview(review.id, decision)).toMatchObject({ state: "repair" })
  })

  it.each([
    { take: false, accepted: true }, { take: false, accepted: false },
    { take: true, accepted: true }, { take: true, accepted: false }
  ])("checks a newer detail input before resuming old repair (take=$take, accepted=$accepted)", ({ take, accepted }) => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original result")
    const review = privateReview(f.store)
    const repair = f.store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Check original", instruction: "Continue using the original format", evidenceIds: []
    })
    if (repair.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(review.id, "completed", null)
    const control = (action: "take" | "return") => f.store.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, action, operationId: action,
      ...(action === "return" ? { confirmedTaskIds: f.store.workControlPending(f.bot.id, f.work.id).items.map(item => item.taskId) } : {}),
      expectedVersion: f.store.getWork(f.bot.id, f.work.id).version
    })
    if (take) {
      expect(control("take").userControl?.heldInputs).toBe(1)
      expect(f.store.finishWorkControlHandoffs(new Set())).toBe(true)
    }
    const next = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "detail-follow-up", message: "Use the revised format" })
    expect(f.store.nextQueued([])?.id).toBe(next.id)
    expect(f.store.canDispatchWorkResultRepair(repair.task.id)).toBe(false)
    f.store.transition(next.id, "running")
    f.store.beginInputPreparation(next.id)
    if (!accepted) {
      f.store.settle(next.id, "failed", null, undefined, undefined, false, { outcome: "error", code: "prompt_blocked" })
      if (take) control("return")
      expect(f.store.nextQueued([f.bot.threadId])?.id).toBe(repair.task.id)
      expect(f.store.canDispatchWorkResultRepair(repair.task.id)).toBe(true)
      return
    }
    f.store.recordPreparedInput(next.id, "Use the approved revised format")
    if (take) {
      expect(f.store.armWorkResultReview(next.id, "incarnation")).toBe(false)
      f.store.settle(next.id, "completed", null, "Revised result")
      expect(f.store.workControlPending(f.bot.id, f.work.id).items.map(item => item.taskId)).toEqual([repair.task.id])
      expect(f.store.withdrawHeldWorkResultRepair(f.store.getTask(repair.task.id))).toBe(true)
      control("return")
      f.store.flushReplies()
      expect(notices(f.store).filter(item => item.state === "queued").map(item => item.origin))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "work_result", executionTaskId: next.id }),
          expect.objectContaining({ kind: "work_result", review: { requestTaskId: f.task.id, phase: "publish" } })
        ]))
      expect(f.store.nextQueued([f.bot.threadId])).toBeNull()
      return
    }
    expect(f.store.armWorkResultReview(next.id, "incarnation")).toBe(true)
    expect(f.store.getTask(repair.task.id).state).toBe("cancelled")
    f.store.settle(next.id, "completed", null, "Revised result")
    const revised = f.store.getWorkResultReview(privateReview(f.store).id)
    expect(revised).toMatchObject({ executionTaskId: next.id, requestTaskId: f.task.id, remainingRepairs: 1 })
    expect(revised?.requests).toContainEqual({ id: next.id, text: "Use the approved revised format" })
  })

  it.each([false, true])("taking control waits for the original finite command and settles retained results once (stop=%s)", stop => {
    const f = fixture()
    beginVerifiedWork(f)
    const file = { filePath: "/project/report.md", attachmentPath: "/retained/report.md", name: "report.md", size: 8 }
    f.store.recordWorkResultEvidence(f.task.id, { finalMessageId: "final", callId: "file", files: [file] })
    f.store.acceptCommand(f.task.id, { id: "check", threadId: f.work.threadId, command: "check", cwd: "/tmp", startedAt: 1 })
    const held = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "held", message: "Separate queued input" })
    const took = f.store.changeWorkControl({ botId: f.bot.id, workId: f.work.id,
      expectedVersion: f.store.getWork(f.bot.id, f.work.id).version, action: "take", operationId: "take" })
    expect(took.userControl).toMatchObject({ settling: true, heldInputs: 1 })
    if (stop) f.store.stopWorkDispatch(f.bot.id, f.work.id)
    f.store.settle(f.task.id, "completed", null, "Original completed work")
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(0)
    f.store.settleCommand({ id: "check", threadId: f.work.threadId, exitCode: 0, output: "Checked", cancelled: false, truncated: false })
    const receipt = f.store.recentTasks().find(task => task.origin.kind === "notification")!
    settle(f.store, receipt, "completed", BOT_ROUTINE_SILENT)
    f.store.flushReplies()
    if (stop) {
      expect(notices(f.store)).toHaveLength(0)
      return
    }
    expect(f.store.getTask(held.id).state).toBe("queued")
    expect(notices(f.store)).toHaveLength(0)
    expect(f.store.finishWorkControlHandoffs(new Set())).toBe(true)
    f.store.flushReplies()
    const [publication] = notices(f.store)
    expect(publication.origin).toMatchObject({ review: { phase: "publish" } })
    f.store.transition(publication.id, "running")
    expect(f.store.getWorkResultPublication(publication.id)).toMatchObject({
      executionTaskId: receipt.id, kind: "reported",
      summary: expect.stringMatching(/原任务返回的结果[\s\S]*Original completed work/),
      attachments: [{ sourceTaskId: f.task.id, finalMessageId: "final", file }]
    })
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
    f.store.changeWorkControl({ botId: f.bot.id, workId: f.work.id,
      expectedVersion: f.store.getWork(f.bot.id, f.work.id).version, action: "return",
      operationId: "return-after-report", confirmedTaskIds: [held.id] })
    const reopened = new BotStore(f.db)
    expect(reopened.getWork(f.bot.id, f.work.id).resultConclusion?.kind).toBe("reported")
    expect(reopened.getTask(held.id).state).toBe("queued")
    expect(resolveBotWorkStatus(reopened.getWork(f.bot.id, f.work.id)).label).toBe("等待执行")
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(1)
  })

  it("allows only reporting from a running result turn after takeover and settles interruption", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original result")
    const review = privateReview(f.store)
    f.store.changeWorkControl({ botId: f.bot.id, workId: f.work.id,
      expectedVersion: f.store.getWork(f.bot.id, f.work.id).version, action: "take", operationId: "take-review" })
    expect(f.store.finishWorkControlHandoffs(new Set([review.threadId]))).toBe(true)
    expect(f.store.getWorkResultReview(review.id)?.remainingRepairs).toBe(0)
    expect(() => f.store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Late decision", instruction: "Should not run", evidenceIds: []
    }, [], [], undefined, undefined, true)).toThrow("不能自动执行补修")
    f.store.settle(review.id, "cancelled", null)
    f.store.flushReplies()
    expect(notices(f.store).filter(task => task.state === "queued").map(task => task.origin))
      .toEqual([expect.objectContaining({ review: { requestTaskId: f.task.id, phase: "publish" } })])
    const publication = notices(f.store).find(task => task.state === "queued")!
    f.store.transition(publication.id, "running")
    expect(f.store.getWorkResultPublication(publication.id)?.kind).toBe("interrupted")
    f.store.settle(publication.id, "completed", null)
    f.store.changeWorkControl({ botId: f.bot.id, workId: f.work.id,
      expectedVersion: f.store.getWork(f.bot.id, f.work.id).version, action: "return",
      operationId: "return-report", confirmedTaskIds: [] })
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "resume-report", message: "Continue handling the result" })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    const source = { taskId: user.id, callId: "resume-report", key: "resume-report" }
    expect(f.store.changeWork(f.bot.id, f.work.id, f.store.getWork(f.bot.id, f.work.id).version,
      source.callId, "continue", source).resultReviewState).toBe("waiting")
    f.store.settle(user.id, "completed", null)
    const resumed = privateReview(f.store)
    expect(f.store.getWorkResultReview(resumed.id)?.remainingRepairs).toBe(0)
    expect(f.store.commitWorkResultReview(resumed.id, null, [], [], undefined,
      { messageId: "resumed-report", finalText: "Original result" })).toMatchObject({ state: "publish",
        publication: { kind: "reported", responseMessageId: "resumed-report" } })
    expect(f.store.getTask(f.task.id).state).toBe("completed")
  })

  it("keeps a failed original execution blocked when handing control to the user", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.changeWorkControl({ botId: f.bot.id, workId: f.work.id,
      expectedVersion: f.store.getWork(f.bot.id, f.work.id).version, action: "take", operationId: "take-failed" })
    f.store.settle(f.task.id, "failed", "Execution failed", "Partial result")
    f.store.finishWorkControlHandoffs(new Set())
    f.store.flushReplies()
    const publication = notices(f.store).find(task => task.state === "queued")!
    f.store.transition(publication.id, "running")
    expect(f.store.getWorkResultPublication(publication.id)).toMatchObject({
      kind: "blocked", summary: expect.stringContaining("Partial result")
    })
  })

  it.each([false, true])("holds the accepted repair through take and return, honoring exact cancellation (%s)", cancelled => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(f.store)
    const repair = f.store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Check output", instruction: "Inspect the original report", evidenceIds: []
    })
    if (repair.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(review.id, "completed", null)
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "new-main", message: "Wait" })
    f.store.transition(user.id, "running")
    expect(f.store.nextQueued([user.threadId])).toBeNull()
    expect(() => f.store.transition(repair.task.id, "running")).toThrow("自动补修资格")
    const took = f.store.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: f.store.getWork(f.bot.id, f.work.id).version,
      action: "take", operationId: "take-review"
    })
    expect(took.userControl?.heldInputs).toBe(1)
    f.store.flushReplies()
    expect(f.store.getTask(repair.task.id).state).toBe("queued")
    expect(f.store.finishWorkControlHandoffs(new Set())).toBe(true)
    expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false)
    const manual = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
      requestId: "manual-status", message: "What is the current status?" })
    f.store.transition(manual.id, "running")
    f.store.beginInputPreparation(manual.id)
    const giveBack = () => f.store.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: f.store.getWork(f.bot.id, f.work.id).version,
      action: "return", operationId: "return-review", confirmedTaskIds: cancelled ? [] : [repair.task.id]
    })
    expect(giveBack).toThrow("请等当前回复处理完")
    f.store.recordPreparedInput(manual.id, manual.message)
    expect(f.store.armWorkResultReview(manual.id, "incarnation")).toBe(false)
    f.store.settle(manual.id, "cancelled", null)
    expect(f.store.workControlPending(f.bot.id, f.work.id).items.map(item => item.taskId)).toEqual([repair.task.id])
    if (cancelled) f.store.transition(repair.task.id, "cancelled")
    giveBack()
    f.store.settle(user.id, "completed", null)
    f.store.flushReplies()
    expect(f.store.getTask(repair.task.id).state).toBe(cancelled ? "cancelled" : "queued")
    expect(f.store.canDispatchWorkResultRepair(repair.task.id)).toBe(!cancelled)
  })

  it("returns a claimed repair to its original queue if a newer user arrives before preparation", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(f.store)
    const committed = f.store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Check output", instruction: "Inspect the original report", evidenceIds: []
    })
    if (committed.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(review.id, "completed", null)
    expect(f.store.canDispatchWorkResultRepair(committed.task.id, "wrong")).toBe(false)
    f.store.transition(committed.task.id, "running")
    const newer = f.store.enqueue({ botId: f.bot.id, requestId: "new-main-after-claim", message: "Progress?" })
    f.store.settle(committed.task.id, "superseded", null)
    expect(f.store.getTask(committed.task.id).state).toBe("queued")
    settle(f.store, newer)
    expect(f.store.nextQueued([])?.id).toBe(committed.task.id)
    expect(f.store.canDispatchWorkResultRepair(committed.task.id, "incarnation")).toBe(true)
  })

  it("withdraws a held repair and replays its receipt without retiring a newer review", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(f.store)
    const committed = f.store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Check output", instruction: "Inspect the original report", evidenceIds: []
    })
    if (committed.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(review.id, "completed", null)
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "withdraw", message: "Stop automatic repair" })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    const take = f.store.changeWorkControl({ botId: f.bot.id, workId: f.work.id,
      expectedVersion: f.store.getWork(f.bot.id, f.work.id).version, action: "take", operationId: "take" })
    const pause = { taskId: user.id, callId: "pause", key: "pause" }
    const receipt = f.store.requestWorkReviewPause(pause, f.work.id, take.version)
    expect(receipt.reviewPaused).toBe(true)
    expect(f.store.getTask(committed.task.id).state).toBe("cancelled")
    expect(f.store.getWork(f.bot.id, f.work.id).userControl).toBeDefined()
    f.store.changeWorkControl({ botId: f.bot.id, workId: f.work.id,
      expectedVersion: receipt.version, action: "return", operationId: "return" })
    const next = f.store.sendWork({ taskId: user.id, callId: "execute", key: "execute" }, f.work.id, "Revise with the new plan")
    f.store.transition(next.id, "running")
    f.store.recordPreparedInput(next.id, next.message)
    expect(f.store.armWorkResultReview(next.id, "incarnation")).toBe(true)
    expect(f.store.requestWorkReviewPause({ ...pause, callId: "retry" }, f.work.id, take.version)).toEqual(receipt)
    f.store.settle(user.id, "completed", null)
    f.store.settle(next.id, "completed", null, "New plan result")
    expect(f.store.getWorkResultReview(privateReview(f.store).id)?.executionTaskId).toBe(next.id)
  })

  it.each([false, true])("preserves the owed result when pausing a claimed repair (prepared=%s)", prepared => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(f.store)
    const repair = f.store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Check output", instruction: "Inspect the original report", evidenceIds: []
    })
    if (repair.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(review.id, "completed", null)
    f.store.transition(repair.task.id, "running")
    f.store.beginInputPreparation(repair.task.id)
    if (prepared) f.store.recordPreparedInput(repair.task.id, repair.task.message)

    const user = f.store.enqueue({ botId: f.bot.id, requestId: "pause", message: "Stop automatic checking" })
    f.store.transition(user.id, "running")
    expect(f.store.controlWorkResultReview(user.id, f.work.id, "pause")).toBe(true)
    expect(f.store.getTask(repair.task.id).state).toBe("running")
    expect(f.store.canDispatchWorkResultRepair(repair.task.id)).toBe(false)
    f.store.settle(user.id, "completed", null)
    f.store.flushReplies()
    expect(f.store.nextQueued([])).toBeNull()
    f.store.settle(repair.task.id, prepared ? "completed" : "superseded", null, prepared ? "Prepared repair outcome" : undefined)
    f.store.flushReplies()
    const publication = f.store.nextQueued([])!
    f.store.transition(publication.id, "running")
    expect(f.store.getWorkResultPublication(publication.id)).toMatchObject({
      executionTaskId: prepared ? repair.task.id : f.task.id,
      summary: expect.stringContaining(prepared ? "Prepared repair outcome" : "Original outcome")
    })
  })

  it.each([false, true])("holds a claimed repair before preparation across takeover (%s restart)", restart => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original outcome")
    const review = privateReview(f.store)
    const repair = f.store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Check output", instruction: "Inspect the original report", evidenceIds: []
    })
    if (repair.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(review.id, "completed", null)
    f.store.transition(repair.task.id, "running")
    f.store.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: f.store.getWork(f.bot.id, f.work.id).version,
      action: "stop_and_take", operationId: "take-claimed-repair"
    })
    expect(f.store.workControlStops()[0]?.taskIds).not.toContain(repair.task.id)
    const store = restart ? new BotStore(f.db) : f.store
    if (restart) store.recover()
    else store.settle(repair.task.id, "superseded", null)
    store.finishWorkControlHandoffs(new Set())
    const held = store.getWork(f.bot.id, f.work.id)
    expect(held.userControl).toMatchObject({ settling: false, heldInputs: 1 })
    expect(store.getTask(repair.task.id).state).toBe("queued")
    expect(store.nextQueued([])).toBeNull()
    store.changeWorkControl({
      botId: f.bot.id, workId: f.work.id, expectedVersion: held.version,
      action: "return", operationId: "return-claimed-repair", confirmedTaskIds: [repair.task.id]
    })
    expect(store.nextQueued([])?.id).toBe(repair.task.id)
  })

  it("records an interrupted review once, without re-running the original or pretending the outcome was verified", () => {
    const f = fixture()
    beginVerifiedWork(f)
    const file = { filePath: "/work/report.md", attachmentPath: "/retained/report.md", name: "report.md", size: 10 }
    f.store.recordWorkResultEvidence(f.task.id, { callId: "retained-file", files: [file] })
    f.store.settle(f.task.id, "completed", null, "Original output")
    const review = privateReview(f.store)
    const reopened = new BotStore(f.db)
    reopened.recover()
    reopened.flushReplies()
    reopened.recover()
    reopened.flushReplies()
    expect(reopened.getTask(review.id).state).toBe("interrupted")
    expect(reopened.getTask(f.task.id).state).toBe("completed")
    const publication = notices(reopened).find(task => task.state === "queued")!
    reopened.transition(publication.id, "running")
    expect(reopened.getWorkResultPublication(publication.id)).toMatchObject({
      kind: "interrupted", executionTaskId: f.task.id,
      summary: "结果回传中断，已有执行记录和附件仍保留在原任务中。可以查看原任务，或在本对话说「继续处理结果」。",
      attachments: [{ sourceTaskId: f.task.id, callId: "retained-file", file }]
    })
    // Without the Host final callback receipt, do not guess a transcript final
    // or turn a partially persisted report into a successful completion.
    expect(reopened.getWorkResultPublication(publication.id)?.responseMessageId).toBeUndefined()
    expect(notices(reopened).filter(task => task.state === "queued" || task.state === "running")).toHaveLength(1)
    expect(reopened.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    reopened.settle(publication.id, "completed", null)
    reopened.recover()
    reopened.flushReplies()
    expect(notices(reopened).filter(task => task.state === "queued" || task.state === "running")).toHaveLength(0)
  })

  it("resumes an interrupted result through the original desktop Continue receipt with its remaining budget", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original output")
    const firstReview = privateReview(f.store)
    const firstDecision = f.store.commitWorkResultReview(firstReview.id, {
      kind: "repair", gap: "Check the original report", instruction: "Verify the report", evidenceIds: []
    })
    if (firstDecision.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(firstReview.id, "completed", null)
    settle(f.store, firstDecision.task, "completed", "Repaired output")
    const interrupted = privateReview(f.store)
    f.store.settle(interrupted.id, "interrupted", null)

    const user = f.store.enqueue({ botId: f.bot.id, requestId: "continue-review", message: "Continue the result check" })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    const before = f.store.getWork(f.bot.id, f.work.id)
    const source = { taskId: user.id, callId: "continue-call", key: "continue-key" }
    const result = f.store.changeWork(f.bot.id, f.work.id, before.version, source.callId, "continue", source)
    expect(result).toMatchObject({ state: "active", resultReviewState: "waiting", version: before.version + 1 })
    expect(f.store.changeWork(f.bot.id, f.work.id, before.version, source.callId, "continue", source)).toEqual(result)
    f.store.flushReplies()
    expect(notices(f.store).filter(item => item.state === "queued" && item.origin.kind === "work_result" &&
      item.origin.review?.phase === "review")).toHaveLength(0)
    f.store.settle(user.id, "completed", null)
    const resumed = privateReview(f.store)
    expect(f.store.getWorkResultReview(resumed.id)).toMatchObject({
      executionTaskId: firstDecision.task.id, requestTaskId: f.task.id, remainingRepairs: 1
    })
    f.store.settle(resumed.id, "interrupted", null)
    const staleUser = f.store.enqueue({ botId: f.bot.id, requestId: "continue-stale", message: "Continue" })
    f.store.transition(staleUser.id, "running")
    f.store.recordPreparedInput(staleUser.id, staleUser.message)
    expect(() => f.store.changeWork(f.bot.id, f.work.id, before.version, "stale", "continue",
      { taskId: staleUser.id, callId: "stale", key: "new-key" })).toThrow("工作状态已变化")
    expect(f.store.getWork(f.bot.id, f.work.id).resultReviewState).toBe("interrupted")
    expect(f.store.getTask(f.task.id).state).toBe("completed")
  })

  it("retains the original background evidence across unrelated command retention and review resumption", () => {
    const f = fixture()
    const { store, work, task, bot } = f
    beginVerifiedWork(f)
    store.acceptCommand(task.id, { id: "original-check", threadId: work.threadId, command: "check", cwd: "/tmp", startedAt: 1 })
    store.settle(task.id, "completed", null, "Validation pending")
    store.settleCommand({ id: "original-check", threadId: work.threadId, exitCode: 7,
      output: "Original assertion failed", cancelled: false, truncated: false })
    const receipt = store.recentTasks().find(item => item.origin.kind === "notification")!
    settle(store, receipt, "completed", "Check failed")
    const review = privateReview(store)
    const commands = store.getWorkResultReview(review.id)!.commands
    expect(commands).toMatchObject([{ id: "original-check", result: { exitCode: 7 } }])
    store.settle(review.id, "interrupted", null)
    store.flushReplies()
    const publication = notices(store).find(item => item.state === "queued")!
    store.transition(publication.id, "running")
    expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    store.settle(publication.id, "completed", null)

    const unrelated = store.enqueue({ botId: bot.id, requestId: "other-requests", message: "Separate work" })
    store.transition(unrelated.id, "running")
    for (let i = 0; i < 201; i++) {
      const id = `separate-check-${i}`
      store.acceptCommand(unrelated.id, { id, threadId: bot.threadId, command: "other", cwd: "/tmp", startedAt: i + 1,
        notifyOnComplete: false })
      store.settleCommand({ id, threadId: bot.threadId, exitCode: 0, output: "OK", cancelled: false, truncated: false })
    }
    store.settle(unrelated.id, "completed", null)
    const user = store.enqueue({ botId: bot.id, requestId: "resume-original", message: "Continue checking" })
    store.transition(user.id, "running")
    store.recordPreparedInput(user.id, user.message)
    const source = { taskId: user.id, callId: "resume-original", key: "resume-original" }
    store.changeWork(bot.id, work.id, store.getWork(bot.id, work.id).version, source.callId, "continue", source)
    store.settle(user.id, "completed", null)
    expect(store.getWorkResultReview(privateReview(store).id)?.commands).toEqual(commands)
  })

  it("retains current command receipts when older checks finish after the amended work", () => {
    const f = fixture()
    const { store, work, task, bot } = f
    beginVerifiedWork(f)
    const start = (id: string) => store.acceptCommand(task.id, {
      id, threadId: work.threadId, command: "check", cwd: "/tmp", startedAt: 1
    })
    const complete = (id: string) => {
      store.settleCommand({ id, threadId: work.threadId, exitCode: 0, output: id, cancelled: false, truncated: false })
    }
    const settleCallback = (id: string) => {
      const callback = store.recentTasks().find(item => item.origin.kind === "notification" && item.origin.key === id)!
      settle(store, callback, "completed", BOT_ROUTINE_SILENT)
    }
    const oldIds = Array.from({ length: 7 }, (_, i) => `old-check-${i}`)
    oldIds.forEach(start)
    const input = store.enqueue({ botId: bot.id, workId: work.id, requestId: "corrected", message: "Use the new checks" })
    store.recordPreparedInput(input.id, input.message)
    expect(store.injectIntoRun(input.id, task.id)).toBe(true)
    start("new-first")
    complete("new-first")
    start("new-second")
    complete("new-second")
    store.settleRun(task.id, [input.id], "completed", null, "New report")
    settleCallback("new-first")
    settleCallback("new-second")
    for (const id of oldIds) {
      complete(id)
      settleCallback(id)
    }

    const other = store.enqueue({ botId: bot.id, requestId: "other-commands", message: "Separate work" })
    store.transition(other.id, "running")
    for (let i = 0; i < 201; i++) {
      const id = `separate-check-${i}`
      store.acceptCommand(other.id, { id, threadId: bot.threadId, command: "other", cwd: "/tmp", startedAt: i + 1,
        notifyOnComplete: false })
      store.settleCommand({ id, threadId: bot.threadId, exitCode: 0, output: "OK", cancelled: false, truncated: false })
    }
    store.settle(other.id, "completed", null)
    expect(store.getWorkResultReview(privateReview(store).id)?.commands.map(item => item.id))
      .toEqual(["new-second", "new-first"])
  })

  it.each([false, true])("keeps approved injected input across historical cleanup and resume (rewritten: %s)", rewritten => {
    const f = fixture()
    const { store, work, task, bot } = f
    beginVerifiedWork(f)
    const input = store.enqueue({ botId: bot.id, workId: work.id, requestId: "amended-input", message: "Use Q2 with customer details" })
    const approved = rewritten ? "Use Q2 excluding customer details" : input.message
    store.recordPreparedInput(input.id, approved)
    expect(store.injectIntoRun(input.id, task.id)).toBe(true)
    store.settleRun(task.id, [input.id], "completed", null, "Report ready")
    const earlier = privateReview(store)
    store.settle(earlier.id, "interrupted", null)
    store.flushReplies()
    const publication = notices(store).find(item => item.state === "queued")!
    store.transition(publication.id, "running")
    expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    store.settle(publication.id, "completed", null)
    f.advanceClock(31 * 24 * 60 * 60 * 1000)
    const reopened = new BotStore(f.db, () => 31 * 24 * 60 * 60 * 1000 + 9_000)
    reopened.recover()
    for (let index = 0; index < 105; index++) {
      const other = reopened.enqueue({ botId: bot.id, requestId: `ordinary-${index}`, message: "Separate request" })
      settle(reopened, other)
    }
    reopened.pruneTaskHistory()
    const user = reopened.enqueue({ botId: bot.id, requestId: "resume-report", message: "Continue checking the report" })
    reopened.transition(user.id, "running")
    reopened.recordPreparedInput(user.id, user.message)
    expect(reopened.controlWorkResultReview(user.id, work.id, "resume")).toBe(true)
    reopened.settle(user.id, "completed", null)
    expect(reopened.getWorkResultReview(privateReview(reopened).id)).toMatchObject({
      requests: [{ id: task.id, text: "Approved execution scope" }, { id: input.id, text: approved }],
      executionSupplementRequestIds: [input.requestId]
    })
  })

  it("continues checking an unknown execution using its approved input and retained result", () => {
    const f = fixture()
    const { store, bot, work, task } = f
    beginVerifiedWork(f)
    const file = { filePath: "/project/report.md", attachmentPath: "/retained/report.md",
      name: "report.md", size: 8 }
    store.recordWorkResultEvidence(task.id, { finalMessageId: "saved-result", callId: "deliver", files: [file] })
    store.settle(task.id, "outcome_unknown", "Completion could not be confirmed")
    store.flushReplies()
    const interruption = notices(store).find(item => item.state === "queued")!
    store.transition(interruption.id, "running")
    expect(store.getWorkResultPublication(interruption.id)).toMatchObject({
      executionTaskId: task.id, kind: "interrupted", attachments: [{ file }]
    })
    expect(store.acknowledgeWorkResultPublication(interruption.id)).toBe(true)
    store.settle(interruption.id, "completed", null)

    const user = store.enqueue({ botId: bot.id, requestId: "continue-unknown",
      message: "Continue checking the retained report without rerunning the task" })
    store.transition(user.id, "running")
    store.recordPreparedInput(user.id, user.message)
    const source = { taskId: user.id, callId: "continue", key: "continue-unknown" }
    const resumed = store.changeWork(bot.id, work.id, store.getWork(bot.id, work.id).version,
      source.callId, "continue", source)
    expect(resumed).toMatchObject({ executionState: "outcome_unknown", resultReviewState: "waiting" })
    store.settle(user.id, "completed", null)

    const review = privateReview(store)
    expect(store.getWorkResultReview(review.id)).toMatchObject({
      requestTaskId: task.id, executionTaskId: task.id,
      requests: [{ id: task.id, text: "Approved execution scope" }],
      outcome: { state: "outcome_unknown", finalMessageId: "saved-result" },
      evidence: [{ taskId: task.id, finalMessageId: "saved-result", deliveries: [{ callId: "deliver", file }] }]
    })
    expect(() => store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Verify report", instruction: "Run the original task again", evidenceIds: []
    })).toThrow("本次结果不能继续自动补修")
    expect(store.commitWorkResultReview(review.id, ready).state).toBe("publish")
    store.settle(review.id, "completed", null)
    store.flushReplies()
    const publication = notices(store).find(item => item.state === "queued")!
    expect(publication.requestId).toMatch(/-final$/)
    store.transition(publication.id, "running")
    expect(store.getWorkResultPublication(publication.id)).toMatchObject({
      executionTaskId: task.id, kind: "ready", attachments: [{ file }]
    })
    expect(store.getWork(bot.id, work.id).resultConclusion).toBeUndefined()
    expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    store.settle(publication.id, "completed", null)
    expect(store.getWork(bot.id, work.id)).toMatchObject({
      executionState: "outcome_unknown", resultConclusion: { kind: "ready", summary: ready.summary }
    })
    expect(store.recentTasks().filter(item => item.workId === work.id).map(item => [item.id, item.state]))
      .toEqual([[task.id, "outcome_unknown"]])
  })

  it.each(["unprepared", "cancelled", "stopped", "wrong-source"] as const)(
    "does not revive verification with this prerequisite: %s", (prerequisite) => {
      const f = fixture()
      const { store, bot, work, task } = f
      if (prerequisite === "unprepared") {
        store.transition(task.id, "running")
        store.beginInputPreparation(task.id)
        expect(store.armWorkResultReview(task.id, "incarnation")).toBe(false)
      } else beginVerifiedWork(f)
      const state = prerequisite === "cancelled" ? "cancelled" : "outcome_unknown"
      store.settle(task.id, state, null)
      if (prerequisite === "stopped") store.stopWorkDispatch(bot.id, work.id)

      const sender = prerequisite === "wrong-source"
        ? store.create({ name: "Other", instructions: "", color: "#234567", modelRef: null }) : bot
      const user = store.enqueue({ botId: sender.id, requestId: "continue-ineligible", message: "Continue the result check" })
      store.transition(user.id, "running")
      store.recordPreparedInput(user.id, user.message)
      const source = { taskId: user.id, callId: "continue", key: "continue-ineligible" }
      const version = store.getWork(bot.id, work.id).version
      const resume = () => store.changeWork(bot.id, work.id, version, source.callId, "continue", source)
      if (prerequisite === "wrong-source") expect(resume).toThrow("工作不属于当前 Bot")
      else expect(resume().resultReviewState).toBeUndefined()
      store.settle(user.id, "completed", null)
      store.flushReplies()
      expect(notices(store).filter(item => item.origin.kind === "work_result" && item.origin.review?.phase === "review"))
        .toEqual([])
      expect(store.getTask(task.id).state).toBe(state)
    }
  )

  it("keeps unprepared or stopped Continue on the original lifecycle path without reviving verification", () => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.settle(f.task.id, "completed", null, "Original output")
    f.store.settle(privateReview(f.store).id, "interrupted", null)
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "unprepared-continue", message: "Continue" })
    f.store.transition(user.id, "running")
    let current = f.store.getWork(f.bot.id, f.work.id)
    expect(f.store.changeWork(f.bot.id, f.work.id, current.version, "unprepared", "continue",
      { taskId: user.id, callId: "unprepared", key: "unprepared" }).resultReviewState).toBe("interrupted")
    f.store.recordPreparedInput(user.id, user.message)
    current = f.store.stopWorkDispatch(f.bot.id, f.work.id)
    const continued = f.store.changeWork(f.bot.id, f.work.id, current.version, "stopped", "continue",
      { taskId: user.id, callId: "stopped", key: "stopped" })
    expect(continued.state).toBe("active")
    expect(continued.dispatchStopped).toBeUndefined()
    expect(continued.resultReviewState).toBeUndefined()
  })

  it("preserves the earlier formal snapshot when a later repair is rejected by its input hook", () => {
    const f = fixture()
    beginVerifiedWork(f)
    const file = { filePath: "/project/report.xlsx", attachmentPath: "/retained/version-1/report.xlsx",
      name: "report.xlsx", size: 200 }
    f.store.recordWorkResultEvidence(f.task.id, {
      callId: "formal-report", assistantMessageId: "report-message", files: [file]
    })
    f.store.settle(f.task.id, "completed", null, "Draft retained; validation still needed.")
    const review = privateReview(f.store)
    const repair = f.store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Missing agreed validation", instruction: "Run the agreed validation", evidenceIds: []
    })
    expect(repair.state).toBe("repair")
    if (repair.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(review.id, "completed", null)
    f.store.transition(repair.task.id, "running")
    f.store.beginInputPreparation(repair.task.id)
    f.store.settle(repair.task.id, "failed", "PRIVATE_HOOK_DIAGNOSTIC", undefined, undefined, false,
      { outcome: "error", code: "prompt_blocked" })
    f.store.flushReplies()
    const publicationTask = notices(f.store).find(task =>
      task.origin.kind === "work_result" && task.origin.review?.phase === "publish")!
    f.store.transition(publicationTask.id, "running")
    const publication = f.store.getWorkResultPublication(publicationTask.id)!
    expect(publication.kind).toBe("blocked")
    expect(publication.attachments).toHaveLength(1)
    expect(publication.attachments[0]).toMatchObject({ sourceTaskId: f.task.id, file })
    expect(JSON.stringify(publication)).not.toContain("PRIVATE_HOOK_DIAGNOSTIC")
    expect(f.store.acknowledgeWorkResultPublication(publicationTask.id)).toBe(true)
    f.store.settle(publicationTask.id, "completed", null)
    f.store.flushReplies()
    expect(notices(f.store).filter(task => task.state === "queued")).toHaveLength(0)
  })

  it.each([
    { input: "original", callbacks: [] },
    { input: "repair", callbacks: [] },
    { input: "new-input", callbacks: [] },
    { input: "repair", callbacks: ["visible"] },
    { input: "new-input", callbacks: ["visible"] },
    { input: "original", callbacks: ["visible", "visible"] },
    { input: "original", callbacks: ["visible", "failed"] },
    { input: "repair", callbacks: ["visible", "visible"] },
    { input: "repair", callbacks: ["visible", "silent"] },
  ])("anchors carried answers to the actual $input and callbacks $callbacks", ({ input, callbacks }) => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.recordWorkResultEvidence(f.task.id, { finalMessageId: "first-final" })
    let launcher = f.task
    if (input !== "original") {
      f.store.settle(f.task.id, "completed", null, "First result")
      if (input === "repair") {
        const review = privateReview(f.store)
        const repair = f.store.commitWorkResultReview(review.id, {
          kind: "repair", gap: "Missing check", instruction: "Finish the agreed check", evidenceIds: []
        })
        if (repair.state !== "repair") throw new Error("Expected a repair")
        f.store.settle(review.id, "completed", null)
        launcher = repair.task
      } else launcher = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
        requestId: "new-approved-request", message: "Use the new format" })
      f.store.transition(launcher.id, "running")
      f.store.recordPreparedInput(launcher.id, launcher.message)
      if (input === "new-input") expect(f.store.armWorkResultReview(launcher.id, "incarnation")).toBe(true)
      f.store.recordWorkResultEvidence(launcher.id, { finalMessageId: "next-final" })
    }
    const supplement = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
      requestId: "injected-supplement", message: "Keep the selected format" })
    f.store.recordPreparedInput(supplement.id, supplement.message)
    expect(f.store.injectIntoRun(supplement.id, launcher.id)).toBe(true)
    f.store.acceptCommand(launcher.id, { id: "answer-check", threadId: f.work.threadId,
      command: "check", cwd: "/tmp", startedAt: 1 })
    f.store.settleRun(launcher.id, [supplement.id], "completed", null, "Check started")
    f.store.settleCommand({ id: "answer-check", threadId: f.work.threadId, exitCode: 0,
      output: "Passed", cancelled: false, truncated: false })
    const visibleCallbacks: Array<{ taskId: string; requestId: string; finalMessageId: string; supplementRequestIds: string[] }> = []
    let commandId = "answer-check"
    let commandSourceId = launcher.id
    const callbackFor = (key: string) => {
      const callback = f.store.recentTasks().find(item =>
        item.origin.kind === "notification" && item.origin.key === key)!
      expect(callback.origin).toMatchObject({
        // Command profile continuations keep the original user as the
        // command owner. Repairs keep the actual callback launcher.
        sourceTaskId: input === "repair" ? commandSourceId : launcher.id,
        commandReviewSource: { requestTaskId: f.task.id, executionTaskId: launcher.id }
      })
      return callback
    }
    for (const [index, ending] of callbacks.entries()) {
      const callback = callbackFor(commandId)
      const finalMessageId = `callback-final-${index}`
      f.store.transition(callback.id, "running")
      if (ending !== "silent") {
        f.store.recordWorkResultEvidence(callback.id, { finalMessageId })
        visibleCallbacks.push({ taskId: callback.id, requestId: callback.requestId,
          finalMessageId, supplementRequestIds: [] })
      }
      commandId = `answer-check-${index}`
      commandSourceId = callback.id
      f.store.acceptCommand(callback.id, { id: commandId, threadId: f.work.threadId,
        command: "check-again", cwd: "/tmp", startedAt: index + 2 })
      f.store.settle(callback.id, ending === "failed" ? "failed" : "completed",
        ending === "failed" ? "Failed after recording the result" : null,
        ending === "silent" ? BOT_ROUTINE_SILENT : "Check started")
      f.store.settleCommand({ id: commandId, threadId: f.work.threadId, exitCode: 0,
        output: "Passed", cancelled: false, truncated: false })
    }
    const terminal = callbackFor(commandId)
    settle(f.store, terminal, "completed", BOT_ROUTINE_SILENT)
    const context = f.store.getWorkResultReview(privateReview(f.store).id)!
    expect(context.previousProcesses).toEqual([
      ...(input === "repair" ? [{ taskId: f.task.id, requestId: f.task.requestId,
        finalMessageId: "first-final", supplementRequestIds: [] }] : []),
      { taskId: launcher.id, requestId: launcher.requestId,
        finalMessageId: input === "original" ? "first-final" : "next-final",
        supplementRequestIds: [supplement.requestId] },
      ...visibleCallbacks.slice(input === "repair" ? -1 : -2)
    ])
    expect(context.executionTaskId).toBe(terminal.id)
    expect(context.executionSupplementRequestIds).toEqual([])
  })

  it.each([false, true])("retains same-work peer return answers until newer accepted input (corrected=%s)", (corrected) => {
    const f = fixture()
    const { store, work } = f
    const peer = store.create({ name: "Reviewer", instructions: "", color: "#123456", modelRef: null })
    beginVerifiedWork(f)
    store.recordWorkResultEvidence(f.task.id, { finalMessageId: "input-final" })
    const delegated = store.delegate(f.task.id, peer.id, "Review the input", "review-input")
    store.settle(f.task.id, "completed", null, "Waiting for review")
    settle(store, delegated, "completed", "Two export scopes are available")
    store.flushReplies()
    const integration = store.recentTasks().find(task => task.workId === work.id && task.origin.kind === "bot")!
    store.transition(integration.id, "running")
    store.transition(integration.id, "waiting_user")
    store.transition(integration.id, "running")
    store.recordWorkResultEvidence(integration.id, { finalMessageId: "integration-final" })
    store.acceptCommand(integration.id, { id: "peer-check", threadId: work.threadId,
      command: "check", cwd: "/tmp", startedAt: 1 })
    store.settle(integration.id, "completed", null, "Validation is running")
    store.settleCommand({ id: "peer-check", threadId: work.threadId, exitCode: 0,
      output: "Passed", cancelled: false, truncated: false })
    const callback = store.recentTasks().find(task =>
      task.origin.kind === "notification" && task.origin.key === "peer-check")!
    store.transition(callback.id, "running")
    store.recordWorkResultEvidence(callback.id, { finalMessageId: "check-final" })
    store.settle(callback.id, "completed", null, "Validation passed")
    if (corrected) {
      const input = store.enqueue({ botId: f.bot.id, workId: work.id,
        requestId: "revised-export", message: "Use the revised scope instead" })
      store.transition(input.id, "running")
      store.recordPreparedInput(input.id, input.message)
      expect(store.armWorkResultReview(input.id, "incarnation")).toBe(true)
      store.recordWorkResultEvidence(input.id, { finalMessageId: "revised-final" })
      store.settle(input.id, "completed", null, "Revised result")
    }
    const context = store.getWorkResultReview(privateReview(store).id)!
    expect(context.previousProcesses.map(page => page.taskId)).toEqual(corrected ? [] : [f.task.id, integration.id])
    const page = context.previousProcesses.find(page => page.taskId === integration.id)
    if (page) {
      const messages: Message[] = [
        { id: integration.requestId, role: "user", content: "Peer review received", created_at: new Date(1) },
        { id: "question", role: "assistant", content: "", created_at: new Date(2), tool_calls: [{
          id: "scope", name: "request_user_input", args: { questions: [{ id: "scope", question: "Which scope?",
            options: [{ label: "Posted only", description: "Exclude pending invoices" }] }] }
        }] },
        { id: "answer", role: "tool", name: "request_user_input", tool_call_id: "scope", created_at: new Date(3),
          content: JSON.stringify({ status: "submitted", requestId: "peer-scope-request", answers: { scope: {
            type: "option", questionId: "scope", optionIndex: 0, label: "Posted only", description: "Exclude pending invoices"
          } } }) },
        { id: "integration-final", role: "assistant", content: "Validation is running", created_at: new Date(4) }
      ]
      const process = projectWorkResultProcess({ messages, hasMore: false, total: messages.length,
        beforeOrdinal: null, beforeMessageId: null, truncatedMessageIds: [] },
        { ...page, earlierExecutions: true }, true)
      expect(process.steps[0]?.tools?.[0]?.interaction?.answers).toEqual([
        { question: "Which scope?", answer: "Posted only · Exclude pending invoices" }
      ])
    }
  })

  it.each([false, true])("retains submitted-choice pages across both permitted repairs (callback=%s)", (withCallback) => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.recordWorkResultEvidence(f.task.id, { finalMessageId: "input-final" })
    f.store.settle(f.task.id, "completed", null, "Initial output")
    const repairs: BotTask[] = []
    for (let index = 0; index < 2; index++) {
      const review = privateReview(f.store)
      const result = f.store.commitWorkResultReview(review.id, {
        kind: "repair", gap: `Missing check ${index}`, instruction: "Complete the agreed check", evidenceIds: []
      })
      if (result.state !== "repair") throw new Error("Expected a repair")
      f.store.settle(review.id, "completed", null)
      const task = result.task
      repairs.push(task)
      f.store.transition(task.id, "running")
      f.store.recordPreparedInput(task.id, task.message)
      f.store.recordWorkResultEvidence(task.id, { finalMessageId: `repair-${index}-final` })
      if (index === 1 && withCallback) f.store.acceptCommand(task.id, {
        id: "repair-check", threadId: f.work.threadId, command: "check", cwd: "/tmp", startedAt: 1
      })
      f.store.settle(task.id, "completed", null, "Check recorded")
    }
    if (withCallback) {
      f.store.settleCommand({ id: "repair-check", threadId: f.work.threadId, exitCode: 0,
        output: "Passed", cancelled: false, truncated: false })
      const callback = f.store.recentTasks().find(task =>
        task.origin.kind === "notification" && task.origin.key === "repair-check")!
      settle(f.store, callback, "completed", "Final check complete")
    }
    const context = f.store.getWorkResultReview(privateReview(f.store).id)!
    expect(context.remainingRepairs).toBe(0)
    expect(context.previousProcesses.map(page => page.finalMessageId)).toEqual([
      "input-final", "repair-0-final", ...(withCallback ? ["repair-1-final"] : [])
    ])
    expect(context.previousProcesses.map(page => page.taskId)).toEqual([
      f.task.id, repairs[0].id, ...(withCallback ? [repairs[1].id] : [])
    ])
  })

  it.each([
    { afterRepairCallback: false, corrected: false },
    { afterRepairCallback: true, corrected: false },
    { afterRepairCallback: true, corrected: true }
  ])("bounds pre-repair command answers after repair (callback=$afterRepairCallback, corrected=$corrected)", ({
    afterRepairCallback, corrected
  }) => {
    const f = fixture()
    beginVerifiedWork(f)
    f.store.recordWorkResultEvidence(f.task.id, { finalMessageId: "input-final" })
    const callback = (source: BotTask, id: string, consumed: string[] = []) => {
      f.store.acceptCommand(source.id, { id, threadId: f.work.threadId, command: "check", cwd: "/tmp", startedAt: 1 })
      f.store.settleRun(source.id, consumed, "completed", null, "Check started")
      f.store.settleCommand({ id, threadId: f.work.threadId, exitCode: 0,
        output: "Passed", cancelled: false, truncated: false })
      const notification = f.store.recentTasks().find(task =>
        task.origin.kind === "notification" && task.origin.key === id)!
      f.store.transition(notification.id, "running")
      f.store.recordWorkResultEvidence(notification.id, { finalMessageId: `${id}-final` })
      f.store.settle(notification.id, "completed", null, "Result recorded")
      return notification
    }
    const answered = callback(f.task, "before-repair")
    const firstReview = privateReview(f.store)
    const repaired = f.store.commitWorkResultReview(firstReview.id, {
      kind: "repair", gap: "Missing check", instruction: "Finish the agreed check", evidenceIds: []
    })
    if (repaired.state !== "repair") throw new Error("Expected a repair")
    f.store.settle(firstReview.id, "completed", null)
    f.store.transition(repaired.task.id, "running")
    f.store.recordPreparedInput(repaired.task.id, repaired.task.message)
    const consumed: string[] = []
    if (corrected) {
      const newer = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
        requestId: "new-correction", message: "Use the revised format" })
      f.store.recordPreparedInput(newer.id, newer.message)
      expect(f.store.injectIntoRun(newer.id, repaired.task.id)).toBe(true)
      consumed.push(newer.id)
    }
    f.store.recordWorkResultEvidence(repaired.task.id, { finalMessageId: "repair-final" })
    if (afterRepairCallback) callback(repaired.task, "after-repair", consumed)
    else f.store.settleRun(repaired.task.id, consumed, "completed", null, "Finished the check")
    const context = f.store.getWorkResultReview(privateReview(f.store).id)!
    expect(context.previousProcesses.map(item => item.taskId)).toEqual([
      f.task.id, ...(corrected ? [] : [answered.id]), ...(afterRepairCallback ? [repaired.task.id] : [])
    ])
  })

  it.each(["silent", "visible", "stopped"] as const)(
    "settles a finite background command and preserves the visible result source (%s)", (ending) => {
      const f = fixture()
      beginVerifiedWork(f)
      f.store.recordWorkResultEvidence(f.task.id, { finalMessageId: "original-result" })
      f.store.acceptCommand(f.task.id, { id: "command", threadId: f.work.threadId, command: "check", cwd: "/tmp", startedAt: 1 })
      f.store.settle(f.task.id, "completed", null, "The actual work result")
      f.store.flushReplies()
      expect(notices(f.store)).toHaveLength(0)
      f.store.settleCommand({ id: "command", threadId: f.work.threadId, exitCode: 0,
        output: "check passed", cancelled: false, truncated: false })
      const notification = f.store.recentTasks().find(task => task.origin.kind === "notification")!
      expect(notification.origin).toMatchObject({ key: "command" })
      const result = ending === "visible" ? "The check found a new result." : BOT_ROUTINE_SILENT
      f.store.transition(notification.id, "running")
      f.store.recordWorkResultEvidence(notification.id, { finalMessageId: "command-result" })
      f.store.settle(notification.id, "completed", null, result)
      const review = privateReview(f.store)
      expect(f.store.getWorkResultReview(review.id)).toMatchObject({
        executionTaskId: notification.id,
        outcome: { text: ending === "visible" ? result : "The actual work result" },
        remainingRepairs: 2,
        commands: [{ id: "command", sourceTaskId: f.task.id, result: { output: "check passed", exitCode: 0 } }]
      })
      const decision = f.store.commitWorkResultReview(review.id, ready)
      expect(decision).toMatchObject({
        state: "publish",
        publication: {
          requestTaskId: f.task.id,
          executionTaskId: notification.id,
          finalMessageId: ending === "visible" ? "command-result" : "original-result"
        }
      })
      expect(f.store.commitWorkResultReview(review.id, ready)).toEqual(decision)
      f.store.settle(review.id, "completed", null)
      f.store.flushReplies()
      const publication = notices(f.store).find(item => item.state === "queued")!
      if (ending === "stopped") {
        f.store.stopWorkDispatch(f.bot.id, f.work.id)
        expect(f.store.getTask(publication.id).state).toBe("cancelled")
        expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
      } else {
        f.store.transition(publication.id, "running")
        expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
        expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
      }
    }
  )

  it("waits for the peer outbox and integrated work receipt without treating the peer as the human request", () => {
    const f = fixture()
    beginVerifiedWork(f)
    const peer = f.store.create({ name: "Peer", instructions: "", color: "#123456", modelRef: null })
    const assignment = f.store.delegate(f.task.id, peer.id, "Review the result", "peer-review")
    f.store.settle(f.task.id, "completed", null, "First result")
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(0)
    settle(f.store, assignment, "completed", "Peer evidence is not a new request")
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(0)
    const integration = f.store.recentTasks().find(task => task.workId === f.work.id && task.origin.kind === "bot")!
    settle(f.store, integration, "completed", "Integrated evidence")
    const review = privateReview(f.store)
    expect(f.store.getWorkResultReview(review.id)).toMatchObject({
      executionTaskId: integration.id, requests: [{ id: f.task.id, text: "Approved execution scope" }]
    })
  })

  it.each([false, true])("keeps old peer history but uses the current result (delegated after amendment: %s)", current => {
    const f = fixture()
    const { store, task, work, bot } = f
    beginVerifiedWork(f)
    const peer = store.create({ name: "Peer", instructions: "", color: "#123456", modelRef: null })
    const input = store.enqueue({ botId: bot.id, workId: work.id, requestId: "corrected", message: "Use the new report" })
    store.recordPreparedInput(input.id, input.message)
    if (current) expect(store.injectIntoRun(input.id, task.id)).toBe(true)
    const assignment = store.delegate(task.id, peer.id, "Review the report", "peer-review")
    if (!current) expect(store.injectIntoRun(input.id, task.id)).toBe(true)
    store.recordWorkResultEvidence(task.id, { finalMessageId: "new-result" })
    store.settleRun(task.id, [input.id], "completed", null, "New result")
    store.flushReplies()
    expect(notices(store)).toHaveLength(0)
    settle(store, assignment, "completed", "Peer evidence")
    store.flushReplies()
    const callback = store.recentTasks().find(item => item.requestId === `reply-${assignment.id}`)!
    store.transition(callback.id, "running")
    store.recordWorkResultEvidence(callback.id, { finalMessageId: "peer-result" })
    store.settle(callback.id, "completed", null, "Integrated peer result")
    expect(store.getTask(callback.id).state).toBe("completed")
    const review = privateReview(store)
    expect(store.getWorkResultReview(review.id)).toMatchObject({
      executionTaskId: current ? callback.id : task.id,
      outcome: current ? { finalMessageId: "peer-result", text: "Integrated peer result" }
        : { finalMessageId: "new-result", text: "New result" }
    })
    expect(notices(store)).toHaveLength(1)
  })

  function serviceResult(verified = false, amendment?: string, beforeSettle?: (f: ReturnType<typeof fixture>) => void) {
    const f = fixture()
    beginVerifiedWork(f)
    const { store, task, work, bot } = f
    store.acceptCommand(task.id, { id: "preview", threadId: work.threadId, command: "serve", cwd: "/tmp",
      startedAt: 1, notifyOnComplete: false })
    if (verified) {
      store.acceptCommand(task.id, { id: "preview-check", threadId: work.threadId, command: "check", cwd: "/tmp",
        startedAt: 2, notifyOnComplete: false })
      store.settleCommand({ id: "preview-check", threadId: work.threadId, exitCode: 0, output: "ready", cancelled: false, truncated: false })
      store.retainReadyWorkService(task.id, "preview", "preview-check", "Keep the requested preview running")
    }
    const input = amendment ? store.enqueue({ botId: bot.id, workId: work.id, requestId: "amendment", message: amendment }) : undefined
    if (input) {
      store.recordPreparedInput(input.id, input.message)
      expect(store.injectIntoRun(input.id, task.id)).toBe(true)
    }
    const file = { name: "report.txt", filePath: "/work/report.txt", attachmentPath: "/saved/report.txt", size: 5 }
    store.recordWorkResultEvidence(task.id, { callId: "report", files: [file] })
    beforeSettle?.(f)
    store.settleRun(task.id, input ? [input.id] : [], "completed", null, "Requested result")
    return { ...f, file, review: privateReview(store) }
  }

  const exitPreview = (f: ReturnType<typeof serviceResult>) => f.store.settleCommand({
    id: "preview", threadId: f.work.threadId, exitCode: 0, output: "stopped", cancelled: false, truncated: false
  })

  function acknowledgeServiceResult(f: ReturnType<typeof serviceResult>) {
    f.store.settle(f.review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    f.store.settle(publication.id, "completed", null)
  }

  const serviceProjections = (f: ReturnType<typeof serviceResult>) => [
    f.store.getWork(f.bot.id, f.work.id), f.store.listWorks(f.bot.id).items[0],
    f.store.workSummaries(f.bot.id, [f.work.id])[0], new BotStore(f.db).getWork(f.bot.id, f.work.id)
  ]

  it("selects no old service for an amended offline result", () => {
    const f = serviceResult(false, "Only deliver the offline report; the preview is no longer required")
    expect(f.store.getWorkResultReview(f.review.id)?.services).toMatchObject({ items: [{ id: "preview", state: "accepted" }], truncated: false })
    expect(f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: [] })).toMatchObject({
      state: "publish", publication: { kind: "ready", attachments: [{ file: f.file }], serviceIds: [] }
    })
    expect(f.store.getWork(f.bot.id, f.work.id).backgroundBusy).toBe(true)
    expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toBeUndefined()
    acknowledgeServiceResult(f)
    for (const projected of serviceProjections(f)) {
      expect(projected).toMatchObject({ backgroundBusy: true, executionState: "completed",
        resultConclusion: { kind: "ready", backgroundServicesOnly: true } })
      expect(projected.readyServiceState).toBeUndefined()
      expect(resolveBotWorkStatus(projected)).toMatchObject({ label: "成果已就绪", summary: ready.summary })
    }
  })

  it("shows the delivered result when only its selected service is verified and another silent service remains", () => {
    const f = serviceResult(true, undefined, ({ store, task, work }) => {
      store.acceptCommand(task.id, { id: "unused-preview", threadId: work.threadId, command: "old-serve", cwd: "/tmp",
        startedAt: 3, notifyOnComplete: false })
    })
    f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: ["preview"] })
    acknowledgeServiceResult(f)
    for (const projected of serviceProjections(f)) {
      expect(projected.backgroundBusy).toBe(true)
      expect(projected.readyServiceState).toBeUndefined()
      expect(projected.resultConclusion?.backgroundServicesOnly).toBe(true)
      expect(resolveBotWorkStatus(projected).label).toBe("成果已就绪")
    }
  })

  it.each(["finite command", "pending notification", "pending reply", "new input"])(
    "keeps a %s ahead of a delivered result with unused silent services", pending => {
      const f = serviceResult(false, "Only deliver the offline report")
      f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: [] })
      acknowledgeServiceResult(f)
      if (pending === "new input") {
        f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "new-input", message: "Revise the report" })
      } else if (pending === "pending reply") {
        f.db.run("INSERT INTO bot_reply_outbox(task_id,target_bot_id,message,origin_json) VALUES (?,?,?,?)",
          ["pending-reply", f.bot.id, "Peer result", JSON.stringify({ rootWorkId: f.work.id, returnWorkId: f.work.id })])
      } else {
        // A separate finite command or its owed notification must not acquire
        // the display exemption merely because an unrelated service remains.
        f.db.run(`INSERT INTO bot_commands(id,bot_id,thread_id,source_task_id,command,cwd,started_at,state,
          updated_at,notify_on_complete,pending_notification,suppressed)
          SELECT 'finite-result',bot_id,thread_id,source_task_id,'build',cwd,started_at,?,updated_at,1,?,0
          FROM bot_commands WHERE id='preview'`,
          [pending === "finite command" ? "accepted" : "completed", pending === "pending notification" ? "Result owed" : null])
      }
      for (const projected of serviceProjections(f)) {
        expect(projected.backgroundBusy).toBe(true)
        expect(projected.resultConclusion?.backgroundServicesOnly).toBeUndefined()
        expect(resolveBotWorkStatus(projected).label).toBe(pending === "new input" ? "等待执行" : "后台处理中")
      }
    }
  )

  it("blocks an amended result that still selects the unverified old service", () => {
    const f = serviceResult(false, "Keep the same preview server running")
    expect(f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: ["preview"] })).toMatchObject({
      state: "publish", publication: { kind: "blocked", summary: expect.stringContaining("服务"), attachments: [{ file: f.file }] }
    })
  })

  const inspectedCheckId = "e".repeat(64)
  const httpCheck = { callId: "http-check", command: "node", startedAt: 2, exitCode: 0,
    output: "ROOT 200 healthy=true; HEALTH 200 healthy=true; REPORT 200 sha256 equal=true", excerpt: false }
  const inspectedForeground = (f: ReturnType<typeof serviceResult>) => ({
    evidenceId: inspectedCheckId, kind: "foreground" as const, sourceTaskId: f.task.id, callId: httpCheck.callId
  })

  it("keeps earlier service checks reachable after the normal delivery checks", () => {
    const f = serviceResult(false, undefined, ({ store, task, work }) => {
      for (const id of ["api", "worker", "admin"])
        store.acceptCommand(task.id, { id, threadId: work.threadId, command: `serve-${id}`, cwd: "/tmp",
          startedAt: 1, notifyOnComplete: false })
      for (const [index, id] of ["preview", "api", "worker", "admin", "part-1", "part-2", "part-3", "part-4", "part-5"].entries()) {
        store.acceptCommand(task.id, { id: `check-${id}`, threadId: work.threadId, command: `node check-${id}.mjs`,
          cwd: "/tmp", startedAt: index + 2, notifyOnComplete: false })
        store.settleCommand({ id: `check-${id}`, threadId: work.threadId, exitCode: 0, output: `${id} checked`,
          cancelled: false, truncated: false })
      }
    })
    expect(f.store.getWorkResultReview(f.review.id)?.commands.map(item => item.id)).toContain("check-preview")
  })

  it("adopts only the cited check assigned to each still-running service", () => {
    const apiCheckId = "a".repeat(64)
    const f = serviceResult(false, undefined, ({ store, task, work }) => {
      store.acceptCommand(task.id, { id: "api", threadId: work.threadId, command: "serve-api", cwd: "/tmp",
        startedAt: 1, notifyOnComplete: false })
      store.recordWorkResultEvidence(task.id, { foregroundCommand: httpCheck })
      store.recordWorkResultEvidence(task.id, { foregroundCommand: { ...httpCheck, callId: "api-check", output: "API /health 200" } })
    })
    const receipt = f.store.commitWorkResultReview(f.review.id, {
      ...ready, serviceIds: ["preview", "api"], evidenceIds: [inspectedCheckId, apiCheckId],
      serviceChecks: { preview: inspectedCheckId, api: apiCheckId }
    }, [], [inspectedForeground(f), { ...inspectedForeground(f), evidenceId: apiCheckId, callId: "api-check" }])
    expect(receipt).toMatchObject({ state: "publish", publication: { kind: "ready" } })
    const records = f.db.exec("SELECT id, service_ready_json FROM bot_commands ORDER BY id")[0].values
    expect(records.map(([id, evidence]) => [id, JSON.parse(String(evidence)).checkId])).toEqual([
      ["api", `foreground-command:${f.task.id}:api-check`],
      ["preview", `foreground-command:${f.task.id}:${httpCheck.callId}`]
    ])
  })

  it.each(["foreground", "background"] as const)("adopts the selected service's inspected successful %s check without another execute", kind => {
    const f = serviceResult(false, undefined, ({ store, task, work }) => {
      if (kind === "foreground") store.recordWorkResultEvidence(task.id, { foregroundCommand: httpCheck })
      else {
        store.acceptCommand(task.id, { id: "http-check", threadId: work.threadId, command: "node check.mjs", cwd: "/tmp",
          startedAt: 2, notifyOnComplete: false })
        store.settleCommand({ id: "http-check", threadId: work.threadId, exitCode: 0, output: httpCheck.output,
          cancelled: false, truncated: false })
      }
    })
    const check = kind === "foreground" ? inspectedForeground(f) : {
      evidenceId: inspectedCheckId, kind: "background" as const, sourceTaskId: f.task.id, commandId: "http-check"
    }
    const decision = { ...ready, serviceIds: ["preview"], evidenceIds: [inspectedCheckId],
      serviceChecks: { preview: inspectedCheckId } }
    const receipt = f.store.commitWorkResultReview(f.review.id, decision, [], [check])
    expect(receipt).toMatchObject({ state: "publish", publication: { kind: "ready", attachments: [{ file: f.file }] } })
    expect(f.store.commitWorkResultReview(f.review.id, decision, [], [check])).toEqual(receipt)
    const saved = JSON.parse(String(f.db.exec("SELECT service_ready_json FROM bot_commands WHERE id='preview'")[0].values[0][0]))
    expect(saved).toMatchObject({ result: { exitCode: 0, output: httpCheck.output }, checkedAt: expect.any(Number) })
    f.store.settle(f.review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    const prepared = f.store.getWorkResultPublication(publication.id)
    exitPreview(f)
    expect(new BotStore(f.db).getWorkResultPublication(publication.id)).toEqual(prepared)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
  })

  it.each(["foreground", "background", "exact"] as const)(
    "only uses a quiet %s command when the inspection can identify the check", kind => {
      const f = serviceResult(false, undefined, ({ store, task, work }) => {
        if (kind === "background") {
          store.acceptCommand(task.id, { id: "quiet-check", threadId: work.threadId, command: "curl --silent --fail -o /dev/null http://127.0.0.1:8000/health",
            cwd: "/tmp", startedAt: 2, notifyOnComplete: false })
          store.settleCommand({ id: "quiet-check", threadId: work.threadId, exitCode: 0, output: "<no output>",
            cancelled: false, truncated: false })
        } else store.recordWorkResultEvidence(task.id, { foregroundCommand: { ...httpCheck,
          command: kind === "exact" ? "node checks/preview.mjs" : "curl", output: "<no output>",
          ...(kind === "exact" ? { exactCommand: true as const } : {}) } })
      })
      const check = kind === "background" ? {
        evidenceId: inspectedCheckId, kind: "background" as const, sourceTaskId: f.task.id, commandId: "quiet-check"
      } : inspectedForeground(f)
      const receipt = f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: ["preview"], evidenceIds: [inspectedCheckId],
        serviceChecks: { preview: inspectedCheckId }
      }, [], [check])
      expect(receipt).toMatchObject({ state: "publish", publication: {
        kind: kind === "exact" ? "ready" : "blocked", attachments: [{ file: f.file }]
      } })
    }
  )

  it.each(["unbound", "unread", "uncited", "unknown", "old", "legacy", "failed", "truncated", "foreign", "exited"] as const)(
    "does not turn a %s command into service readiness", scenario => {
      let foreignTaskId: string | undefined
      const f = serviceResult(false, undefined, ({ store, task }) => {
        store.recordWorkResultEvidence(task.id, { foregroundCommand: { ...httpCheck,
          ...(scenario === "old" ? { startedAt: 0 } : {}),
          ...(scenario === "legacy" ? { startedAt: undefined } : {}),
          ...(scenario === "failed" ? { exitCode: 1 } : {}),
          ...(scenario === "truncated" ? { excerpt: true } : {}) } })
        if (scenario === "foreign") {
          const other = store.createWork({ botId: task.botId, operationId: "other-service-work", title: "Other", goal: "Other check" })
          store.transition(other.task.id, "running")
          store.recordPreparedInput(other.task.id, other.task.message)
          expect(store.armWorkResultReview(other.task.id, "other-incarnation")).toBe(true)
          store.recordWorkResultEvidence(other.task.id, { foregroundCommand: httpCheck })
          foreignTaskId = other.task.id
        }
      })
      if (scenario === "exited") exitPreview(f)
      const reference = { ...inspectedForeground(f),
        ...(scenario === "unknown" ? { callId: "not-a-recorded-command" } : {}),
        ...(foreignTaskId ? { sourceTaskId: foreignTaskId } : {}) }
      const decision = { ...ready, serviceIds: ["preview"],
        evidenceIds: scenario === "uncited" ? [] : [inspectedCheckId],
        ...(scenario === "unbound" ? {} : { serviceChecks: { preview: inspectedCheckId } })
      }
      const inspected = scenario === "unread" ? [] : [reference]
      const receipt = f.store.commitWorkResultReview(f.review.id, decision, [], inspected)
      expect(receipt).toMatchObject({ state: "publish", publication: { kind: "blocked", attachments: [{ file: f.file }] } })
      expect(f.db.exec("SELECT service_ready_json FROM bot_commands WHERE id='preview'")[0].values[0][0]).toBeNull()
    }
  )

  it("retains the live service's verified readiness independently when another service exits", () => {
    const f = serviceResult(false, undefined, ({ store, task, work }) => {
      store.acceptCommand(task.id, { id: "exited-preview", threadId: work.threadId, command: "serve second", cwd: "/tmp",
        startedAt: 1, notifyOnComplete: false })
      store.recordWorkResultEvidence(task.id, { foregroundCommand: httpCheck })
    })
    f.store.settleCommand({ id: "exited-preview", threadId: f.work.threadId, exitCode: 0, output: "closed",
      cancelled: false, truncated: false })
    const decision = { ...ready, serviceIds: ["exited-preview", "preview"], evidenceIds: [inspectedCheckId],
      serviceChecks: { preview: inspectedCheckId } }
    const proof = [inspectedForeground(f)]
    expect(f.store.commitWorkResultReview(f.review.id, decision, [], proof)).toMatchObject({
      state: "publish", publication: { kind: "blocked", attachments: [{ file: f.file }] }
    })
    expect(f.db.exec("SELECT id,service_ready_json IS NOT NULL FROM bot_commands ORDER BY id")[0].values)
      .toEqual([["exited-preview", 0], ["preview", 1]])
  })

  it("does not adopt a cancelled command or accept a late readiness result after full Stop", () => {
    const f = serviceResult(false, undefined, ({ store, task, work }) => {
      store.acceptCommand(task.id, { id: "cancelled-check", threadId: work.threadId, command: "node check.mjs", cwd: "/tmp", startedAt: 2 })
      store.settleCommand({ id: "cancelled-check", threadId: work.threadId, exitCode: 0, output: httpCheck.output,
        cancelled: true, truncated: false })
    })
    const decision = { ...ready, serviceIds: ["preview"], evidenceIds: [inspectedCheckId],
      serviceChecks: { preview: inspectedCheckId } }
    expect(f.store.commitWorkResultReview(f.review.id, decision, [], [{ evidenceId: inspectedCheckId,
      kind: "background", sourceTaskId: f.task.id, commandId: "cancelled-check" }])).toMatchObject({
      state: "publish", publication: { kind: "blocked" }
    })
    const stopped = serviceResult(false, undefined, ({ store, task }) => store.recordWorkResultEvidence(task.id, { foregroundCommand: httpCheck }))
    stopped.store.stopWorkDispatch(stopped.bot.id, stopped.work.id)
    expect(() => stopped.store.commitWorkResultReview(stopped.review.id, decision, [], [inspectedForeground(stopped)])).toThrow()
    expect(stopped.db.exec("SELECT service_ready_json FROM bot_commands WHERE id='preview'")[0].values[0][0]).toBeNull()
  })

  it("keeps a bounded service catalogue without blocking an explicit offline selection on overflow", () => {
    const f = fixture()
    beginVerifiedWork(f)
    for (let index = 0; index < 17; index++) {
      const id = `silent-${index}`
      f.store.acceptCommand(f.task.id, { id, threadId: f.work.threadId, command: "inspect", cwd: "/tmp",
        startedAt: index, notifyOnComplete: false })
      f.store.settleCommand({ id, threadId: f.work.threadId, exitCode: 0, output: "done", cancelled: false, truncated: false })
    }
    f.store.settle(f.task.id, "completed", null, "Offline report")
    const review = privateReview(f.store)
    expect(f.store.getWorkResultReview(review.id)?.services).toMatchObject({ truncated: true })
    expect(f.store.getWorkResultReview(review.id)?.services.items).toHaveLength(16)
    expect(f.store.commitWorkResultReview(review.id, { ...ready, serviceIds: [] })).toMatchObject({
      state: "publish", publication: { kind: "ready", serviceIds: [] }
    })
  })

  it.each([false, true])("checks the same work's service from a previously settled request (exited=%s)", exited => {
    const f = serviceResult(true)
    f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: ["preview"] })
    f.store.settle(f.review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    f.store.settle(publication.id, "completed", null)
    if (exited) exitPreview(f)
    const next = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "new-preview-request",
      message: "Revise the same preview and keep its existing server running" })
    f.store.transition(next.id, "running")
    f.store.recordPreparedInput(next.id, next.message)
    expect(f.store.armWorkResultReview(next.id, "incarnation", true)).toBe(true)
    f.store.settle(next.id, "completed", null, "Revised preview")
    const review = privateReview(f.store)
    expect(f.store.getWorkResultReview(review.id)?.services.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "preview", state: exited ? "completed" : "accepted", ready: !exited })
    ]))
    expect(f.store.commitWorkResultReview(review.id, { ...ready, serviceIds: ["preview"] })).toMatchObject({
      state: "publish", publication: { kind: exited ? "blocked" : "ready" }
    })
  })

  it("projects a formerly ready service exit and preserves files when selected at commit", () => {
    const f = serviceResult(true, "Keep the same preview server running")
    exitPreview(f)
    expect(f.store.getWorkResultReview(f.review.id)?.services?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "preview", state: "completed", ready: false })
    ]))
    expect(f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: ["preview"] })).toMatchObject({
      state: "publish", publication: { kind: "blocked", attachments: [{ file: f.file }] }
    })
  })

  it.each([
    { exit: "never", kind: "ready" },
    { exit: "before commit", kind: "ready" },
    { exit: "before commit", kind: "needs_user" },
    { exit: "before commit", kind: "blocked" },
    { exit: "before write", kind: "ready" },
    { exit: "before write", kind: "needs_user" },
    { exit: "before write", kind: "blocked" }
  ] as const)("preserves an alternative $kind report if the dependency exits $exit", ({ exit, kind }) => {
    const f = serviceResult(true)
    if (exit === "before commit") exitPreview(f)
    const summary = kind === "ready" ? "Offline report verified" : kind === "blocked" ? "The offline report lacks the totals" : "Confirm the totals?"
    const alternate = { decision: { ...ready, kind, summary, serviceIds: [], attachments: ["a".repeat(64)] },
      attachments: [{ sourceTaskId: f.task.id, callId: "report", fileIndex: 0 }] }
    f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: ["preview"], attachments: [] }, [], [], alternate)
    f.store.settle(f.review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    if (exit === "before write") exitPreview(f)
    f.store.transition(publication.id, "running")
    const prepared = f.store.getWorkResultPublication(publication.id)
    expect(prepared).toMatchObject(exit === "never"
      ? { kind: "ready", summary: ready.summary, serviceIds: ["preview"], attachments: [] }
      : { kind, summary, attachments: [{ file: f.file }] })
    expect(new BotStore(f.db).getWorkResultPublication(publication.id)).toEqual(prepared)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
  })

  it.each([
    { kind: "ready", exit: "after write" }, { kind: "ready", exit: "before commit" },
    { kind: "ready", exit: "before write" }, { kind: "needs_user", exit: "after write" }
  ] as const)("projects the acknowledged $kind issue during user control ($exit)", ({ kind, exit }) => {
    const f = serviceResult(true, undefined, ({ store, task, work }) => {
      store.acceptCommand(task.id, { id: "monitor", threadId: work.threadId, command: "monitor", cwd: "/tmp",
        startedAt: 1, notifyOnComplete: false })
      store.retainReadyWorkService(task.id, "monitor", "preview-check", "Keep the requested monitor running")
    })
    if (exit === "before commit") exitPreview(f)
    f.store.commitWorkResultReview(f.review.id, kind === "ready" ? { ...ready, serviceIds: ["preview"] }
      : { kind, summary: "Which totals should be adopted?", evidenceIds: [] })
    if (exit === "before write") exitPreview(f)
    acknowledgeServiceResult(f)
    f.store.changeWorkControl({ botId: f.bot.id, workId: f.work.id, action: "take",
      operationId: "keep-monitor", expectedVersion: f.store.getWork(f.bot.id, f.work.id).version })
    f.store.finishWorkControlHandoffs(new Set())
    if (exit === "after write") exitPreview(f)
    for (const work of serviceProjections(f)) {
      expect(work).toMatchObject({ backgroundBusy: true, userControl: { settling: false } })
      if (kind === "ready") expect(work.resultConclusion).toMatchObject({ kind: "blocked", unavailableDependency: true })
      else expect(work.resultNeedsUser).toBe("Which totals should be adopted?")
    }
  })

  it.each(["before write", "after write"] as const)("keeps a dependent question if an independent check fails and the selected service exits %s", exit => {
    const f = serviceResult(true, undefined, ({ store, task, work }) => {
      store.acceptCommand(task.id, { id: "independent-preview", threadId: work.threadId, command: "serve other",
        cwd: "/tmp", startedAt: 1, notifyOnComplete: false })
      store.recordWorkResultEvidence(task.id, { foregroundCommand: httpCheck })
    })
    f.store.settleCommand({ id: "independent-preview", threadId: f.work.threadId, exitCode: 0,
      output: "closed", cancelled: false, truncated: false })
    const question = "Open the preview and choose an export format."
    const alternate = { decision: { kind: "needs_user" as const, summary: question, evidenceIds: [inspectedCheckId],
      serviceIds: ["preview"], serviceChecks: { "independent-preview": inspectedCheckId }, attachments: ["a".repeat(64)] },
    attachments: [{ sourceTaskId: f.task.id, callId: "report", fileIndex: 0 }] }
    f.store.commitWorkResultReview(f.review.id,
      exit === "before write" ? { ...ready, serviceIds: ["preview"], attachments: [] } : alternate.decision,
      exit === "before write" ? [] : alternate.attachments, [inspectedForeground(f)],
      exit === "before write" ? alternate : undefined)
    f.store.settle(f.review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    if (exit === "before write") exitPreview(f)
    f.store.transition(publication.id, "running")
    const prepared = f.store.getWorkResultPublication(publication.id)
    expect(prepared).toMatchObject({ kind: "needs_user", attachments: [{ file: f.file }],
      summary: exit === "before write" ? expect.stringContaining("服务当前不可用") : question })
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    if (exit === "after write") exitPreview(f)
    expect(f.store.getWork(f.bot.id, f.work.id).resultNeedsUser).toContain("服务当前不可用")
    expect(f.store.getWork(f.bot.id, f.work.id).resultNeedsUser).toContain(question)
    expect(new BotStore(f.db).getWorkResultPublication(publication.id)).toEqual(prepared)
  })

  it("tracks an old preview selected on continuation after its exit removes it from the catalogue", () => {
    const f = serviceResult()
    f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: [] })
    acknowledgeServiceResult(f)
    const next = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "reuse-preview",
      message: "Open the existing preview to choose a format" })
    f.store.transition(next.id, "running")
    f.store.recordPreparedInput(next.id, next.message)
    expect(f.store.armWorkResultReview(next.id, "incarnation", true)).toBe(true)
    f.store.settle(next.id, "completed", null, "Please choose a format")
    const review = privateReview(f.store)
    expect(f.store.getWorkResultReview(review.id)?.services.items).toMatchObject([{ id: "preview", state: "accepted" }])
    exitPreview(f)
    expect(f.store.getWorkResultReview(review.id)?.services.items).toEqual([])
    const question = "Open the existing preview and choose a format."
    f.store.commitWorkResultReview(review.id, { kind: "needs_user", summary: question, evidenceIds: [], serviceIds: ["preview"] })
    f.store.settle(review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    expect(f.store.getWorkResultPublication(publication.id)).toMatchObject({ kind: "needs_user", serviceIds: ["preview"],
      unavailableDependency: true, summary: expect.stringContaining(question) })
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(f.store.getWork(f.bot.id, f.work.id).resultNeedsUser).toContain("服务当前不可用")
  })

  it("freezes a blocked delivery when a selected service exits before first publication", () => {
    const f = serviceResult(true)
    f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: ["preview"] })
    f.store.settle(f.review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    exitPreview(f)
    expect(f.store.getWorkResultPublication(publication.id)).toMatchObject({
      kind: "blocked", attachments: [{ file: f.file }]
    })
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toMatchObject({ kind: "blocked" })
  })

  it.each([{ serviceIds: ["preview"] }, { serviceIds: [] }])("reflects exited dependencies $serviceIds without rewriting publication history", ({ serviceIds }) => {
    const f = serviceResult(true)
    f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds })
    f.store.settle(f.review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    const prepared = f.store.getWorkResultPublication(publication.id)
    expect(prepared).toMatchObject({ kind: "ready", serviceIds, attachments: [{ file: f.file }] })
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    exitPreview(f)
    expect(f.store.getWorkResultPublication(publication.id)).toEqual(prepared)
    expect(f.store.getWork(f.bot.id, f.work.id).resultConclusion).toMatchObject(serviceIds.length
      ? { kind: "blocked", summary: expect.stringContaining("成果所需的服务已停止") }
      : { kind: "ready", summary: ready.summary })
  })

  it.each([true, false])("refreshes a lost dependency only if the message was never written (written=%s)", written => {
    const f = serviceResult(true)
    f.store.commitWorkResultReview(f.review.id, { ...ready, serviceIds: ["preview"] })
    f.store.settle(f.review.id, "completed", null)
    f.store.flushReplies()
    const publication = notices(f.store).find(item => item.state === "queued")!
    f.store.transition(publication.id, "running")
    const prepared = f.store.getWorkResultPublication(publication.id)!
    expect(prepared).toMatchObject({ kind: "ready", serviceIds: ["preview"] })
    exitPreview(f)
    const reopened = new BotStore(f.db)
    const next = reopened.getWorkResultPublication(publication.id, !written)
    if (written) expect(next).toEqual(prepared)
    else expect(next).toMatchObject({ kind: "blocked", unavailableDependency: true, attachments: [{ file: f.file }] })
    expect(reopened.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    expect(reopened.acknowledgeWorkResultPublication(publication.id)).toBe(false)
    expect(reopened.getWorkResultPublication(publication.id, true)).toEqual(next)
    expect(reopened.getWork(f.bot.id, f.work.id).resultPublicationId).toBe(prepared.id)
  })

  it("still requires evidence for a live service kept by an amended request", () => {
    const f = fixture()
    const { store, task, work, bot } = f
    beginVerifiedWork(f)
    store.acceptCommand(task.id, { id: "preview", threadId: work.threadId, command: "serve", cwd: "/tmp",
      startedAt: 1, notifyOnComplete: false })
    const input = store.enqueue({ botId: bot.id, workId: work.id, requestId: "corrected", message: "Keep the same preview server running" })
    store.recordPreparedInput(input.id, input.message)
    expect(store.injectIntoRun(input.id, task.id)).toBe(true)
    store.settleRun(task.id, [input.id], "completed", null, "Preview is ready")
    const review = privateReview(store)
    store.commitWorkResultReview(review.id, { ...ready, serviceIds: ["preview"] })
    store.settle(review.id, "completed", null)
    store.flushReplies()
    const publication = notices(store).find(item => item.state === "queued")!
    store.transition(publication.id, "running")
    expect(store.getWorkResultPublication(publication.id)).toMatchObject({ kind: "blocked", summary: expect.stringContaining("就绪证据") })
    expect(store.getWork(bot.id, work.id).backgroundBusy).toBe(true)
  })

  it.each([true, false])("uses real readiness when the accepted service stays running (%s)", verified => {
    const f = fixture()
    beginVerifiedWork(f)
    const { threadId } = f.work
    f.store.acceptCommand(f.task.id, { id: "service", threadId, command: "serve", cwd: "/tmp", startedAt: 1, notifyOnComplete: false })
    if (verified) {
      f.store.acceptCommand(f.task.id, { id: "check", threadId, command: "check", cwd: "/tmp", startedAt: 2 })
      f.store.settleCommand({ id: "check", threadId, exitCode: 0, output: "service ready", cancelled: false, truncated: false })
      f.store.retainReadyWorkService(f.task.id, "service", "check", "Original request needs the live service")
    }
    f.store.settle(f.task.id, "completed", null, "Service output")
    const notification = f.store.recentTasks().find(task => task.origin.kind === "notification")
    if (notification) settle(f.store, notification, "completed", BOT_ROUTINE_SILENT)
    f.store.flushReplies()
    const [next] = notices(f.store)
    expect(next.origin).toMatchObject({ review: { phase: "review" } })
    f.store.transition(next.id, "running")
    expect(f.store.commitWorkResultReview(next.id, { ...ready, serviceIds: ["service"] })).toMatchObject({ state: "publish" })
    f.store.settle(next.id, "completed", null)
    f.store.flushReplies()
    const publication = f.store.nextQueued([])!
    f.store.transition(publication.id, "running")
    expect(f.store.getWorkResultPublication(publication.id)).toMatchObject(verified
      ? { kind: "ready" }
      : { kind: "blocked", summary: expect.stringContaining("就绪证据") })
    const summary = () => f.store.workSummaries(f.bot.id, [f.work.id])[0]
    expect(summary().readyServiceState).toBe(verified ? "running" : undefined)
    expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    f.store.settle(publication.id, "completed", null)
    expect(summary().backgroundBusy).toBe(true)
    expect(summary().readyServiceState).toBe(verified ? "result_ready" : undefined)
    if (!verified) return
    expect(f.store.getWork(f.bot.id, f.work.id).readyServiceState).toBe("result_ready")
    expect(f.store.listWorks(f.bot.id).items[0].readyServiceState).toBe("result_ready")
    expect(f.store.listWorks(f.bot.id, undefined, "", "desktop", "model").items[0].readyServiceState).toBeUndefined()

    const followUp = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "follow-up-preview",
      message: "A separate follow-up on this work" })
    expect(summary()).toMatchObject({ backgroundBusy: true, executionState: "queued", readyServiceState: "running" })
    f.store.transition(followUp.id, "running")
    f.store.acceptCommand(followUp.id, { id: "finite", threadId, command: "finite verification", cwd: "/tmp", startedAt: 3 })
    f.store.transition(followUp.id, "waiting_user")
    expect(summary()).toMatchObject({ backgroundBusy: true, executionState: "waiting_user" })
    expect(summary().readyServiceState).toBeUndefined()
    f.store.settleCommand({ id: "finite", threadId, exitCode: 0, output: "finished", cancelled: false, truncated: false })
    f.store.settle(followUp.id, "failed", "Model failed")
    const finiteNotice = f.store.recentTasks().find(task =>
      task.origin.kind === "notification" && task.origin.key === "finite")
    expect(finiteNotice).toBeDefined()
    settle(f.store, finiteNotice!, "failed")
    expect(summary()).toMatchObject({ backgroundBusy: true, executionState: "failed", readyServiceState: "running" })

    const later = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "later-preview",
      message: "Check a separate detail" })
    f.store.transition(later.id, "running")
    f.store.recordPreparedInput(later.id, later.message)
    f.store.settle(later.id, "completed", null, "The separate check has finished")
    expect(summary()).toMatchObject({ backgroundBusy: true, executionState: "completed", readyServiceState: "running" })
    f.store.stopWorkDispatch(f.bot.id, f.work.id)
    expect(summary()).toMatchObject({ backgroundBusy: true, dispatchStopped: true })
    expect(summary().readyServiceState).toBeUndefined()
  })
})

describe("independent work result return", () => {
  it("keeps an existing association's metadata for display without making it a target prompt", () => {
    const { store, bot } = fixture()
    const conversation = { kind: "local_thread" as const, threadId: "existing",
      incarnation: { token: null, legacyCreatedAt: 1 } }
    const title = "Original association title", goal = "Original association goal"
    const work = store.conversations.prepare({ botId: bot.id, operationId: "link", title, goal, conversation })
    store.conversations.bound(bot.id, work.id, conversation)
    expect(store.workPromptGoal(bot.id, work.id)).toBeUndefined()
    expect(store.getWork(bot.id, work.id)).toMatchObject({ title, goal })
  })

  it("omits replaced creation metadata from later turns, preserving original history", () => {
    const f = fixture()
    expect(f.store.workPromptGoal(f.bot.id, f.work.id)).toBeUndefined()
    f.store.transition(f.task.id, "running")
    f.store.recordPreparedInput(f.task.id, "Approved task brief")
    f.store.settle(f.task.id, "completed", null, "Done")
    const restored = new BotStore(f.db)
    expect(restored.workPromptGoal(f.bot.id, f.work.id)).toBeUndefined()
    expect(restored.getWork(f.bot.id, f.work.id).goal).toBe("安排活动")
    expect(restored.getTask(f.task.id).message).toBe("安排活动")
    const later = restored.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "later", message: "Follow up" })
    restored.recordPreparedInput(later.id, "Approved follow up")
    expect(restored.workPromptGoal(f.bot.id, f.work.id)).toBeUndefined()
  })

  it.each(["cancelled", "interrupted", "failed"] as const)("does not reinject the unaccepted goal after %s", state => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.settle(f.task.id, state, "Not accepted")
    expect(new BotStore(f.db).workPromptGoal(f.bot.id, f.work.id)).toBeUndefined()
  })

  it("retains unchanged accepted briefs but never restores an explicitly emptied brief", () => {
    const f = fixture()
    f.store.recordPreparedInput(f.task.id, f.task.message)
    expect(f.store.workPromptGoal(f.bot.id, f.work.id)).toBe(f.work.goal)
    f.store.recordPreparedInput(f.task.id, "")
    expect(f.store.workPromptGoal(f.bot.id, f.work.id)).toBeUndefined()
  })

  it("returns only the accepted request body after preparation, including injected inputs and restart", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.recordPreparedInput(f.task.id, "Approved first request")
    const later = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
      requestId: "rewritten-follow-up", message: "REMOVED SUPPLEMENT" })
    f.store.recordPreparedInput(later.id, "Approved supplement")
    expect(f.store.injectIntoRun(later.id, f.task.id)).toBe(true)
    const reopened = new BotStore(f.db)
    reopened.settleRun(f.task.id, [later.id], "completed", null, "Verified result")
    reopened.flushReplies()
    reopened.flushReplies()
    const [notice] = notices(reopened)
    expect(notices(reopened)).toHaveLength(1)
    expect(JSON.parse(notice.message).requestContext.messages).toEqual([
      { text: "Approved first request", truncated: false },
      { text: "Approved supplement", truncated: false }
    ])
    expect(JSON.parse(notice.message)).not.toHaveProperty("executionSource")
    expect(notice.message).not.toMatch(/安排活动|REMOVED SUPPLEMENT/)
    expect(JSON.parse(notice.message).title).toBe("原任务")
    expect(reopened.getTask(f.task.id).message).toBe("安排活动")
    expect(reopened.getTask(later.id).message).toBe("REMOVED SUPPLEMENT")
  })

  it.each([false, true])("marks scheduled result context incomplete and identifies the exact occurrence after editing (blocked: %s)", blocked => {
    const f = fixture()
    settle(f.store, f.task)
    const input = {
      name: "Check receipt",
      message: "Original routine instruction",
      frequency: "once" as const,
      enabled: true,
      runAt: "2030-01-01T00:00:00.000Z"
    }
    const schedule = f.store.saveSchedule(f.bot.id, input, input.runAt, undefined, undefined,
      { workId: f.work.id, operationId: "create-routine" })
    f.store.fireSchedule(schedule, null)
    const trigger = f.store.nextQueued([])!
    expect(trigger).toMatchObject({
      workId: f.work.id, message: input.message, origin: { kind: "schedule", scheduleId: schedule.id }
    })
    f.store.transition(trigger.id, "running")
    if (!blocked) {
      f.store.recordPreparedInput(trigger.id, "Approved routine instruction")
      f.store.recordPreparedInput(trigger.id, null)
    }
    const edited = f.store.saveSchedule(f.bot.id, {
      ...input, message: "Edited routine instruction", enabled: false
    }, null, f.store.schedules()[0])
    expect(edited.id).toBe(schedule.id)
    expect(edited.message).not.toBe(trigger.message)
    if (blocked)
      f.store.settleRun(trigger.id, [], "failed", "Private submit diagnostic", undefined, undefined, false,
        { outcome: "error", code: "prompt_blocked" })
    else
      f.store.settle(trigger.id, "completed", null, "Receipt label is BLUE")
    const reopened = new BotStore(f.db)
    reopened.flushReplies()
    const notice = notices(reopened).find(task => task.requestId === `work-result-${trigger.id}`)!
    expect(notice.origin).toMatchObject({ executionTaskId: trigger.id })
    expect(JSON.parse(notice.message)).toMatchObject({
      executionState: blocked ? "failed" : "completed",
      executionSource: { kind: "schedule", scheduleId: schedule.id, executionTaskId: trigger.id,
        scheduleAtReport: { exists: true, enabled: false, nextRunAt: null, recordedAt: expect.any(String) } },
      requestContext: { messages: [], messagesOmitted: true },
      result: blocked ? expect.stringContaining("输入检查未通过") : "Receipt label is BLUE"
    })
    if (blocked) expect(JSON.parse(notice.message).executionSource).not.toHaveProperty("instruction")
    else expect(JSON.parse(notice.message).executionSource.instruction).toEqual({
      text: "Approved routine instruction", truncated: false
    })
    expect(reopened.getTask(trigger.id).origin).not.toHaveProperty("allowedInputFileIds")
    expect(() => reopened.recordPreparedInput(trigger.id, "late overwrite")).toThrow("已停止")
    expect(notice.message).not.toMatch(/Original routine instruction|Edited routine instruction|Private submit diagnostic/)
  })

  it("preserves the admitted routine instruction after checkpoint recovery without replay", () => {
    const f = fixture()
    settle(f.store, f.task)
    const input = { name: "Read receipt", message: "UNAPPROVED original instruction",
      frequency: "once" as const, enabled: true, runAt: "2030-01-01T00:00:00.000Z" }
    const schedule = f.store.saveSchedule(f.bot.id, input, input.runAt, undefined, undefined,
      { workId: f.work.id, operationId: "checkpoint-routine" })
    f.store.fireSchedule(schedule, null)
    const trigger = f.store.nextQueued([])!
    f.store.transition(trigger.id, "running")
    f.store.recordPreparedInput(trigger.id, "Only read the existing receipt; do not regenerate it.")
    f.store.deferTask(trigger.id, "after-receipt-read")
    const reopened = new BotStore(f.db)
    expect(reopened.taskCheckpoint(trigger.id)).toBe("after-receipt-read")
    reopened.recover()
    reopened.flushReplies()
    reopened.recover()
    reopened.flushReplies()
    expect(reopened.getTask(trigger.id).state).toBe("interrupted")
    const reports = notices(reopened).filter(task => task.requestId === `work-result-${trigger.id}`)
    expect(reports).toHaveLength(1)
    const report = JSON.parse(reports[0].message)
    expect(report.executionState).toBe("interrupted")
    expect(report.executionSource.instruction).toEqual({
      text: "Only read the existing receipt; do not regenerate it.", truncated: false
    })
    expect(reports[0].message).not.toContain("UNAPPROVED original instruction")
    expect(reopened.recentTasks().filter(task => task.origin.kind === "schedule" &&
      task.origin.scheduleId === schedule.id)).toHaveLength(1)
  })

  it.each(["finished", "rearmed", "deleted"] as const)("reports routine state independently of the completed occurrence (%s)", state => {
    const f = fixture()
    settle(f.store, f.task)
    const input = { name: "Routine", message: "Read only", frequency: "once" as const,
      enabled: true, runAt: "2030-01-01T00:00:00.000Z" }
    const schedule = f.store.saveSchedule(f.bot.id, input, input.runAt, undefined, undefined,
      { workId: f.work.id, operationId: "routine" })
    f.store.fireSchedule(schedule, null)
    const trigger = f.store.nextQueued([])!
    f.store.transition(trigger.id, "running")
    f.store.recordPreparedInput(trigger.id, "Admitted scope")
    f.store.settle(trigger.id, "completed", null, "Exists")
    const fired = f.store.schedules()[0]
    const future = "2031-01-01T00:00:00.000Z"
    if (state === "rearmed") f.store.saveSchedule(f.bot.id, { ...input, runAt: future }, future, fired)
    if (state === "deleted") f.store.removeSchedule(fired.id, fired.version)
    f.store.flushReplies()
    const notice = notices(f.store).find(task => task.requestId === `work-result-${trigger.id}`)!
    const report = JSON.parse(notice.message)
    expect(report.pendingExecution).toBe(false)
    expect(report.executionSource.scheduleAtReport).toEqual({
      recordedAt: expect.any(String), exists: state !== "deleted",
      ...(state !== "deleted" ? { frequency: "once", enabled: state === "rearmed",
        nextRunAt: state === "rearmed" ? future : null,
        lastTriggeredAt: state === "rearmed" ? null : fired.lastTriggeredAt } : {})
    })
    expect(report.executionSource.instruction.text).toBe("Admitted scope")
  })

  it("reports the committed automatic pause when a routine's directory is missing", () => {
    const f = fixture()
    settle(f.store, f.task)
    const schedule = f.store.saveSchedule(f.bot.id, {
      name: "Routine", message: "Read only", frequency: "interval", intervalMinutes: 10, enabled: true
    }, "2030-01-01T00:00:00.000Z", undefined, undefined,
      { workId: f.work.id, operationId: "routine" })
    f.store.fireSchedule(schedule, "2030-01-01T00:10:00.000Z")
    const trigger = f.store.nextQueued([])!
    expect(f.store.pauseScheduleForMissingDirectory(trigger.id, f.store.schedules()[0])).toBe(true)
    f.store.flushReplies()
    expect(f.store.getTask(trigger.id).state).toBe("failed")
    const notice = notices(f.store).find(task => task.requestId === `work-result-${trigger.id}`)!
    const report = JSON.parse(notice.message)
    expect(report.result).toContain("例行已暂停")
    expect(report.executionSource.scheduleAtReport).toMatchObject({ exists: true, frequency: "interval",
      enabled: false, nextRunAt: null, lastTriggeredAt: expect.any(String) })
    expect(report.executionSource).not.toHaveProperty("instruction")
  })

  it("retains an explicitly empty prepared body and refuses to change it after cancellation", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.recordPreparedInput(f.task.id, "")
    f.store.settleRun(f.task.id, [], "cancelled", "Stopped")
    expect(() => f.store.recordPreparedInput(f.task.id, "late input")).toThrow("已停止")
    const reopened = new BotStore(f.db)
    reopened.recover()
    reopened.flushReplies()
    expect(JSON.parse(notices(reopened)[0].message).requestContext.messages).toEqual([
      { text: "", truncated: false }
    ])
    expect(notices(reopened)[0].message).not.toContain("安排活动")
    expect(reopened.getTask(f.task.id).message).toBe("安排活动")
  })

  it("does not reintroduce an earlier rewritten title through a later unchanged request", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.recordPreparedInput(f.task.id, "Approved request")
    f.store.settleRun(f.task.id, [], "completed", null, "First result")
    f.store.flushReplies()
    const later = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
      requestId: "later", message: "Normal follow-up" })
    f.store.transition(later.id, "running")
    f.store.recordPreparedInput(later.id, later.message)
    f.store.settleRun(later.id, [], "completed", null, "Next result")
    f.store.flushReplies()
    expect(notices(f.store)).toHaveLength(2)
    expect(notices(f.store).map(task => JSON.parse(task.message).title)).toEqual(["原任务", "原任务"])
    expect(f.store.getWork(f.bot.id, f.work.id).title).toBe("读书会")
  })

  it("keeps the title decision after old execution history is pruned", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.recordPreparedInput(f.task.id, "Approved request")
    f.store.settleRun(f.task.id, [], "completed", null, "First result")
    f.store.flushReplies()
    settle(f.store, notices(f.store)[0])
    // A work retains its latest settlement; let the earlier title-bearing execution expire.
    const revision = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
      requestId: "newer-result", message: "Normal follow-up before retention" })
    f.store.recordPreparedInput(revision.id, revision.message)
    settle(f.store, revision)
    f.store.flushReplies()
    settle(f.store, notices(f.store).find(task => task.origin.kind === "work_result" &&
      task.origin.executionTaskId === revision.id)!)
    f.advanceClock(31 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 101; i++) {
      const unrelated = f.store.enqueue({ botId: f.bot.id, requestId: `unrelated-${i}`, message: "Other work" })
      settle(f.store, unrelated)
    }
    f.store.pruneTaskHistory()
    expect(() => f.store.getTask(f.task.id)).toThrow()
    const reopened = new BotStore(f.db)
    const later = reopened.enqueue({ botId: f.bot.id, workId: f.work.id,
      requestId: "after-prune", message: "Normal follow-up" })
    reopened.recordPreparedInput(later.id, later.message)
    settle(reopened, later)
    reopened.flushReplies()
    expect(JSON.parse(notices(reopened)[0].message).title).toBe("原任务")
    expect(reopened.getWork(f.bot.id, f.work.id).title).toBe("读书会")
  })

  it("does not let an unconsumed rewritten supplement hide the original work title", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.recordPreparedInput(f.task.id, f.task.message)
    const supplement = f.store.enqueue({ botId: f.bot.id, workId: f.work.id,
      requestId: "cancelled-supplement", message: "Change date" })
    f.store.recordPreparedInput(supplement.id, "Approved date")
    f.store.settle(supplement.id, "cancelled", "Stopped")
    f.store.settleRun(f.task.id, [], "completed", null, "First result")
    f.store.flushReplies()
    const completed = notices(f.store).find(task => task.origin.kind === "work_result" &&
      task.origin.executionTaskId === f.task.id)
    expect(JSON.parse(completed!.message).title).toBe("读书会")
    const reopened = new BotStore(f.db)
    const later = reopened.enqueue({ botId: f.bot.id, workId: f.work.id,
      requestId: "next-normal", message: "Next request" })
    settle(reopened, later)
    reopened.flushReplies()
    const next = notices(reopened).find(task => task.origin.kind === "work_result" &&
      task.origin.executionTaskId === later.id)
    expect(JSON.parse(next!.message).title).toBe("读书会")
  })

  it("keeps full prepared bodies out of inbox previews and avoids duplicating unchanged bodies", () => {
    const f = fixture()
    const raw = "a".repeat(64000)
    const task = f.store.enqueue({ botId: f.bot.id, requestId: "large-input", message: raw })
    f.store.recordPreparedInput(task.id, raw)
    expect(f.store.getTask(task.id).origin).not.toHaveProperty("preparedInput")
    const rewritten = "b".repeat(64000)
    f.store.recordPreparedInput(task.id, rewritten)
    expect(JSON.stringify(f.store.getTask(task.id).origin)).not.toContain(rewritten)
    const preview = f.store.recentTasks(true).find(row => row.id === task.id)!
    expect(preview.message).toHaveLength(600)
    expect(preview.origin).not.toHaveProperty("preparedInput")
    expect(JSON.stringify(preview).length).toBeLessThan(2000)
    expect(JSON.stringify(f.store.messageOrigins(f.bot.id, [task.requestId])).length).toBeLessThan(2000)
  })

  it("persists a sanitized refusal outbox across restart without retrying or losing the result", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.settleRun(f.task.id, [], "failed", "Hook diagnostic containing raw input", "unapproved output", [
      { filePath: "/unapproved/file", name: "unapproved-file", size: 1 }
    ], false, { outcome: "error", code: "prompt_blocked" })
    const reopened = new BotStore(f.db)
    reopened.recover()
    reopened.flushReplies()
    reopened.flushReplies()
    const [notice] = notices(reopened)
    expect(notices(reopened)).toHaveLength(1)
    expect(notice.origin).toMatchObject({ executionState: "failed", workTitle: "原任务" })
    expect(notice.message).not.toMatch(/raw input|unapproved|安排活动|读书会/)
    expect(JSON.parse(notice.message)).toMatchObject({ requestContext: { messages: [], messagesOmitted: true }, files: [] })
    expect(reopened.getTask(f.task.id).state).toBe("failed")
    expect(reopened.getTask(f.task.id).message).toBe("安排活动")
  })

  it.each(["failed", "cancelled", "interrupted"] as const)("keeps ordinary %s semantics and does not classify diagnostic prose as a rejection", (state) => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.recordPreparedInput(f.task.id, f.task.message)
    const error = "Provider diagnostic mentions prompt_blocked"
    f.store.settleRun(f.task.id, [], state, error, undefined, undefined, false,
      { outcome: "error", code: state === "failed" ? "provider_error" : "cancelled" })
    f.store.flushReplies()
    const [notice] = notices(f.store)
    expect(notice.origin).toMatchObject({ executionState: state, workTitle: "读书会" })
    expect(JSON.parse(notice.message)).toMatchObject({
      result: error, requestContext: { messages: [{ text: "安排活动", truncated: false }], messagesOmitted: false }
    })
  })

  it.each(["cancelled", "interrupted", "failed"] as const)("omits input not yet accepted when a running work becomes %s", (state) => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    f.store.settleRun(f.task.id, [], state, "Stopped before input acceptance")
    const reopened = new BotStore(f.db)
    reopened.recover()
    reopened.flushReplies()
    reopened.flushReplies()
    expect(notices(reopened)).toHaveLength(1)
    expect(JSON.parse(notices(reopened)[0].message)).toMatchObject({
      title: "原任务", executionState: state,
      requestContext: { messages: [], messagesOmitted: true }
    })
    expect(notices(reopened)[0].message).not.toMatch(/安排活动|读书会/)
    expect(reopened.getTask(f.task.id).message).toBe("安排活动")
  })

  it("reports a first-input refusal without forwarding rejected content, and preserves the next normal turn", async () => {
    const f = fixture()
    const rejected = "SYNTHETIC-REJECTED-INPUT"
    const created = f.store.createWork({ botId: f.bot.id, operationId: "blocked-work", title: rejected, goal: rejected })
    const received: BotTask[] = []
    const host = new LocalBotHost(f.store, {
      onAvailable: () => () => {},
      acquire: (_bot, task) => ({
        release() {},
        notificationTerminal: () => task.id === created.task.id
          ? { outcome: "error", code: "prompt_blocked", message: `Hook diagnostic: ${rejected}` }
          : { outcome: "success", code: "normal" },
        execute: async () => {
          if (task.origin.kind === "work_result") received.push(task)
          return task.id === created.task.id
            ? { state: "failed", error: `Hook diagnostic: ${rejected}` }
            : { state: "completed", result: "Normal result" }
        }
      })
    })
    hosts.push(host)
    await vi.waitFor(() => expect(received.some(task => task.origin.kind === "work_result" && task.origin.executionTaskId === created.task.id)).toBe(true))
    const notice = received.find(task => task.origin.kind === "work_result" && task.origin.executionTaskId === created.task.id)!
    expect(notice.message).not.toContain(rejected)
    expect(JSON.stringify(notice.origin)).not.toContain(rejected)
    expect(JSON.parse(notice.message)).toMatchObject({
      executionState: "failed", requestContext: { messages: [], messagesOmitted: true },
      files: []
    })
    expect(JSON.parse(notice.message).result).toContain("输入检查未通过")
    // Raw user-visible records survive; only the reporting model's projection is restricted.
    expect(f.store.getWork(f.bot.id, created.work.id).title).toBe(rejected)
    expect(f.store.getTask(created.task.id).message).toBe(rejected)
    const next = host.send({ botId: f.bot.id, workId: created.work.id, requestId: "accepted-later", message: "正常新请求" })
    await vi.waitFor(() => expect(received.some(task => task.origin.kind === "work_result" && task.origin.executionTaskId === next.id)).toBe(true))
    const normal = received.find(task => task.origin.kind === "work_result" && task.origin.executionTaskId === next.id)!
    expect(JSON.parse(normal.message).requestContext.messages).toEqual([{ text: "正常新请求", truncated: false }])
    expect(normal.message).not.toContain(rejected)
    expect(JSON.stringify(normal.origin)).not.toContain(rejected)
    expect(received.filter(task => task.origin.kind === "work_result" && task.origin.executionTaskId === created.task.id)).toHaveLength(1)
  })

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
    expect(JSON.parse(notices(f.store)[1].message).requestContext.messages).toEqual([
      { text: "改到四点", truncated: false }
    ])
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
    expect(
      JSON.parse(notices(f.store)[0].message).requestContext.messages.map(
        (m: { text: string }) => m.text
      )
    ).toEqual(["安排活动", "改到四点"])
  })

  it("binds report context to the completed execution, excluding later queued edits and unrelated conversations", () => {
    const f = fixture()
    f.store.enqueue({ botId: f.bot.id, requestId: "main-private", message: "主对话的其他讨论" })
    const edit = f.store.enqueue({
      botId: f.bot.id,
      workId: f.work.id,
      requestId: "edit-four",
      message: "周日下午四点"
    })
    f.store.enqueue({
      botId: f.bot.id,
      workId: f.work.id,
      requestId: "later-five",
      message: "改到五点"
    })
    settle(f.store, edit, "completed", "四点的通知")
    f.store.flushReplies()
    const context = JSON.parse(notices(f.store)[0].message).requestContext
    expect(context).toEqual({
      messages: [{ text: "周日下午四点", truncated: false }],
      messagesOmitted: false
    })
  })

  it("bounds request context and marks omitted supplements explicitly", () => {
    const f = fixture()
    f.store.transition(f.task.id, "running")
    const consumed: string[] = []
    for (let n = 0; n < 10; n++) {
      const child = f.store.enqueue({
        botId: f.bot.id,
        workId: f.work.id,
        requestId: `s-${n}`,
        message: `${n}:` + "A".repeat(5000)
      })
      f.store.injectIntoRun(child.id, f.task.id)
      consumed.push(child.id)
    }
    f.store.settleRun(f.task.id, consumed, "completed", null, "结果")
    f.store.flushReplies()
    const context = JSON.parse(notices(f.store)[0].message).requestContext
    expect(context.messagesOmitted).toBe(true)
    expect(context.messages).toHaveLength(9)
    expect(context.messages.at(-1).text).toMatch(/^9:/)
    expect(
      context.messages
        .slice(1)
        .every((m: { text: string; truncated: boolean }) => m.text.length === 2000 && m.truncated)
    ).toBe(true)
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
    const steer = vi.fn(async (_task: BotTask) => false)
    const yieldToUser = vi.fn()
    const interrupted = vi.fn()
    const host = new LocalBotHost(f.store, {
      onAvailable: () => () => {},
      acquire: (_bot, task) => ({
        release() {},
        steer,
        yieldToUser,
        async execute(signal) {
          signal.addEventListener("abort", interrupted, { once: true })
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
    await vi.waitFor(() => expect(executed.some(task => task.id === main.id)).toBe(true))
    host.onSteeringReady(main.id)
    await vi.waitFor(() => expect(notices(f.store)).toHaveLength(1))
    host.onSteeringReady(main.id)
    expect(executed.some((task) => task.origin.kind === "work_result")).toBe(false)
    expect(steer).not.toHaveBeenCalled()
    expect(yieldToUser).not.toHaveBeenCalled()
    expect(interrupted).not.toHaveBeenCalled()
    const next = host.send({ botId: f.bot.id, requestId: "next-user", message: "先回答这一个问题" })
    release()
    await vi.waitFor(() =>
      expect(executed.filter((task) => task.origin.kind === "work_result")).toHaveLength(1)
    )
    expect(executed.findIndex(task => task.id === next.id)).toBeLessThan(
      executed.findIndex(task => task.origin.kind === "work_result")
    )
    expect(steer.mock.calls.every(args => (args[0] as BotTask)?.origin.kind !== "work_result")).toBe(true)
    expect(interrupted).not.toHaveBeenCalled()
  })
})
