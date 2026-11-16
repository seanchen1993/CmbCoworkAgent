import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunLease } from "./host"
import { createBotWorkTools } from "./work-tools"

const resources: Array<{ host: LocalBotHost; db: NativeSqliteAdapter }> = []
afterEach(async () => {
  await Promise.all(resources.map(({ host }) => host.stop()))
  resources.splice(0).forEach(({ db }) => db.close())
})

async function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const peer = store.create({ name: "Reviewer", instructions: "", color: "#123456", modelRef: null })
  const signals = new Map<string, AbortSignal>()
  const finishes = new Map<string, (result: Awaited<ReturnType<BotRunLease["execute"]>>) => void>()
  const starts: string[] = []
  const injections = new Map<string, () => boolean>()
  const cancelBackground = vi.fn(), cancelBackgroundCommands = vi.fn()
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {}, cancelBackground, cancelBackgroundCommands,
    acquire: (_bot, task) => ({
      release() {},
      async steer(input, inject) {
        injections.set(input.id, inject)
        return true
      },
      execute: signal => new Promise(resolve => {
        starts.push(task.id)
        signals.set(task.id, signal)
        finishes.set(task.id, resolve)
        signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true })
      })
    })
  })
  resources.push({ host, db })
  const source = host.send({ botId: bot.id, requestId: "stop-request", message: "停止报告任务，保留其他工作" })
  const { work, task } = await host.createWork({ botId: bot.id, operationId: "report", title: "报告", goal: "完成报告" })
  await vi.waitFor(() => expect(signals.has(source.id) && signals.has(task.id)).toBe(true))
  const command = { taskId: source.id, callId: "stop-call", key: "stop-report" }
  const stop = () => host.stopWorkFromTool(command, work.id, work.version)
  return { db, store, bot, peer, host, source, work, task, command, stop, signals, finishes, starts,
    injections, cancelBackground, cancelBackgroundCommands }
}

