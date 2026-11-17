import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunLease } from "./host"
import { createBotWorkTools, createBotWorkResultTools } from "./work-tools"
import * as inputFilePreparation from "./input-files"
import { buildAttachmentMessageParts } from "../../shared/attachment-message-parts"
import { BOT_ROUTINE_SILENT } from "../../shared/bots/routine-silence"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const peer = store.create({ name: "Peer", instructions: "", color: "#654321", modelRef: null })
  type Result = Awaited<ReturnType<BotRunLease["execute"]>>
  const finishes = new Map<string, (result: Result) => void>()
  const starts: string[] = []
  const signals = new Map<string, AbortSignal>()
  const injections = new Map<string, { inject: () => boolean; allowed: () => boolean }>()
  const cancelBackgroundCommands = vi.fn(), cancelBackground = vi.fn(), cancelCommands = vi.fn()
  const host = new LocalBotHost(store, {
    cancelBackgroundCommands, cancelBackground, cancelCommands,
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({
      release() {},
      steer: async (message, inject, allowed = () => true) => {
        injections.set(message.id, { inject, allowed })
        return true
      },
      execute: signal => new Promise(resolve => {
        starts.push(task.id)
        signals.set(task.id, signal)
        finishes.set(task.id, resolve)
        signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true })
      })
    })
  }, Number.POSITIVE_INFINITY)
  cleanups.push(async () => { await host.stop(); db.close() })
  const { work, task } = await host.createWork({ botId: bot.id, operationId: "create", title: "Report", goal: "Build report" })
  await vi.waitFor(() => expect(starts).toContain(task.id))
  const control = (action: "take" | "stop_and_take" | "return", operationId: string = action) => host.changeWorkControl({
    botId: bot.id, workId: work.id, action, operationId,
    ...(action === "return" && store.getWork(bot.id, work.id).userControl?.settling === false
      ? { confirmedTaskIds: host.workControlPending(bot.id, work.id).items.map(item => item.taskId) } : {}),
    expectedVersion: store.getWork(bot.id, work.id).version
  })
  return { db, store, bot, peer, host, work, task, control, starts, signals, finishes, injections, cancelBackgroundCommands, cancelBackground, cancelCommands }
}

describe("user control of Bot work", () => {
  it("stops a main conversation's retained peer command without stopping an independent work on the same Bot", async () => {
    const f = await fixture()
    const independent = f.host.delegate(f.task.id, f.peer.id, "Keep the report service running", "work-service")
    await vi.waitFor(() => expect(f.starts).toContain(independent.id))
    const command = (id: string) => ({ id, threadId: f.peer.threadId, command: "process-report", cwd: "/tmp", startedAt: 1 })
    f.host.commandLifecycle(independent.id, false).accepted(command("work-service"))
    f.finishes.get(independent.id)!({ state: "completed", result: "Service started" })
    await vi.waitFor(() => expect(f.store.getTask(independent.id).state).toBe("completed"))

    const original = f.host.send({ botId: f.bot.id, requestId: "main-delegation", message: "Check the report" })
    await vi.waitFor(() => expect(f.starts).toContain(original.id))
    const recipient = f.host.delegate(original.id, f.peer.id, "Check the report", "check-report")
    f.finishes.get(original.id)!({ state: "completed", result: "Dispatched" })
    await vi.waitFor(() => expect(f.starts).toContain(recipient.id))
    f.host.commandLifecycle(recipient.id, true).accepted(command("retained-check"))
    f.finishes.get(recipient.id)!({ state: "deferred", checkpointId: "main-peer-checkpoint" })
    await vi.waitFor(() => expect(f.store.taskCheckpoint(recipient.id)).toBe("main-peer-checkpoint"))
    f.cancelCommands.mockImplementation(async () => {
      f.host.commandLifecycle(recipient.id, true).settled({
        id: "retained-check", threadId: f.peer.threadId, exitCode: 130,
        output: "cancelled", cancelled: true, truncated: false
      })
    })

    f.host.stopConversation(f.peer.id, undefined, undefined, "background")
    await vi.waitFor(() => expect(f.store.getTask(recipient.id).state).toBe("cancelled"))
    expect(f.starts.filter(id => id === recipient.id)).toHaveLength(1)
    expect(f.cancelCommands).toHaveBeenCalledExactlyOnceWith(f.peer.threadId, ["retained-check"])
    expect(f.cancelBackground).not.toHaveBeenCalled()
    expect(f.cancelBackgroundCommands).not.toHaveBeenCalled()
    expect(f.store.activeCommandThreads()).toContain(f.peer.threadId)
    expect(f.store.getTask(independent.id).state).toBe("completed")
    expect(f.store.getTask(f.task.id).state).toBe("running")
  })

  it.each([true, false])("settles the original review according to the outcome of a pending takeover (cancel=%s)", async cancel => {
    const f = await fixture()
    f.host.recordPreparedInput(f.task.id, f.task.id, f.task.message)
    expect(f.host.armWorkResultReview(f.task.id, "original-incarnation")).toBe(true)
    expect(f.control("take").userControl?.settling).toBe(true)
    if (cancel) expect(f.control("return").userControl).toBeUndefined()
    f.finishes.get(f.task.id)!({ state: "completed", result: "Original report" })

    const resultTurns = () => f.store.recentTasks().filter(turn => turn.origin.kind === "work_result")
    if (cancel) {
      await vi.waitFor(() => expect(f.starts).toContain(resultTurns()[0]?.id))
      const [review] = resultTurns()
      expect(review.origin).toMatchObject({ review: { phase: "review", attempt: 1 } })
      expect(f.host.workResultReview(review.id)).toMatchObject({
        requestTaskId: f.task.id, executionTaskId: f.task.id, incarnation: "original-incarnation", remainingRepairs: 2
      })
      f.host.commitWorkResultReview(review.id, { kind: "ready", summary: "Verified report", evidenceIds: [] }, [])
      f.finishes.get(review.id)!({ state: "completed" })
    }
    const publication = () => resultTurns().find(turn => turn.origin.kind === "work_result" && turn.origin.review?.phase === "publish")
    await vi.waitFor(() => expect(f.starts).toContain(publication()?.id))
    expect(f.host.workResultPublication(publication()!.id)).toMatchObject({
      executionTaskId: f.task.id, kind: cancel ? "ready" : "reported",
      summary: cancel ? "Verified report" : expect.stringContaining("Original report")
    })
    expect(f.host.acknowledgeWorkResultPublication(publication()!.id)).toBe(true)
    if (!cancel) {
      expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false)
      f.control("return")
    }
    expect(f.starts.filter(id => id === f.task.id)).toHaveLength(1)
    expect(resultTurns()).toHaveLength(cancel ? 2 : 1)
  })

  it.each([true, false])("holds a repair accepted during pending takeover until the control decision (cancel=%s)", async cancel => {
    const f = await fixture()
    f.host.recordPreparedInput(f.task.id, f.task.id, f.task.message)
    expect(f.host.armWorkResultReview(f.task.id, "original-incarnation")).toBe(true)
    f.finishes.get(f.task.id)!({ state: "completed", result: "Report needs a check" })
    const reviews = () => f.store.recentTasks().filter(turn => turn.origin.kind === "work_result" && turn.origin.review?.phase === "review")
    await vi.waitFor(() => expect(f.starts).toContain(reviews()[0]?.id))
    const [review] = reviews()

    const runAt = "2030-01-01T00:00:00Z"
    const schedule = f.store.saveSchedule(f.bot.id, { name: "Routine", message: "Separate routine", frequency: "once", runAt, enabled: true }, runAt)
    const routine = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "routine", message: schedule.message },
      { kind: "schedule", scheduleId: schedule.id })
    f.host.resume()
    await vi.waitFor(() => expect(f.starts).toContain(routine.id))
    expect(f.control("take").userControl?.settling).toBe(true)

    const decision = { kind: "repair" as const, gap: "Missing check", instruction: "Check the original report", evidenceIds: [] }
    const commit = f.host.commitWorkResultReview(review.id, decision, [])
    if (commit.state !== "repair") throw new Error("Expected a queued repair")
    const { id } = commit.task
    expect(f.host.commitWorkResultReview(review.id, decision, [])).toEqual(commit)
    expect(f.store.getTask(id).state).toBe("queued")
    expect(f.store.canDispatchWorkResultRepair(id)).toBe(false)
    f.finishes.get(review.id)!({ state: "completed" })
    if (cancel) expect(f.control("return").userControl).toBeUndefined()
    f.finishes.get(routine.id)!({ state: "completed", result: BOT_ROUTINE_SILENT })

    if (cancel) {
      await vi.waitFor(() => expect(f.starts).toContain(id))
      f.finishes.get(id)!({ state: "completed", result: "Report checked" })
      const nextReview = () => reviews().find(turn => turn.id !== review.id)
      await vi.waitFor(() => expect(f.starts).toContain(nextReview()?.id))
      expect(f.host.workResultReview(nextReview()!.id)).toMatchObject({
        requestTaskId: f.task.id, executionTaskId: id, remainingRepairs: 1
      })
    } else {
      await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
      expect(f.control("return").userControl).toBeUndefined()
      expect(f.store.getTask(id).state).toBe("cancelled")
      expect(f.store.canDispatchWorkResultRepair(id)).toBe(false)
    }
    expect(f.starts.filter(started => started === id)).toHaveLength(cancel ? 1 : 0)
  })

  it("keeps the desktop composer closed until the original execution finishes handing over", async () => {
    const f = await fixture()
    const input = { botId: f.bot.id, workId: f.work.id, requestId: "manual-desktop", message: "Correct the report" }
    const skill = { ...input, requestId: "manual-desktop-skill", explicitSkill: { name: "review", path: "/registered/review/SKILL.md" } }
    expect(() => f.host.sendDesktopMessage(input)).toThrow("先获取控制权")
    expect(f.control("take").userControl?.settling).toBe(true)
    expect(() => f.host.sendDesktopMessage(input)).toThrow("等待原任务结算")
    expect(() => f.host.sendDesktopMessage(skill)).toThrow("等待原任务结算")
    f.finishes.get(f.task.id)!({ state: "completed", result: "Report ready" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    const legacyResult = f.store.recentTasks().find(turn => turn.origin.kind === "work_result" &&
      turn.origin.executionTaskId === f.task.id && !turn.origin.review)
    expect(legacyResult).toBeDefined()
    expect(f.starts).toContain(legacyResult!.id)
    const accepted = await f.host.sendDesktopMessage(skill)
    expect(accepted).toMatchObject({ workId: f.work.id, threadId: f.work.threadId,
      origin: { kind: "user", explicitSkill: skill.explicitSkill } })
    await vi.waitFor(() => expect(f.starts).toContain(accepted.id))
    expect(f.store.recentTasks().filter(task => task.requestId === input.requestId)).toHaveLength(0)
  })

  it("rechecks takeover after selected-skill attachment verification before admitting the input", async () => {
    const f = await fixture()
    f.control("take")
    f.finishes.get(f.task.id)!({ state: "completed", result: "Report ready" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    const attachment = f.host.retainInputFile(f.bot.id, {
      filename: "sample.txt", filePath: "/selected/sample.txt", content: "approved sample",
      mimeType: "text/plain", size: 15, truncated: false
    }, "/snapshots/.bot-deliveries/" + "a".repeat(64) + "/sample.txt", f.work.id)
    let finishVerification!: () => void
    const verification = vi.spyOn(inputFilePreparation, "verifyInputFiles").mockImplementationOnce(
      () => new Promise(resolve => { finishVerification = resolve })
    )
    try {
      const input = { botId: f.bot.id, workId: f.work.id, requestId: "skill-after-return",
        message: "Review" + buildAttachmentMessageParts([attachment]).attachmentModelBlocks,
        explicitSkill: { name: "review", path: "/registered/review/SKILL.md" }, inputFileIds: [attachment.botInputId!] }
      const pending = f.host.sendDesktopMessage(input) as Promise<unknown>
      expect(verification).toHaveBeenCalledOnce()
      f.control("return")
      finishVerification()
      await expect(pending).rejects.toThrow("先获取控制权")
      expect(f.store.recentTasks().some(task => task.requestId === input.requestId)).toBe(false)
    } finally {
      finishVerification?.()
      verification.mockRestore()
    }
  })

  it("requires the exact held list on return, so superseded instructions can be withdrawn first", async () => {
    const f = await fixture()
    const superseded = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "old-check", message: "Run the expensive check" })
    const retained = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "keep-summary", message: "Summarize the existing report" })
    f.control("take")
    f.finishes.get(f.task.id)!({ state: "completed", result: "Report ready" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    const correction = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "correction", message: "Cancel the expensive check; keep the summary" })
    await vi.waitFor(() => expect(f.starts).toContain(correction.id))
    f.finishes.get(correction.id)!({ state: "completed", result: "Correction noted" })
    await vi.waitFor(() => expect(f.store.getTask(correction.id).state).toBe("completed"))
    const pending = f.host.workControlPending(f.bot.id, f.work.id)
    expect(pending.items.map(item => item.taskId).sort()).toEqual([superseded.id, retained.id].sort())
    const returning = { botId: f.bot.id, workId: f.work.id, expectedVersion: pending.version, action: "return" as const, operationId: "reviewed-return" }
    expect(() => f.host.changeWorkControl(returning)).toThrow("核对")
    expect(f.store.getWork(f.bot.id, f.work.id).userControl).toBeDefined()
    expect(f.starts).not.toContain(superseded.id)
    f.host.cancel(superseded.id)
    const refreshed = f.host.workControlPending(f.bot.id, f.work.id)
    expect(refreshed.items.map(item => item.taskId)).toEqual([retained.id])
    const accepted = { ...returning, expectedVersion: refreshed.version, confirmedTaskIds: [retained.id] }
    f.host.changeWorkControl(accepted)
    // A lost UI acknowledgement resolves the same receipt, never requeues either task.
    f.host.changeWorkControl(accepted)
    await vi.waitFor(() => expect(f.starts.filter(id => id === retained.id)).toHaveLength(1))
    expect(f.starts).not.toContain(superseded.id)
    expect(f.store.getTask(superseded.id).state).toBe("cancelled")
  })

  it("refuses a return confirmation if another held routine arrived while the list was open", async () => {
    const f = await fixture()
    f.control("take")
    f.finishes.get(f.task.id)!({ state: "completed", result: "Ready" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    const observed = f.host.workControlPending(f.bot.id, f.work.id)
    const routine = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "late-routine", message: "Read current status" },
      { kind: "schedule", scheduleId: "synthetic-schedule" })
    const returning = { botId: f.bot.id, workId: f.work.id, action: "return" as const,
      operationId: "stale-return", expectedVersion: observed.version, confirmedTaskIds: [] }
    expect(() => f.host.changeWorkControl(returning)).toThrow("任务已变化")
    expect(() => f.host.changeWorkControl({ ...returning, expectedVersion: f.store.getWork(f.bot.id, f.work.id).version })).toThrow("核对")
    expect(f.starts).not.toContain(routine.id)
    expect(f.store.getWork(f.bot.id, f.work.id).userControl).toBeDefined()
  })

  it("expands only an exact still-held instruction, preserving its full constraints", async () => {
    const f = await fixture()
    const message = "Reference material. ".repeat(100) + "Do not modify any source files."
    const held = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "long-held", message })
    f.control("take")
    f.finishes.get(f.task.id)!({ state: "completed" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.host.workControlPending(f.bot.id, f.work.id).items[0]).toMatchObject({ taskId: held.id, truncated: true })
    expect(f.host.workControlPending(f.bot.id, f.work.id, held.id).items).toEqual([{ taskId: held.id, message, truncated: false }])
    expect(() => f.host.workControlPending(f.bot.id, f.work.id, f.task.id)).toThrow("待办已变化")
    f.host.cancel(held.id)
    expect(() => f.host.workControlPending(f.bot.id, f.work.id, held.id)).toThrow("待办已变化")
  })

  it("projects attachment names before truncating a held work instruction", async () => {
    const f = await fixture()
    const filePath = "/fixture/.bot-deliveries/report/Report.txt"
    const attachment = f.host.retainInputFile(f.bot.id, {
      filename: "Report.txt", filePath, content: "Extracted attachment content. ".repeat(100),
      mimeType: "text/plain", size: 3000, truncated: false
    }, filePath)
    const source = f.host.send({ botId: f.bot.id, requestId: "attach-to-work", inputFileIds: [attachment.botInputId!],
      message: "Review the report" + buildAttachmentMessageParts([attachment]).attachmentModelBlocks })
    await vi.waitFor(() => expect(f.starts).toContain(source.id))
    f.host.recordPreparedInput(source.id, source.id, source.message)
    const instruction = "Review the attached report without changing it."
    const held = f.host.sendWork({ taskId: source.id, callId: "forward", key: "forward" },
      f.work.id, instruction, undefined, [attachment.botInputId!])
    expect(held.message.length).toBeGreaterThan(1200)

    f.control("take")
    f.finishes.get(f.task.id)!({ state: "completed" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    const expected = [{ taskId: held.id, message: `📎 Report.txt\n\n${instruction}\n\n原要求：\nReview the report`, truncated: false }]
    expect(f.host.workControlPending(f.bot.id, f.work.id).items).toEqual(expected)
    expect(expected[0].message).not.toContain("Host")
    expect(f.store.getTask(held.id).message).toBe(held.message)
    expect(f.host.workControlPending(f.bot.id, f.work.id, held.id).items).toEqual(expected)
    f.control("return")
    await vi.waitFor(() => expect(f.starts).toContain(held.id))
    expect(f.store.getTask(held.id)).toMatchObject({ requestId: held.requestId, message: held.message })
  })

  it("holds the original queued supplement without stopping the run; returning resumes the same receipt once", async () => {
    const f = await fixture()
    const queued = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "extra", message: "Add appendix" })
    const other = await f.host.createWork({ botId: f.bot.id, operationId: "other", title: "Other", goal: "Keep running" })
    expect(f.control("take").userControl).toEqual({ settling: true, heldInputs: 1 })
    expect(f.signals.get(f.task.id)?.aborted).toBe(false)
    expect(f.store.getTask(queued.id).state).toBe("queued")
    expect(() => f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "too-early", message: "User edit" })).toThrow("等待原任务结算")
    f.finishes.get(f.task.id)!({ state: "completed", result: "Done" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.starts).not.toContain(queued.id)
    expect(f.store.getTask(other.task.id).state).toBe("running")
    const direct = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "user-edit", message: "Manual addition" })
    await vi.waitFor(() => expect(f.starts).toContain(direct.id))
    f.finishes.get(direct.id)!({ state: "completed", result: "Manual done" })
    await vi.waitFor(() => expect(f.store.getTask(direct.id).state).toBe("completed"))
    expect(f.control("return").userControl).toBeUndefined()
    await vi.waitFor(() => expect(f.starts.filter(id => id === queued.id)).toHaveLength(1))
    expect(f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "extra", message: "Add appendix" }).id).toBe(queued.id)
  })

  it("stops a manual reply without withdrawing the held supplement; work Stop still cancels it", async () => {
    const f = await fixture()
    const held = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "held-extra", message: "Add appendix" })
    f.control("take")
    f.finishes.get(f.task.id)!({ state: "completed", result: "Done" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    const manual = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "manual-cancel", message: "Manual reply" })
    await vi.waitFor(() => expect(f.starts).toContain(manual.id))
    f.host.cancel(manual.id)
    await vi.waitFor(() => expect(f.store.getTask(manual.id).state).toBe("cancelled"))
    expect(f.store.getTask(held.id).state).toBe("queued")
    expect(f.host.workControlPending(f.bot.id, f.work.id).items).toEqual([{ taskId: held.id, message: "Add appendix", truncated: false }])
    expect(f.starts).not.toContain(held.id)
    f.control("return")
    await vi.waitFor(() => expect(f.starts.filter(id => id === held.id)).toHaveLength(1))
    const secondHeld = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "second-held", message: "Second appendix" })
    f.control("take", "take-after-reply-stop")
    f.host.stopWork(f.bot.id, f.work.id)
    expect(f.store.getTask(secondHeld.id).state).toBe("cancelled")
  })

  it.each(["original", "taking control", "background callback"] as const)(
    "reports the retained file when stopping the %s reply and leaves unrelated work active", async scenario => {
    const f = await fixture()
    f.host.recordPreparedInput(f.task.id, f.task.id, f.task.message)
    expect(f.host.armWorkResultReview(f.task.id, "original-incarnation")).toBe(true)
    const file = { name: "report.txt", filePath: "/work/report.txt", attachmentPath: "/saved/report.txt", size: 5 }
    let stopped = f.task
    if (scenario === "background callback") {
      f.host.recordWorkResultEvidence(f.task.id, { callId: "first", files: [{ ...file, size: 3, attachmentPath: "/saved/old/report.txt" }] })
      const lifecycle = f.host.commandLifecycle(f.task.id)
      lifecycle.accepted({ id: "finite-check", threadId: f.work.threadId, command: "check report", cwd: "/synthetic", startedAt: 1 })
      f.finishes.get(f.task.id)!({ state: "completed", result: "Check started" })
      await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("completed"))
      lifecycle.settled({ id: "finite-check", threadId: f.work.threadId, output: "CHECKED", exitCode: 0, cancelled: false, truncated: false })
      const callback = () => f.store.pendingWorkFamily(f.bot.id, f.work.id).find(task => task.origin.kind === "notification")
      await vi.waitFor(() => expect(f.starts).toContain(callback()?.id))
      stopped = callback()!
    }
    f.host.recordWorkResultEvidence(stopped.id, { callId: "delivered", files: [file] })
    if (scenario === "taking control") expect(f.control("take").userControl?.settling).toBe(true)
    const other = await f.host.createWork({ botId: f.bot.id, operationId: "other", title: "Other", goal: "Keep working" })
    await vi.waitFor(() => expect(f.starts).toContain(other.task.id))

    f.host.cancel(stopped.id)
    f.host.cancel(stopped.id)

    await vi.waitFor(() => expect(f.store.getTask(stopped.id).state).toBe("cancelled"))
    const publications = () => f.store.recentTasks()
      .filter(task => task.origin.kind === "work_result" && task.origin.review?.phase === "publish")
    await vi.waitFor(() => expect(f.starts).toContain(publications()[0]?.id))
    expect(publications()).toHaveLength(1)
    expect(f.host.workResultPublication(publications()[0].id)).toMatchObject({
      executionTaskId: f.task.id, kind: "blocked", attachments: [{ sourceTaskId: stopped.id, file }]
    })
    expect(f.signals.get(other.task.id)?.aborted).toBe(false)
    if (scenario === "taking control")
      await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
  })

  it("does not retire a new instruction's result review when stopping a stale peer reply", async () => {
    const f = await fixture()
    f.host.recordPreparedInput(f.task.id, f.task.id, f.task.message)
    expect(f.host.armWorkResultReview(f.task.id, "original-incarnation")).toBe(true)
    const peer = f.host.delegate(f.task.id, f.peer.id, "Review the old format", "old-format")
    await vi.waitFor(() => expect(f.starts).toContain(peer.id))
    f.host.onSteeringReady(f.task.id)
    const supplement = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "new-format", message: "Use the new format" })
    await vi.waitFor(() => expect(f.injections.has(supplement.id)).toBe(true))
    f.host.recordPreparedInput(f.task.id, supplement.id, supplement.message)
    expect(f.injections.get(supplement.id)!.inject()).toBe(true)
    f.host.recordWorkResultEvidence(f.task.id, { callId: "new-format", files: [
      { name: "new.txt", filePath: "/work/new.txt", attachmentPath: "/saved/new.txt", size: 5 }
    ] })
    f.finishes.get(f.task.id)!({ state: "completed", result: "New format ready" })
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("completed"))
    f.finishes.get(peer.id)!({ state: "completed", result: "Old format reviewed" })
    const callback = () => f.store.pendingWorkFamily(f.bot.id, f.work.id)
      .find(task => task.workId === f.work.id && task.origin.kind === "bot" && !task.origin.expectsReply)
    await vi.waitFor(() => expect(f.starts).toContain(callback()?.id))

    const stopped = callback()!
    f.host.cancel(stopped.id)
    await vi.waitFor(() => expect(f.store.getTask(stopped.id).state).toBe("cancelled"))
    const review = () => f.store.recentTasks().find(task => task.origin.kind === "work_result" && task.origin.review?.phase === "review")
    await vi.waitFor(() => expect(f.starts).toContain(review()?.id))
    expect(f.host.workResultReview(review()!.id)?.requests.map(request => request.text)).toContain(supplement.message)
  })

  it("does not hold necessary peer settlement and waits for the already dispatched peer", async () => {
    const f = await fixture()
    const peer = f.host.delegate(f.task.id, f.peer.id, "Check report", "review")
    f.control("take")
    await vi.waitFor(() => expect(f.starts).toContain(peer.id))
    f.finishes.get(f.task.id)!({ state: "completed", result: "Dispatched" })
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("completed"))
    expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(true)
    f.finishes.get(peer.id)!({ state: "completed", result: "Checked" })
    await vi.waitFor(() => expect(f.store.pendingWorkFamily(f.bot.id, f.work.id).some(t => t.origin.kind === "bot" && !t.origin.expectsReply)).toBe(true))
    const reply = f.store.pendingWorkFamily(f.bot.id, f.work.id).find(t => t.origin.kind === "bot" && !t.origin.expectsReply)!
    await vi.waitFor(() => expect(f.starts).toContain(reply.id))
    f.finishes.get(reply.id)!({ state: "completed", result: "Review received" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.signals.get(peer.id)?.aborted).toBe(false)
  })

  it("rejects new automatic assignments, preserves explicit Stop, and checks operation identity", async () => {
    const f = await fixture()
    const request = { botId: f.bot.id, workId: f.work.id, expectedVersion: f.work.version, operationId: "take-once", action: "take" as const }
    const taken = f.host.changeWorkControl(request)
    expect(f.host.changeWorkControl(request).version).toBe(taken.version)
    expect(() => f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: "auto", message: "Run" }, { kind: "work", sourceTaskId: f.task.id, dispatch: "follow_up" })).toThrow("用户接管")
    expect(() => f.host.changeWorkControl({ ...request, operationId: "stale" })).toThrow("任务已变化")
    f.host.stopWork(f.bot.id, f.work.id)
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("cancelled"))
    f.control("return")
    expect(f.store.getWork(f.bot.id, f.work.id).dispatchStopped).toBe(true)
    expect(() => f.host.changeWorkControl(request)).toThrow("状态后来已变化")
    expect(f.store.getWork(f.bot.id, f.work.id).userControl).toBeUndefined()
    expect(f.store.getTask(f.task.id).state).toBe("cancelled")
  })

  it("prevents an already prepared supplement from injecting after take, without changing unrelated chat", async () => {
    const f = await fixture()
    f.host.onSteeringReady(f.task.id)
    const queued = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "prepared", message: "Add section" })
    await vi.waitFor(() => expect(f.injections.has(queued.id)).toBe(true))
    const prepared = f.injections.get(queued.id)!
    expect(prepared.allowed()).toBe(true)
    f.control("take")
    expect(prepared.allowed()).toBe(false)
    expect(prepared.inject()).toBe(false)
    f.control("return")
    expect(prepared.allowed()).toBe(false)
    expect(prepared.inject()).toBe(false)
    expect(f.store.getTask(queued.id).state).toBe("queued")
    const main = f.host.send({ botId: f.bot.id, requestId: "main", message: "Hello" })
    await vi.waitFor(() => expect(f.starts).toContain(main.id))
    expect(f.signals.get(f.task.id)?.aborted).toBe(false)
  })

  it("retains control and queued request identities across Store reconstruction", async () => {
    const f = await fixture()
    const queued = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "saved", message: "Saved input" })
    f.control("take")
    const restored = new BotStore(f.db)
    expect(restored.getWork(f.bot.id, f.work.id).userControl).toEqual({ settling: true, heldInputs: 1 })
    expect(restored.workDispatchToken(queued.id)).toBeNull()
    expect(restored.getTask(queued.id)).toMatchObject({ requestId: "saved", state: "queued", message: "Saved input" })
    expect(restored.workSummaries(f.bot.id, [f.work.id])[0].userControl?.heldInputs).toBe(1)
    expect(restored.listWorks(f.bot.id).items[0].userControl?.settling).toBe(true)
  })

  it("waits for a completed dispatcher's background result and its actual receipt turn", async () => {
    const f = await fixture()
    const lifecycle = f.host.commandLifecycle(f.task.id)
    lifecycle.accepted({ id: "finite-command", threadId: f.work.threadId, command: "check report", cwd: "/synthetic", startedAt: 1 })
    f.finishes.get(f.task.id)!({ state: "completed", result: "Check started" })
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("completed"))
    expect(f.control("take").userControl?.settling).toBe(true)
    lifecycle.settled({ id: "finite-command", threadId: f.work.threadId, output: "CHECKED", exitCode: 0, cancelled: false, truncated: false })
    await vi.waitFor(() => expect(f.store.pendingWorkFamily(f.bot.id, f.work.id).some(t => t.origin.kind === "notification")).toBe(true))
    const receipt = f.store.pendingWorkFamily(f.bot.id, f.work.id).find(t => t.origin.kind === "notification")!
    await vi.waitFor(() => expect(f.starts).toContain(receipt.id))
    expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(true)
    f.finishes.get(receipt.id)!({ state: "completed", result: "Check received" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.starts.filter(id => id === receipt.id)).toHaveLength(1)
  })

  it.each([
    { held: false, kind: "ready" }, { held: true, kind: "ready" },
    { held: true, kind: "blocked" }, { held: true, kind: "repair" },
    { held: false, kind: "needs_user" }, { held: false, kind: "needs_user", earlierProof: true },
    { held: false, kind: "needs_user", earlierProof: true, badBinding: true, takeAfter: true },
    { held: false, kind: "ready", offline: true },
    { held: false, kind: "ready", pressure: "foreground" },
    { held: false, kind: "ready", pressure: "background" },
    { held: false, kind: "blocked", takeAfter: true }
  ] as const)("settles live service evidence for control: %o", async scenario => {
    const { held, kind } = scenario
    const earlierProof = "earlierProof" in scenario
    const pressure = "pressure" in scenario ? scenario.pressure : undefined
    const takeAfter = "takeAfter" in scenario
    const f = await fixture()
    f.host.recordPreparedInput(f.task.id, f.task.id, "Keep the checked preview running")
    expect(f.host.armWorkResultReview(f.task.id, "original-incarnation")).toBe(true)
    const lifecycle = f.host.commandLifecycle(f.task.id)
    lifecycle.accepted({ id: "preview", threadId: f.work.threadId, command: "node preview.mjs",
      cwd: "/synthetic", startedAt: 1, notifyOnComplete: false })
    const foreground = (id: string, ok: boolean, startedAt = 2) => f.host.recordWorkResultEvidence(f.task.id,
      { foregroundCommand: { callId: id, command: "node check.mjs", exactCommand: true,
        startedAt, exitCode: ok ? 0 : 1, output: ok ? "Expected preview; HTTP 200" : "Later error",
        excerpt: false } })
    const background = (id: string, ok: boolean) => {
      lifecycle.accepted({ id, threadId: f.work.threadId, command: "node check.mjs", cwd: "/synthetic",
        startedAt: 2, notifyOnComplete: false })
      lifecycle.settled({ id, threadId: f.work.threadId, output: ok ? "Expected preview; HTTP 200" : "Later error",
        exitCode: ok ? 0 : 1, cancelled: false, truncated: false })
    }
    if (pressure === "background") {
      background("z-health", true)
      for (let i = 0; i < 9; i++) background(`later-${i}`, false)
    } else {
      foreground("health", true)
      if (pressure === "foreground") for (let i = 0; i < 8; i++) foreground(`later-${i}`, false)
    }
    if ("badBinding" in scenario) foreground("before-service", true, 0)
    const followUp = held ? f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "hold-follow-up",
      message: "Add an independent appendix" }) : undefined
    if (!takeAfter) expect(f.control("take").userControl?.settling).toBe(true)
    f.finishes.get(f.task.id)!({ state: "completed", result: "Preview running" })
    const review = () => f.store.recentTasks().find(task => task.origin.kind === "work_result" && task.origin.review?.phase === "review")
    await vi.waitFor(() => expect(f.starts).toContain(review()?.id))
    expect(Boolean(f.store.getWork(f.bot.id, f.work.id).userControl?.settling)).toBe(!takeAfter)
    const evidenceId = "a".repeat(64)
    const priorCheckId = "b".repeat(64)
    const reviewId = review()!.id
    const context = f.host.workResultReview(reviewId)
    expect(context).toMatchObject({ settlingForServices: !takeAfter, remainingRepairs: takeAfter ? 2 : 0 })
    if (pressure === "foreground") {
      const receipts = context!.evidence.find(item => item.taskId === f.task.id)?.foregroundCommands
      expect(receipts?.map(item => item.callId)).toEqual(["health", ...Array.from({ length: 7 }, (_, i) => `later-${i + 1}`)])
    }
    if (pressure === "background") {
      expect(context?.commands).toHaveLength(9)
      expect(context?.commands[0]?.id).toBe("z-health")
    }
    const decision = kind === "repair"
      ? { kind, gap: "Missing URL in report", instruction: "Add the URL", evidenceIds: [] }
      : { kind, summary: kind === "ready" ? "Live preview checked" : "Missing URL in report",
          evidenceIds: [evidenceId], serviceIds: "offline" in scenario ? [] : ["preview"], serviceChecks: { preview: evidenceId } }
    const originalCheck = { evidenceId, sourceTaskId: f.task.id, ...(pressure === "background"
      ? { kind: "background" as const, commandId: "z-health" }
      : { kind: "foreground" as const, callId: "health" }) }
    const staleBinding = "badBinding" in scenario ? { evidenceIds: [priorCheckId], serviceChecks: { preview: priorCheckId } } : {}
    const outcome = f.host.commitWorkResultReview(reviewId,
      earlierProof ? { kind: "needs_user", summary: "Which source should be used?", evidenceIds: [], ...staleBinding } : decision, [],
      kind === "repair" ? [] : [originalCheck, ...("badBinding" in scenario ?
        [{ evidenceId: priorCheckId, sourceTaskId: f.task.id, kind: "foreground" as const, callId: "before-service" }] : [])],
      earlierProof ? { decision: { kind: "blocked", summary: "Preview checked", evidenceIds: [evidenceId],
        serviceChecks: { preview: evidenceId } }, attachments: [] } : undefined)
    expect(outcome).toMatchObject({
      state: "publish", publication: { kind: kind === "repair" ? "blocked" : kind,
        ...("offline" in scenario ? { serviceIds: [] } : {}),
        ...(earlierProof ? { summary: "Which source should be used?" } : {}) }
    })
    f.finishes.get(reviewId)!({ state: "completed" })
    if (takeAfter) {
      const publication = () => f.store.recentTasks().find(t => t.origin.kind === "work_result" && t.origin.review?.phase === "publish")
      await vi.waitFor(() => expect(f.starts).toContain(publication()?.id))
      expect(f.host.acknowledgeWorkResultPublication(publication()!.id)).toBe(true)
      f.finishes.get(publication()!.id)!({ state: "completed" })
      f.control("take")
    }
    if (kind === "repair") {
      expect(outcome).toMatchObject({ publication: { summary: expect.stringContaining("Missing URL in report") } })
      expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(true)
    } else await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.store.activeCommandThreads()).toContain(f.work.threadId)
    expect(f.cancelBackgroundCommands).not.toHaveBeenCalled()
    expect(f.store.recentTasks().some(task => task.origin.kind === "work" && task.origin.dispatch === "repair")).toBe(false)
    if (followUp) expect(f.store.getTask(followUp.id).state).toBe("queued")
  })

  it("does not treat suppression as proof that an unexited command is a ready service", async () => {
    const f = await fixture()
    const lifecycle = f.host.commandLifecycle(f.task.id)
    lifecycle.accepted({ id: "suppressed-command", threadId: f.work.threadId, command: "service", cwd: "/synthetic", startedAt: 1, notifyOnComplete: false })
    f.finishes.get(f.task.id)!({ state: "completed", result: "Started" })
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("completed"))
    expect(f.control("take").userControl?.settling).toBe(true)
    lifecycle.settled({ id: "suppressed-command", threadId: f.work.threadId, output: "Stopped", exitCode: 0, cancelled: false, truncated: false })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.store.pendingWorkFamily(f.bot.id, f.work.id)).toEqual([])
  })

  it("keeps a completed turn's verified service through takeover and stops it on whole-work Stop", async () => {
    const f = await fixture()
    const lifecycle = f.host.commandLifecycle(f.task.id)
    lifecycle.accepted({ id: "server", threadId: f.work.threadId, command: "node server.mjs", cwd: "/synthetic", startedAt: 1, notifyOnComplete: false })
    lifecycle.accepted({ id: "health", threadId: f.work.threadId, command: "node check-health.mjs", cwd: "/synthetic", startedAt: 2, notifyOnComplete: false })
    lifecycle.settled({ id: "health", threadId: f.work.threadId, output: "HTTP 200; expected service id matched", exitCode: 0, cancelled: false, truncated: false })
    const tool = createBotWorkTools(f.task, () => f.host, new AbortController().signal).find(tool => tool.name === "bot_work_keep_service")!
    const result = await tool.invoke({ type: "tool_call", id: "keep-server", name: tool.name,
      args: { serviceId: "server", checkId: "health", reason: "原要求保留本地预览；HTTP 响应与服务标识已核验。" } }) as { status?: string; content: string }
    expect(result.status).not.toBe("error")
    expect(JSON.parse(result.content).receipt.readiness).toMatchObject({ checkId: "health", result: { exitCode: 0 } })
    f.control("take")
    f.finishes.get(f.task.id)!({ state: "completed", result: "Preview ready" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.store.activeCommandThreads()).toContain(f.work.threadId)
    expect(f.cancelBackgroundCommands).not.toHaveBeenCalled()
    expect(f.store.getWork(f.bot.id, f.work.id).backgroundBusy).toBe(true)
    const service = () => f.db.exec("SELECT state,suppressed,service_ready_json IS NOT NULL FROM bot_commands WHERE id='server'")[0].values
    const readyService = service()
    expect(readyService[0][0]).toBe("accepted")
    expect(readyService[0][2]).toBe(1)
    const manual = f.host.send({ botId: f.bot.id, workId: f.work.id,
      requestId: "manual-service-check", message: "Check a separate build" })
    expect(f.store.getTask(manual.id).state).toBe("queued")
    expect(() => f.host.stopConversation(f.bot.id, undefined, f.work.id, "background")).toThrow("任务状态已变化")
    expect(f.store.getTask(manual.id).state).toBe("queued")
    await vi.waitFor(() => expect(f.starts).toContain(manual.id))
    const manualCommands = f.host.commandLifecycle(manual.id)
    manualCommands.accepted({ id: "manual-build", threadId: f.work.threadId, command: "build report", cwd: "/synthetic", startedAt: 3 })
    expect(() => f.host.stopConversation(f.bot.id, undefined, f.work.id, "background")).toThrow("任务状态已变化")
    expect(f.signals.get(manual.id)?.aborted).toBe(false)
    expect(service()).toEqual(readyService)
    f.host.cancel(manual.id)
    await vi.waitFor(() => expect(f.store.getTask(manual.id).state).toBe("cancelled"))
    expect(f.cancelCommands).toHaveBeenCalledWith(f.work.threadId, ["manual-build"])
    expect(f.cancelBackground).not.toHaveBeenCalled()
    expect(service()).toEqual(readyService)
    manualCommands.settled({ id: "manual-build", threadId: f.work.threadId, output: "Stopped", exitCode: 143, cancelled: true, truncated: false })
    f.host.cancel(manual.id) // An already rendered Stop can arrive after its reply settles.
    expect(service()).toEqual(readyService)
    expect(f.cancelBackground).not.toHaveBeenCalled()
    f.control("return")

    const next = f.host.send({ botId: f.bot.id, workId: f.work.id,
      requestId: "next-build", message: "Build the report and leave the preview running" })
    await vi.waitFor(() => expect(f.starts).toContain(next.id))
    const build = f.host.commandLifecycle(next.id)
    build.accepted({ id: "finite-build", threadId: f.work.threadId, command: "build report", cwd: "/synthetic", startedAt: 3 })
    expect(f.control("take", "take-during-build").userControl?.settling).toBe(true)
    f.control("stop_and_take")
    expect(f.signals.get(next.id)?.aborted).toBe(true)
    await vi.waitFor(() => expect(f.store.getTask(next.id).state).toBe("cancelled"))
    expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(true)
    build.settled({ id: "finite-build", threadId: f.work.threadId, output: "Stopped", exitCode: 143, cancelled: true, truncated: false })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.cancelBackgroundCommands).not.toHaveBeenCalled()
    expect(f.store.activeCommandThreads()).toContain(f.work.threadId)
    expect(f.store.getWork(f.bot.id, f.work.id).backgroundBusy).toBe(true)

    f.host.stopWork(f.bot.id, f.work.id)
    expect(f.cancelBackground).toHaveBeenCalledWith(f.work.threadId)
    expect(f.store.getWork(f.bot.id, f.work.id).dispatchStopped).toBe(true)
    lifecycle.settled({ id: "server", threadId: f.work.threadId, output: "Stopped", exitCode: 143, cancelled: true, truncated: false })
    expect(f.store.activeCommandThreads()).not.toContain(f.work.threadId)
  })

  it("rejects unverified, failed, older, finite and foreign readiness references", async () => {
    const f = await fixture()
    const lifecycle = f.host.commandLifecycle(f.task.id)
    lifecycle.accepted({ id: "before", threadId: f.work.threadId, command: "old health check", cwd: "/synthetic", startedAt: 1, notifyOnComplete: false })
    lifecycle.settled({ id: "before", threadId: f.work.threadId, output: "old success", exitCode: 0, cancelled: false, truncated: false })
    lifecycle.accepted({ id: "service", threadId: f.work.threadId, command: "server", cwd: "/synthetic", startedAt: 2, notifyOnComplete: false })
    lifecycle.accepted({ id: "finite", threadId: f.work.threadId, command: "build", cwd: "/synthetic", startedAt: 2 })
    lifecycle.accepted({ id: "bad-check", threadId: f.work.threadId, command: "check", cwd: "/synthetic", startedAt: 3, notifyOnComplete: false })
    const mark = (service: string, check: string) => f.host.retainReadyWorkService(f.task.id, service, check, "Keep preview requested by user")
    expect(() => mark("service", "bad-check")).toThrow("成功就绪检查")
    lifecycle.settled({ id: "bad-check", threadId: f.work.threadId, output: "not ready", exitCode: 1, cancelled: false, truncated: false })
    expect(() => mark("service", "bad-check")).toThrow("仍需核验")
    lifecycle.accepted({ id: "quiet", threadId: f.work.threadId, command: "curl -s -o /dev/null http://localhost:1234/health",
      cwd: "/synthetic", startedAt: 3, notifyOnComplete: false })
    lifecycle.settled({ id: "quiet", threadId: f.work.threadId, output: "<no output>", exitCode: 0, cancelled: false, truncated: false })
    expect(() => mark("service", "quiet")).toThrow("仍需核验")
    expect(() => mark("service", "before")).toThrow("成功就绪检查")
    expect(() => mark("finite", "bad-check")).toThrow("成功就绪检查")
    const other = await f.host.createWork({ botId: f.bot.id, operationId: "other-service", title: "Other", goal: "Other service" })
    await vi.waitFor(() => expect(f.starts).toContain(other.task.id))
    const foreign = f.host.commandLifecycle(other.task.id)
    foreign.accepted({ id: "foreign-check", threadId: other.work.threadId, command: "check", cwd: "/synthetic", startedAt: 3, notifyOnComplete: false })
    foreign.settled({ id: "foreign-check", threadId: other.work.threadId, output: "ok", exitCode: 0, cancelled: false, truncated: false })
    expect(() => mark("service", "foreign-check")).toThrow("成功就绪检查")
    f.host.cancel(f.task.id)
    expect(() => mark("service", "before")).toThrow("当前执行已停止")
  })

  it("stops only the accepted execution and peers, keeping held supplements and another work alive", async () => {
    const f = await fixture()
    const peer = f.host.delegate(f.task.id, f.peer.id, "Review", "review-stop")
    const held = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "held-stop", message: "Keep appendix" })
    const other = await f.host.createWork({ botId: f.bot.id, operationId: "unrelated", title: "Other", goal: "Continue" })
    await vi.waitFor(() => expect(f.starts).toContain(peer.id))
    f.control("take")
    const request = { botId: f.bot.id, workId: f.work.id, action: "stop_and_take" as const,
      operationId: "stop-exact", expectedVersion: f.store.getWork(f.bot.id, f.work.id).version }
    f.host.changeWorkControl(request)
    expect(f.signals.get(f.task.id)?.aborted).toBe(true)
    expect(f.signals.get(peer.id)?.aborted).toBe(true)
    expect(f.cancelBackground).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.store.getTask(held.id).state).toBe("queued")
    expect(f.store.getWork(f.bot.id, f.work.id).dispatchStopped).toBeUndefined()
    expect(f.store.getTask(other.task.id).state).toBe("running")
    // Replaying this exact request cannot stop a new manual turn after control is ready.
    const manual = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "manual-after-stop", message: "My next instruction" })
    await vi.waitFor(() => expect(f.starts).toContain(manual.id))
    f.host.changeWorkControl(request)
    expect(f.signals.get(manual.id)?.aborted).toBe(false)
    f.finishes.get(manual.id)!({ state: "completed" })
    await vi.waitFor(() => expect(f.store.getTask(manual.id).state).toBe("completed"))
    f.control("return")
    await vi.waitFor(() => expect(f.starts.filter(id => id === held.id)).toHaveLength(1))
    expect(f.starts.filter(id => id === f.task.id)).toHaveLength(1)
  })

  it("waits for physical cleanup of a completed owner's command and cancels an already started receipt", async () => {
    const f = await fixture()
    const lifecycle = f.host.commandLifecycle(f.task.id)
    lifecycle.accepted({ id: "old-service", threadId: f.work.threadId, command: "service", cwd: "/synthetic", startedAt: 1, notifyOnComplete: false })
    lifecycle.accepted({ id: "old-check", threadId: f.work.threadId, command: "check", cwd: "/synthetic", startedAt: 2 })
    f.finishes.get(f.task.id)!({ state: "completed", result: "Started" })
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe("completed"))
    lifecycle.settled({ id: "old-check", threadId: f.work.threadId, output: "checked", exitCode: 0, cancelled: false, truncated: false })
    await vi.waitFor(() => expect(f.store.pendingWorkFamily(f.bot.id, f.work.id).some(task => task.origin.kind === "notification")).toBe(true))
    const receipt = f.store.pendingWorkFamily(f.bot.id, f.work.id).find(task => task.origin.kind === "notification")!
    await vi.waitFor(() => expect(f.starts).toContain(receipt.id))
    const held = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "held-receipt", message: "Next independent request" })
    f.control("stop_and_take")
    expect(f.signals.get(receipt.id)?.aborted).toBe(true)
    expect(f.cancelBackgroundCommands).toHaveBeenCalledWith(["old-service"])
    await vi.waitFor(() => expect(f.store.getTask(receipt.id).state).toBe("cancelled"))
    expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(true)
    lifecycle.settled({ id: "old-service", threadId: f.work.threadId, output: "Stopped", exitCode: 143, cancelled: true, truncated: false })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
    expect(f.store.getTask(held.id).state).toBe("queued")
    expect(f.starts.filter(id => id === receipt.id)).toHaveLength(1)
    expect(f.cancelBackground).not.toHaveBeenCalled()
  })

  it("holds routine entries with their original identities, releases them once, and respects deletion", async () => {
    const f = await fixture()
    const config = { name: "Review", message: "Check report", frequency: "once" as const, runAt: "2030-01-01T00:00:00Z", enabled: true }
    const schedule = f.store.saveSchedule(f.bot.id, config, config.runAt)
    f.control("take")
    const input = { botId: f.bot.id, workId: f.work.id, requestId: "routine-occurrence", message: schedule.message }
    const origin = { kind: "schedule" as const, scheduleId: schedule.id }
    const original = f.store.enqueue(input, origin)
    const queued = f.store.pendingWorkFamily(f.bot.id, f.work.id).filter(task => task.origin.kind === "schedule")
    expect(queued).toHaveLength(1)
    expect(f.store.workDispatchToken(queued[0].id)).toBeNull()
    expect(f.store.enqueue(input, origin).id).toBe(original.id)
    expect(f.store.pendingWorkFamily(f.bot.id, f.work.id).filter(task => task.origin.kind === "schedule")).toHaveLength(1)
    f.finishes.get(f.task.id)!({ state: "completed" })
    await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl).toEqual({ settling: false, heldInputs: 1 }))
    f.control("return")
    await vi.waitFor(() => expect(f.starts.filter(id => id === queued[0].id)).toHaveLength(1))
    f.finishes.get(queued[0].id)!({ state: "completed" })
    await vi.waitFor(() => expect(f.store.getTask(queued[0].id).state).toBe("completed"))
    f.control("take", "take-again")
    f.store.enqueue({ ...input, requestId: "next-occurrence" }, origin)
    const deleted = f.store.pendingWorkFamily(f.bot.id, f.work.id).find(task => task.origin.kind === "schedule")!
    f.store.removeSchedule(schedule.id, f.store.schedules().find(item => item.id === schedule.id)!.version)
    expect(f.store.getTask(deleted.id).state).toBe("cancelled")
    f.control("return", "return-again")
    expect(f.starts).not.toContain(deleted.id)
  })
})