describe("explicit Bot work Stop", () => {
  it("keeps future routines after stopping the current conversation and pauses them after stopping the work", async () => {
    const f = await fixture()
    const routine = f.store.saveSchedule(f.bot.id, {
      name: "Refresh report", message: "Refresh the original report", frequency: "interval",
      intervalMinutes: 10, enabled: true
    }, "2030-01-01T00:10:00Z", undefined, undefined, { workId: f.work.id, operationId: "report-routine" })

    f.host.stopConversation(f.bot.id, undefined, f.work.id)
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("cancelled"))
    expect(f.store.getWork(f.bot.id, f.work.id).dispatchStopped).toBeUndefined()
    expect(f.signals.get(f.source.id)?.aborted).toBe(false)

    f.store.fireSchedule(routine, "2030-01-01T00:20:00Z")
    const occurrence = f.store.recentTasks().find(task => task.origin.kind === "schedule")!
    expect(occurrence).toMatchObject({ workId: f.work.id, state: "queued" })

    f.host.stopWork(f.bot.id, f.work.id)
    await vi.waitFor(() => expect(f.store.getTask(occurrence.id).state).toBe("cancelled"))
    expect(f.store.getWork(f.bot.id, f.work.id).dispatchStopped).toBe(true)
    f.store.fireSchedule(f.store.schedules()[0], "2030-01-01T00:30:00Z")
    expect(f.store.schedules()[0]).toMatchObject({ id: routine.id, enabled: false, workUnavailable: true })
    expect(f.store.recentTasks().filter(task => task.origin.kind === "schedule").map(task => task.id)).toEqual([occurrence.id])
  })

  it.each([
    { launcherFinished: false, acceptReplacement: false }, { launcherFinished: true, acceptReplacement: false },
    { launcherFinished: false, acceptReplacement: true }, { launcherFinished: true, acceptReplacement: true }
  ])("keeps stopped-work evidence and withdraws only superseded publication (launcher=$launcherFinished, replacement=$acceptReplacement)", async ({ launcherFinished, acceptReplacement }) => {
    const f = await fixture()
    f.host.recordPreparedInput(f.task.id, f.task.id, f.task.message)
    expect(f.host.armWorkResultReview(f.task.id, "incarnation")).toBe(true)
    const file = { filePath: "/work/report.md", attachmentPath: "/retained/report.md", name: "report.md", size: 10 }
    f.host.recordWorkResultEvidence(f.task.id, { finalMessageId: "final", callId: "report-file", files: [file] })
    const command = f.host.commandLifecycle(f.task.id)
    command.accepted({ id: "report-job", threadId: f.work.threadId, command: "generate-report", cwd: "/work", startedAt: 1 })
    if (launcherFinished) {
      f.finishes.get(f.task.id)!({ state: "completed", result: "Draft available; generator still running" })
      await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("completed"))
    }
    expect(f.store.getWork(f.bot.id, f.work.id).backgroundBusy).toBe(true)
    f.host.stopConversation(f.bot.id, undefined, f.work.id)
    expect(f.cancelBackground).toHaveBeenCalledWith(f.work.threadId)
    expect(f.signals.get(f.source.id)?.aborted).toBe(false)
    expect(f.store.getWork(f.bot.id, f.work.id).dispatchStopped).toBeUndefined()

    const evidence = () => JSON.parse(String(f.db.exec("SELECT work_review_evidence_json FROM bot_tasks WHERE id=?", [f.task.id])[0].values[0][0]))
    const retainedEvidence = evidence()
    const next = acceptReplacement ? (() => {
      // Queueing is not acceptance: cleanup and preparation still have to finish.
      f.host.recordPreparedInput(f.source.id, f.source.id, "Use the saved draft for the next version")
      return f.host.sendWork({ ...f.command, key: "new-input" }, f.work.id, "Revise the saved draft")
    })() : undefined
    command.settled({ id: "report-job", threadId: f.work.threadId, exitCode: 143, output: "Stopped", cancelled: true, truncated: false })
    if (next) {
      await vi.waitFor(() => expect(f.starts).toContain(next.id))
      f.host.recordPreparedInput(next.id, next.id, next.message)
      expect(f.host.armWorkResultReview(next.id, "incarnation")).toBe(true)
    }
    f.finishes.get(f.source.id)!({ state: "completed" })
    await vi.waitFor(() => {
      const results = f.store.recentTasks().filter(task => task.origin.kind === "work_result")
      expect(results).toHaveLength(1)
      expect(results[0].origin).toMatchObject({ executionState: "cancelled", review: { phase: "publish" } })
      if (acceptReplacement) {
        expect(results[0].state).toBe("cancelled")
        expect(f.starts).not.toContain(results[0].id)
        expect(() => f.host.workResultPublication(results[0].id)).toThrow()
      } else {
        expect(results[0].state).toBe("running")
        expect(f.host.workResultPublication(results[0].id)).toMatchObject({
          executionTaskId: f.task.id, kind: "blocked", summary: expect.stringContaining("已请求停止原执行"),
          attachments: [{ sourceTaskId: f.task.id, finalMessageId: "final", file }]
        })
      }
    })
    expect(evidence()).toEqual(retainedEvidence)
    expect(retainedEvidence).toMatchObject({ finalMessageId: "final", deliveries: [{ sourceTaskId: f.task.id, file }] })
    expect(f.starts.filter(id => id === f.task.id)).toHaveLength(1)
    expect(f.signals.get(f.source.id)?.aborted).toBe(false)
    expect(f.store.getTask(f.task.id).state).toBe(launcherFinished ? "completed" : "cancelled")
  })

  it("keeps the review of a settled replacement when stopping only its predecessor's background command", async () => {
    const f = await fixture()
    f.host.recordPreparedInput(f.task.id, f.task.id, f.task.message)
    expect(f.host.armWorkResultReview(f.task.id, "incarnation")).toBe(true)
    const command = f.host.commandLifecycle(f.task.id)
    command.accepted({ id: "old-job", threadId: f.work.threadId, command: "generate-report", cwd: "/work", startedAt: 1 })
    f.finishes.get(f.task.id)!({ state: "completed", result: "Generator still running" })
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("completed"))

    const replacement = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "replacement", message: "Use the saved report" })
    await vi.waitFor(() => expect(f.starts).toContain(replacement.id))
    f.host.recordPreparedInput(replacement.id, replacement.id, replacement.message)
    expect(f.host.armWorkResultReview(replacement.id, "incarnation")).toBe(true)
    f.finishes.get(replacement.id)!({ state: "completed", result: "Used the saved report" })
    await vi.waitFor(() => expect(f.store.getTask(replacement.id).state).toBe("completed"))

    f.host.stopConversation(f.bot.id, undefined, f.work.id)
    command.settled({ id: "old-job", threadId: f.work.threadId, exitCode: 143, output: "Stopped", cancelled: true, truncated: false })
    f.finishes.get(f.source.id)!({ state: "completed" })
    await vi.waitFor(() => {
      const [result] = f.store.recentTasks().filter(task => task.origin.kind === "work_result")
      expect(result?.origin).toMatchObject({ executionTaskId: replacement.id, review: { phase: "review" } })
      expect(f.host.workResultReview(result.id)?.outcome.text).toBe("Used the saved report")
    })
  })

  it("withdraws automatic review through the real scoped tool without stopping physical work", async () => {
    const f = await fixture()
    f.host.recordPreparedInput(f.task.id, f.task.id, f.task.message)
    expect(f.host.armWorkResultReview(f.task.id, "incarnation")).toBe(true)
    const tool = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
      .find(entry => entry.name === "bot_work_stop")!
    const current = f.store.getWork(f.bot.id, f.work.id)
    const call = { type: "tool_call" as const, id: "pause-review", name: tool.name,
      args: { requestKey: "pause-review", workId: f.work.id, expectedVersion: current.version, scope: "review" } }
    const result = await tool.invoke(call)
    const receipt = JSON.parse(result.content as string).receipt
    expect(receipt).toMatchObject({ scope: "review", reviewPaused: true, version: current.version + 1 })
    expect(JSON.parse((await tool.invoke({ ...call, id: "replay" })).content as string).receipt).toEqual(receipt)
    expect(f.signals.get(f.task.id)?.aborted).toBe(false)
    expect(f.store.getTask(f.task.id).state).toBe("running")
    expect(f.store.getWork(f.bot.id, f.work.id).dispatchStopped).toBeUndefined()
    expect(f.cancelBackground).not.toHaveBeenCalled()

    const file = { filePath: "/work/report.zip", attachmentPath: "/retained/report.zip", name: "report.zip", size: 10 }
    f.host.recordWorkResultEvidence(f.task.id, { finalMessageId: "final", callId: "report-file", files: [file] })
    f.finishes.get(f.source.id)!({ state: "completed" })
    f.finishes.get(f.task.id)!({ state: "completed", result: "Report created" })
    await vi.waitFor(() => {
      const results = f.store.recentTasks().filter(task => task.origin.kind === "work_result")
      expect(results).toHaveLength(1)
      expect(f.host.workResultPublication(results[0].id)).toMatchObject({
        executionTaskId: f.task.id, kind: "blocked", summary: expect.stringContaining("Report created"),
        attachments: [{ sourceTaskId: f.task.id, finalMessageId: "final", file }]
      })
    })
  })

  it("includes an injected, accepted work supplement in the original result review and budget", async () => {
    const f = await fixture()
    f.host.recordPreparedInput(f.task.id, f.task.id, f.task.message)
    expect(f.host.armWorkResultReview(f.task.id, "incarnation")).toBe(true)
    f.host.onSteeringReady(f.task.id)
    const input = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "redirect", message: "Use the revised plan" })
    await vi.waitFor(() => expect(f.injections.has(input.id)).toBe(true))
    f.host.beginInputPreparation(f.task.id, input.id)
    f.host.recordPreparedInput(f.task.id, input.id, "Use the revised prepared plan")
    expect(f.store.workResultReviewActiveForExecution(f.task.id)).toBe(true)
    expect(f.store.getTask(input.id).state).toBe("queued")
    const inject = f.injections.get(input.id)!
    expect(inject()).toBe(true)
    expect(inject()).toBe(true)
    expect(f.store.getTask(input.id).injectedInto).toBe(f.task.id)
    expect(f.store.workResultReviewActiveForExecution(f.task.id)).toBe(true)
    f.finishes.get(f.source.id)!({ state: "completed" })
    f.finishes.get(f.task.id)!({ state: "completed", result: "Revised report" })
    await vi.waitFor(() => {
      const review = f.store.recentTasks().find(task => task.origin.kind === "work_result" &&
        task.origin.executionTaskId === f.task.id && task.origin.review?.phase === "review")
      expect(review?.state).toBe("running")
      expect(f.store.getWorkResultReview(review!.id)).toMatchObject({
        requestTaskId: f.task.id, executionTaskId: f.task.id, remainingRepairs: 2,
        requests: [{ id: f.task.id, text: f.task.message }, { id: input.id, text: "Use the revised prepared plan" }]
      })
    })
  })

  it("stops the selected work and its queued collaboration through the real tool, keeping other work and the parent chat", async () => {
    const f = await fixture()
    const other = await f.host.createWork({ botId: f.bot.id, operationId: "other", title: "其他工作", goal: "保留运行" })
    const peer = f.host.delegate(f.task.id, f.peer.id, "复核报告", "review")
    const followUp = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "queued-input", message: "报告增加附录" })
    const tool = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
      .find(entry => entry.name === "bot_work_stop")!
    const current = f.store.getWork(f.bot.id, f.work.id)
    const result = await tool.invoke({ type: "tool_call", id: "stop-call", name: tool.name,
      args: { requestKey: "stop-report", workId: f.work.id, expectedVersion: current.version } }) as { content: string; status: string }
    expect(result.status).not.toBe("error")
    expect(JSON.parse(result.content).receipt).toMatchObject({ id: f.work.id, stopRequested: true, cleanupPending: true })
    expect(f.signals.get(f.source.id)?.aborted).toBe(false)
    expect(f.store.getTask(followUp.id).state).toBe("cancelled")
    await vi.waitFor(() => {
      expect(f.store.getTask(f.task.id).state).toBe("cancelled")
      expect(f.store.getTask(peer.id).state).toBe("cancelled")
      expect(f.store.getTask(other.task.id).state).toBe("running")
    })
    expect(f.cancelBackground).toHaveBeenCalledWith(f.work.threadId)
    expect(f.cancelBackground).not.toHaveBeenCalledWith(f.bot.threadId)
    expect(f.cancelBackground).not.toHaveBeenCalledWith(other.work.threadId)
    expect(f.store.getWork(f.bot.id, f.work.id)).toMatchObject({ state: "active", dispatchStopped: true, threadId: f.work.threadId, goal: f.work.goal })
    expect(f.store.listWorks(f.bot.id).items.find(work => work.id === f.work.id)?.dispatchStopped).toBe(true)
    expect(f.store.workSummaries(f.bot.id, [f.work.id])[0].dispatchStopped).toBe(true)
  })

  it("keeps the stop decision after an idle result, rename and restart without replaying execution", async () => {
    const f = await fixture()
    f.finishes.get(f.task.id)!({ state: "completed", result: "报告已生成" })
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("completed"))
    const changed = vi.fn()
    const unsubscribe = f.host.subscribe(changed)
    const receipt = f.stop()
    expect(receipt.stopRequested).toBe(true)
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ revision: f.store.revision() }))
    unsubscribe()
    const oldStarts = [...f.starts]
    const renamed = f.store.renameWork({ ...f.command, callId: "rename", key: "rename" }, f.work.id, receipt.version, "新报告名称")
    expect(renamed.dispatchStopped).toBe(true)
    const reopened = new BotStore(f.db)
    reopened.recover()
    expect(reopened.getWork(f.bot.id, f.work.id)).toMatchObject({ title: "新报告名称", dispatchStopped: true })
    expect(f.starts).toEqual(oldStarts)
    expect(reopened.recentTasks().some(task => task.workId === f.work.id && task.state === "queued")).toBe(false)
  })

  it("rejects stale versions and autonomous sources before cancelling anything", async () => {
    const f = await fixture()
    expect(() => f.host.stopWorkFromTool(f.command, f.work.id, f.work.version + 1)).toThrow("任务已变化")
    expect(f.store.getWork(f.bot.id, f.work.id).dispatchStopped).toBeUndefined()
    expect(f.signals.get(f.task.id)?.aborted).toBe(false)
    const routine = f.store.enqueue({ botId: f.peer.id, requestId: "routine", message: "Stop other work" }, { kind: "schedule", scheduleId: "routine" })
    f.store.transition(routine.id, "running")
    expect(() => f.store.requestWorkStop({ taskId: routine.id, callId: "x", key: "x" }, f.work.id, f.work.version)).toThrow("当前用户要求")
    expect(() => f.store.requestWorkStop({ taskId: f.task.id, callId: "x", key: "x" }, f.work.id, f.work.version)).toThrow("主对话")
    expect(f.cancelBackground).not.toHaveBeenCalled()
  })

  it("replays the same Stop receipt without changing version, but cannot stop a newer user revision", async () => {
    const f = await fixture()
    const first = f.stop()
    expect(f.stop().version).toBe(first.version)
    expect(() => f.host.stopWorkFromTool({ ...f.command, callId: "retry" }, f.work.id, f.work.version)).not.toThrow()
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("cancelled"))
    expect(() => f.host.sendWork({ ...f.command, callId: "missing-version", key: "missing-version" }, f.work.id, "继续报告"))
      .toThrow("任务已停止")
    const revised = f.host.sendWork({ ...f.command, callId: "revise", key: "revise" }, f.work.id, "继续报告", first.version)
    await vi.waitFor(() => expect(f.store.getTask(revised.id).state).toBe("running"))
    expect(f.store.getWork(f.bot.id, f.work.id).dispatchStopped).toBeUndefined()
    const cancelledBefore = f.cancelBackground.mock.calls.length
    expect(() => f.stop()).toThrow("未重复停止")
    expect(f.cancelBackground.mock.calls).toHaveLength(cancelledBefore)
    expect(f.signals.get(revised.id)?.aborted).toBe(false)
    expect(f.starts.filter(id => id === revised.id)).toHaveLength(1)
  })

  it("does not let a routine clear Stop, while explicit continue changes no execution history", async () => {
    const f = await fixture()
    const stopped = f.stop()
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("cancelled"))
    expect(() => f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "late-routine", message: "Continue" },
      { kind: "schedule", scheduleId: "routine" })).toThrow("未接受新的自动派发")
    const before = f.store.recentTasks()
    const continued = await f.host.changeWorkFromTool({ ...f.command, callId: "continue", key: "continue" }, f.work.id, stopped.version, "continue")
    expect(continued.dispatchStopped).toBeUndefined()
    expect(f.store.recentTasks()).toEqual(before)
    expect(f.store.getTask(f.task.id).state).toBe("cancelled")
  })
})