it.each([true, false])("adopts a checked service during normal results (takeover=%s)", async takeover => {
  const f = await fixture()
  f.host.recordPreparedInput(f.task.id, f.task.id, "Keep the checked preview running")
  expect(f.host.armWorkResultReview(f.task.id, "original-incarnation")).toBe(true)
  const lifecycle = f.host.commandLifecycle(f.task.id)
  lifecycle.accepted({ id: "preview", threadId: f.work.threadId, command: "node preview.mjs",
    cwd: "/synthetic", startedAt: 1, notifyOnComplete: false })
  f.host.recordWorkResultEvidence(f.task.id, { foregroundCommand: { callId: "health", command: "node check.mjs",
    exactCommand: true, startedAt: 2, exitCode: 0, output: "Expected preview; HTTP 200", excerpt: false } })
  if (takeover) expect(f.control("take").userControl?.settling).toBe(true)
  f.finishes.get(f.task.id)!({ state: "completed", result: "Preview running" })
  const review = () => f.store.recentTasks().find(t => t.origin.kind === "work_result" && t.origin.review?.phase === "review")
  await vi.waitFor(() => expect(f.starts).toContain(review()?.id))
  const evidenceId = "a".repeat(64)
  const access = {
    current: () => f.host.workResultReview(review()!.id), serviceIds: new Set<string>(),
    inspectedCommands: new Map([[evidenceId, { evidenceId, sourceTaskId: f.task.id, kind: "foreground", callId: "health" }]])
  } as unknown as ReturnType<typeof import("./work-result-runtime").createWorkResultEvidenceAccess>
  const keep = createBotWorkResultTools(review()!, () => f.host, f.signals.get(review()!.id)!, access)
    .find(tool => tool.name === "bot_work_result_keep_service")!
  const result = await keep.invoke({ type: "tool_call", id: "keep", name: keep.name,
    args: { serviceId: "preview", evidenceId, reason: "Original preview passed its requested HTTP check" } })
  expect(JSON.parse(String(result.content))).toEqual({ serviceId: "preview", ready: true })
  if (!takeover) {
  const reused = await keep.invoke({ type: "tool_call", id: "reuse-ready", name: keep.name,
    args: { serviceId: "preview", reason: "This report still includes the already checked preview" } })
  expect(JSON.parse(String(reused.content))).toEqual({ serviceId: "preview", ready: true })
  expect([...access.serviceIds]).toEqual(["preview"])
  }

  if (takeover) await vi.waitFor(() => expect(f.store.getWork(f.bot.id, f.work.id).userControl?.settling).toBe(false))
  expect(f.signals.get(review()!.id)?.aborted).toBe(false)
  if (takeover) {
    expect(f.host.workResultReview(review()!.id)?.remainingRepairs).toBe(0)
    expect(() => f.host.commitWorkResultReview(review()!.id,
      { kind: "repair", gap: "Missing detail", instruction: "Change the preview", evidenceIds: [] },
      [], [], undefined, undefined, true)).toThrow("不能自动执行补修")
    expect(f.signals.get(review()!.id)?.aborted).toBe(false)
  }
  expect(f.host.commitWorkResultReview(review()!.id, null, [], [], undefined,
    { messageId: "normal-preview", finalText: "Preview is running", serviceIds: ["preview"] }))
    .toMatchObject({ state: "publish", publication: {
      kind: "reported", responseMessageId: "normal-preview", serviceIds: ["preview"]
    } })
  expect(f.store.activeCommandThreads()).toContain(f.work.threadId)
  expect(f.cancelBackgroundCommands).not.toHaveBeenCalled()
  expect(f.store.recentTasks().some(t => t.origin.kind === "work" && t.origin.dispatch === "repair")).toBe(false)
})
