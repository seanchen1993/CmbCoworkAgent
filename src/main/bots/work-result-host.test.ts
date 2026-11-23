import { DatabaseSync } from "node:sqlite"
import { expect, it, vi } from "vitest"
import type { BotTask } from "../../shared/bots/contracts"
import {
  claimLocalThreadRunLease,
  onLocalThreadRunLeaseReleased,
  releaseLocalThreadRunLease
} from "../agent/thread-run-lease"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { LocalBotHost, type BotRunPort } from "./host"
import { BotStore } from "./store"

it("lets a running review commit an offline result when a parallel service exits during takeover", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const { work, task } = store.createWork({
    botId: bot.id, operationId: "original", title: "Report", goal: "Produce an offline report and keep the preview running"
  })
  const releaseReview = Promise.withResolvers<void>()
  let reviewId: string | undefined
  const outcome = vi.fn()
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire(_bot, turn) {
      return { release() {}, async execute(signal) {
        if (turn.id === task.id) {
          host.recordPreparedInput(turn.id, turn.id, turn.message)
          expect(host.armWorkResultReview(turn.id, "original-incarnation")).toBe(true)
          host.commandLifecycle(turn.id).accepted({ id: "preview", threadId: work.threadId,
            command: "node preview.mjs", cwd: "/work", startedAt: 1, notifyOnComplete: false })
          host.changeWorkControl({ botId: bot.id, workId: work.id, action: "take",
            operationId: "take-preview", expectedVersion: store.getWork(bot.id, work.id).version })
        } else if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "review") {
          reviewId = turn.id
          await releaseReview.promise
          signal.throwIfAborted()
          host.commitWorkResultReview(turn.id, { kind: "ready", summary: "Offline report verified",
            evidenceIds: [], serviceIds: [] }, [])
        } else if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "publish") {
          outcome(host.workResultPublication(turn.id))
          host.acknowledgeWorkResultPublication(turn.id)
        }
        return { state: "completed", result: "Report produced" }
      } }
    }
  })
  try {
    await vi.waitFor(() => expect(reviewId).toBeDefined())
    host.commandLifecycle(task.id).settled({ id: "preview", threadId: work.threadId,
      output: "Preview closed", exitCode: 0, cancelled: false, truncated: false })
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(host.workResultReview(reviewId!)).toBeDefined()
    expect(store.getWork(bot.id, work.id).userControl?.settling).toBe(true)
    releaseReview.resolve()
    await vi.waitFor(() => expect(outcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: "ready", summary: "Offline report verified", serviceIds: []
    })))
    expect(store.getWork(bot.id, work.id).userControl?.settling).toBe(false)
  } finally {
    releaseReview.resolve()
    await host.stop()
    db.close()
  }
})

it("refreshes a published decision when the newer same-work input is prepared", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const { work, task } = store.createWork({
    botId: bot.id, operationId: "original", title: "Report", goal: "Produce the report"
  })
  const decision = "Choose a format for the report."
  let allowPreparation!: () => void
  const preparation = new Promise<void>(resolve => { allowPreparation = resolve })
  let allowUnrelatedPreparation!: () => void
  const unrelatedPreparation = new Promise<void>(resolve => { allowUnrelatedPreparation = resolve })
  let allowSettlement!: () => void
  const settlement = new Promise<void>(resolve => { allowSettlement = resolve })
  let unrelatedWaiting = false
  let unrelatedPrepared = false
  let waitingForPreparation = false
  let preparationFinished = false
  const observed: Array<{ revision: number; decision?: string }> = []
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire(_bot, turn) {
      return {
        release() {},
        async execute() {
          if (turn.id === task.id) {
            host.beginInputPreparation(turn.id, turn.id)
            host.recordPreparedInput(turn.id, turn.id, turn.message)
            host.armWorkResultReview(turn.id, "original-incarnation")
          } else if (turn.requestId === "revision") {
            host.beginInputPreparation(turn.id, turn.id)
            waitingForPreparation = true
            await preparation
            host.recordPreparedInput(turn.id, turn.id, turn.message)
            host.recordPreparedInput(turn.id, turn.id, turn.message)
            preparationFinished = true
            await settlement
          } else if (turn.requestId === "unrelated") {
            host.beginInputPreparation(turn.id, turn.id)
            unrelatedWaiting = true
            await unrelatedPreparation
            host.recordPreparedInput(turn.id, turn.id, turn.message)
            unrelatedPrepared = true
            await settlement
          } else if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "review") {
            host.commitWorkResultReview(turn.id, { kind: "needs_user", summary: decision, evidenceIds: [] }, [])
          } else if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "publish") {
            host.acknowledgeWorkResultPublication(turn.id)
          }
          return { state: "completed", result: "Report produced" }
        }
      }
    }
  })
  const unsubscribe = host.subscribe(event => {
    observed.push({ revision: event.revision, decision: host.getWork(bot.id, work.id).resultNeedsUser })
  })
  try {
    await vi.waitFor(() => expect(observed.at(-1)?.decision).toBe(decision))
    const unrelated = host.send({ botId: bot.id, requestId: "unrelated", message: "Tell me the time" })
    await vi.waitFor(() => expect(unrelatedWaiting).toBe(true))
    const beforeUnrelated = observed.length
    allowUnrelatedPreparation()
    await vi.waitFor(() => expect(unrelatedPrepared).toBe(true))
    expect(observed).toHaveLength(beforeUnrelated)
    expect(observed.at(-1)?.decision).toBe(decision)
    expect(store.getTask(unrelated.id).state).toBe("running")

    const revision = host.send({
      botId: bot.id, workId: work.id, requestId: "revision", message: "Use the second format"
    })
    await vi.waitFor(() => expect(waitingForPreparation).toBe(true))
    expect(observed.at(-1)?.decision).toBe(decision)
    const before = observed.length
    allowPreparation()
    await vi.waitFor(() => expect(preparationFinished).toBe(true))
    expect(store.getTask(revision.id).state).toBe("running")
    expect(observed.slice(before)).toEqual([{ revision: store.revision(), decision: undefined }])
  } finally {
    unsubscribe()
    allowUnrelatedPreparation()
    allowPreparation()
    allowSettlement()
    await host.stop()
    db.close()
  }
})

it("yields only the active private review to a newer main user turn and resumes its exact result", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const created = store.createWork({
    botId: bot.id,
    operationId: "first",
    title: "Report",
    goal: "Produce report"
  })
  const fileDelivery = vi.spyOn(store.im, "publishFiles")
  const onSettled = vi.fn()
  const events: string[] = []
  const reviews: string[] = []
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    onSettled,
    acquire(_bot, task) {
      return {
        release() {},
        async execute(signal) {
          if (task.id === created.task.id) {
            events.push("work")
            host.recordPreparedInput(task.id, task.id, "Approved request")
            expect(host.armWorkResultReview(task.id, "original-incarnation")).toBe(true)
            host.publishImFiles(task.id, "delivery", [
              {
                filePath: "/work/report.md",
                attachmentPath: "/retained/report.md",
                name: "report.md",
                size: 3
              }
            ])
            return { state: "completed", result: "The report exists" }
          }
          if (task.origin.kind !== "work_result") {
            events.push("user")
            return { state: "completed" }
          }
          if (task.origin.review?.phase === "review") {
            const context = host.workResultReview(task.id)
            expect(context).toMatchObject({ executionTaskId: created.task.id, remainingRepairs: 2 })
            reviews.push(task.id)
            events.push("review")
            if (reviews.length === 1) {
              if (!signal.aborted)
                await new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), { once: true })
                )
              return { state: "completed" }
            }
            host.commitWorkResultReview(
              task.id,
              {
                kind: "ready",
                summary: "Report verified",
                evidenceIds: []
              },
              []
            )
          } else if (task.origin.review?.phase === "publish") {
            events.push("publish")
            expect(host.workResultPublication(task.id)?.summary).toBe("Report verified")
            expect(host.acknowledgeWorkResultPublication(task.id)).toBe(true)
          }
          return { state: "completed" }
        }
      }
    }
  })
  try {
    await vi.waitFor(() => expect(events).toEqual(["work", "review"]))
    const user = host.send({
      botId: bot.id,
      requestId: "new-request",
      message: "Where is my report?"
    })
    await vi.waitFor(() => expect(events).toEqual(["work", "review", "user", "review", "publish"]))
    expect(reviews).toHaveLength(2)
    expect(reviews[0]).not.toBe(reviews[1])
    expect(store.getTask(reviews[0]).state).toBe("cancelled")
    expect(store.getTask(created.task.id).state).toBe("completed")
    expect(host.getWork(bot.id, created.work.id).dispatchStopped).toBeUndefined()
    expect(fileDelivery).not.toHaveBeenCalled()
    expect(onSettled.mock.calls.map(([task]) => task.id)).toEqual([user.id])
  } finally {
    await host.stop()
    db.close()
  }
})

it.each([true, false])("yields an async check to detail preparation without committing its stale response (accepted=%s)", async accepted => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const { work, task } = store.createWork({
    botId: bot.id, operationId: "original", title: "Report", goal: "Generate and upload the CSV"
  })
  let releaseOldReview!: () => void
  const waitForLateResponse = new Promise<void>(resolve => { releaseOldReview = resolve })
  const reviews: Array<{ executionTaskId: string; requests: Array<{ id: string; text: string }> }> = []
  const lateCommit = vi.fn((attempt: () => unknown) => expect(attempt).toThrow())
  let oldSignal: AbortSignal | undefined
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire(_bot, turn) {
      return {
        release() {},
        async execute(signal) {
          if (turn.id === task.id || turn.requestId === "revision") {
            host.beginInputPreparation(turn.id, turn.id)
            if (turn.id !== task.id && !accepted) {
              return { state: "failed" }
            }
            host.recordPreparedInput(turn.id, turn.id, turn.message)
            expect(host.armWorkResultReview(turn.id, "original-incarnation")).toBe(true)
            return { state: "completed", result: turn.id === task.id ? "CSV ready" : "CSV kept local" }
          }
          if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "review") {
            const review = host.workResultReview(turn.id)!
            reviews.push(review)
            if (reviews.length === 1) {
              oldSignal = signal
              await waitForLateResponse
              lateCommit(() => host.commitWorkResultReview(turn.id, {
                kind: "repair", gap: "Upload pending", instruction: "Upload the CSV", evidenceIds: []
              }, []))
            } else {
              host.commitWorkResultReview(turn.id, { kind: "ready", summary: "Reviewed", evidenceIds: [] }, [])
            }
          }
          return { state: "completed" }
        },
        notificationTerminal: () => ({ outcome: "error", code: "prompt_blocked" })
      }
    }
  })
  try {
    await vi.waitFor(() => expect(oldSignal).toBeDefined())
    const revision = host.send({
      botId: bot.id, workId: work.id, requestId: "revision", message: "Do not upload the CSV. Keep it local."
    })
    await vi.waitFor(() => {
      expect(oldSignal?.aborted).toBe(true)
      expect(store.getTask(revision.id).state).toBe(accepted ? "completed" : "failed")
    })
    releaseOldReview()
    await vi.waitFor(() => expect(reviews).toHaveLength(2))
    expect(lateCommit).toHaveBeenCalledOnce()
    expect(reviews[1]).toMatchObject({
      executionTaskId: accepted ? revision.id : task.id, remainingRepairs: 2,
      requests: [
        { id: task.id, text: task.message },
        ...(accepted ? [{ id: revision.id, text: revision.message }] : [])
      ]
    })
    expect(store.recentTasks().some(turn => turn.origin.kind === "work" && turn.origin.dispatch === "repair")).toBe(false)
  } finally {
    releaseOldReview()
    await host.stop()
    db.close()
  }
})

function runGate() {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  return { pending, release }
}

function queuedReviewFixture(acceptSupplement = false) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const originalMain = runGate()
  const supplementStarted = runGate()
  const supplementPreparation = runGate()
  const originalFile = {
    filePath: "/work/report.md", attachmentPath: "/retained/original/report.md", name: "report.md", size: 3
  }
  const revisedFile = { ...originalFile, attachmentPath: "/retained/revised/report.md", size: 4 }
  let created: Awaited<ReturnType<LocalBotHost["createWork"]>> | undefined
  let supplement: BotTask | undefined
  const review = vi.fn()
  const publish = vi.fn()
  const reportError = vi.fn()
  const acquire = vi.fn<BotRunPort["acquire"]>((_bot, turn) => {
    if (!claimLocalThreadRunLease({ threadId: turn.threadId, owner: "bot", runId: turn.id }).acquired)
      return null
    return {
      release: () => { releaseLocalThreadRunLease(turn.threadId, "bot", turn.id) },
      async execute() {
        const completed = { state: "completed" } as const
        if (turn.requestId === "main-assignment") {
          host.beginInputPreparation(turn.id, turn.id)
          host.recordPreparedInput(turn.id, turn.id, turn.message)
          created = await host.createWork({
            botId: bot.id, operationId: "create-work", title: "Report", goal: "Produce report"
          }, { taskId: turn.id, callId: "create-tool", key: "create-work" })
          await originalMain.pending
        } else if (turn.requestId === "main-supplement") {
          host.beginInputPreparation(turn.id, turn.id)
          host.recordPreparedInput(turn.id, turn.id, turn.message)
          supplement = host.sendWork({ taskId: turn.id, callId: "send-tool", key: "send-work" },
            created!.work.id, turn.message)
          await supplementStarted.pending
        } else if (turn.origin.kind === "work") {
          const isSupplement = turn.origin.dispatch === "follow_up"
          host.beginInputPreparation(turn.id, turn.id)
          if (isSupplement) {
            supplementStarted.release()
            await supplementPreparation.pending
            if (!acceptSupplement) return { state: "failed" }
          }
          host.recordPreparedInput(turn.id, turn.id, turn.message)
          expect(host.armWorkResultReview(turn.id, "original-incarnation")).toBe(true)
          host.recordWorkResultEvidence(turn.id, {
            finalMessageId: isSupplement ? "revised-result" : "original-result",
            assistantMessageId: isSupplement ? "revised-file-card" : "original-file-card",
            callId: "delivery",
            files: [isSupplement ? revisedFile : originalFile]
          })
          return { ...completed, result: isSupplement ? "Revised report exists" : "Original report exists" }
        } else if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "review") {
          // Match the private Runtime's first authority check before model work.
          await Promise.resolve()
          const context = host.workResultReview(turn.id)
          if (!context) throw new Error("Private review has no current context")
          review(context)
          host.commitWorkResultReview(turn.id, { kind: "ready", summary: context.outcome.text, evidenceIds: [] }, [])
        } else if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "publish") {
          publish(host.workResultPublication(turn.id))
          expect(host.acknowledgeWorkResultPublication(turn.id)).toBe(true)
        }
        return completed
      },
      notificationTerminal: () => turn.id === supplement?.id && !acceptSupplement
        ? { outcome: "error", code: "prompt_blocked" }
        : undefined
    }
  })
  const host = new LocalBotHost(store, { onAvailable: onLocalThreadRunLeaseReleased, acquire },
    Number.POSITIVE_INFINITY, reportError)

  return {
    bot, host, store, acquire, review, publish, reportError, originalFile, revisedFile, originalMain,
    supplementPreparation,
    supplement: () => supplement!,
    async start() {
      const main = await host.sendDesktopMessage({ botId: bot.id, requestId: "main-assignment", message: "Produce report" })
      const oldReview = await vi.waitFor(() => {
        expect(created).toBeDefined()
        const queued = store.recentTasks().find(turn => turn.origin.kind === "work_result" &&
          turn.origin.review?.phase === "review" && turn.state === "queued")
        expect(queued).toBeDefined()
        expect(store.getTask(main.id).state).toBe("running")
        return queued!
      })
      return { main, oldReview, ...created! }
    },
    async close() {
      originalMain.release()
      supplementStarted.release()
      supplementPreparation.release()
      await host.stop()
      db.close()
    }
  }
}

it.each([true, false])("waits to claim a queued review while its follow-up is prepared (accepted=%s)", async accepted => {
  const f = queuedReviewFixture(accepted)
  try {
    const { work, task: original } = await f.start()
    const mainSupplement = await f.host.sendDesktopMessage({
      botId: f.bot.id, requestId: "main-supplement", message: "Update the report format"
    })
    f.originalMain.release()
    await vi.waitFor(() => expect(f.store.getTask(mainSupplement.id).state).toBe("completed"))
    const supplement = f.supplement()
    expect(f.store.getTask(supplement.id).state).toBe("running")
    expect(f.acquire.mock.calls.some(([, turn]) => turn.origin.kind === "work_result")).toBe(false)
    expect(f.publish).not.toHaveBeenCalled()

    f.supplementPreparation.release()
    const expectedExecution = accepted ? supplement.id : original.id
    const expectedResult = accepted ? "Revised report exists" : "Original report exists"
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requestTaskId: original.id,
      executionTaskId: expectedExecution,
      kind: "ready",
      summary: expectedResult,
      attachments: [expect.objectContaining({ sourceTaskId: expectedExecution, file: accepted ? f.revisedFile : f.originalFile })]
    })))
    expect(f.review).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requestTaskId: original.id, executionTaskId: expectedExecution, remainingRepairs: 2
    }))
    expect(f.store.getTask(supplement.id).state).toBe(accepted ? "completed" : "failed")
    expect(f.store.getTask(original.id).state).toBe("completed")
    expect(f.host.getWork(f.bot.id, work.id).resultReviewState).toBeUndefined()
    expect(f.reportError).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

it("settles a queued private review when the user stops the main conversation", async () => {
  const f = queuedReviewFixture()
  try {
    const { work, task: original, main, oldReview } = await f.start()
    f.host.stopConversation(f.bot.id)
    f.originalMain.release()
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requestTaskId: original.id, executionTaskId: original.id, kind: "interrupted", finalMessageId: "original-result",
      attachments: [{ sourceTaskId: original.id, callId: "delivery", fileIndex: 0, file: f.originalFile,
        finalMessageId: "original-result", assistantMessageId: "original-file-card" }]
    })))
    expect(f.acquire.mock.calls.some(([, turn]) => turn.id === oldReview.id)).toBe(false)
    expect(f.review).not.toHaveBeenCalled()
    expect(f.store.getTask(main.id).state).toBe("cancelled")
    expect(f.store.getTask(oldReview.id).state).toBe("cancelled")
    expect(f.store.getTask(original.id).state).toBe("completed")
    expect(f.host.getWork(f.bot.id, work.id)).toMatchObject({ resultReviewState: "interrupted" })
    expect(f.host.getWork(f.bot.id, work.id).dispatchStopped).toBeUndefined()
    expect(f.reportError).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

it.each(["complete takeover", "cancel takeover", "cancel takeover during submit"] as const)("keeps the original execution and its result when users %s", async (action) => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const { work, task } = store.createWork({
    botId: bot.id, operationId: "work", title: "Report", goal: "Produce report"
  })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let releasePreparation!: () => void
  const preparation = new Promise<void>(resolve => { releasePreparation = resolve })
  let executionSignal: AbortSignal | undefined
  let prepared = false
  const publish = vi.fn()
  const review = vi.fn()
  const onSettled = vi.fn()
  const acquire = vi.fn<BotRunPort["acquire"]>((_bot, turn) => ({
    release() {},
    async execute(signal: AbortSignal) {
      if (turn.id === task.id) {
        executionSignal = signal
        if (action === "cancel takeover during submit") await preparation
        host.recordPreparedInput(turn.id, turn.id, "Approved request")
        expect(host.armWorkResultReview(turn.id, "original-incarnation")).toBe(true)
        prepared = true
        await held
        return { state: "completed" as const, result: "The report was written" }
      }
      if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "review") {
        review(host.workResultReview(turn.id))
        host.commitWorkResultReview(turn.id, { kind: "ready", summary: "The report was checked", evidenceIds: [] }, [])
      } else {
        publish(turn.origin, host.workResultPublication(turn.id))
        expect(host.acknowledgeWorkResultPublication(turn.id)).toBe(true)
      }
      return { state: "completed" as const }
    }
  }))
  const host = new LocalBotHost(store, { onAvailable: () => () => {}, onSettled, acquire })
  try {
    await vi.waitFor(() => expect(executionSignal).toBeDefined())
    const took = host.changeWorkControl({ botId: bot.id, workId: work.id,
      expectedVersion: host.getWork(bot.id, work.id).version, action: "take", operationId: "take" })
    expect(took.userControl?.settling).toBe(true)
    expect(executionSignal?.aborted).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    releasePreparation()
    await vi.waitFor(() => expect(prepared).toBe(true))
    const cancelled = action !== "complete takeover"
    if (cancelled) {
      const returned = host.changeWorkControl({ botId: bot.id, workId: work.id,
        expectedVersion: took.version, action: "return", operationId: "cancel-take" })
      expect(returned.userControl).toBeUndefined()
      expect(store.getTask(task.id).state).toBe("running")
    }
    release()
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ review: { requestTaskId: task.id, phase: "publish" } }),
      expect.objectContaining({ summary: expect.stringContaining(cancelled ? "The report was checked" : "The report was written") })
    ))
    if (cancelled) {
      expect(review).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        requestTaskId: task.id, executionTaskId: task.id, remainingRepairs: 2
      }))
    } else {
      expect(review).not.toHaveBeenCalled()
      const pending = host.workControlPending(bot.id, work.id)
      expect(pending.items).toHaveLength(0)
      host.changeWorkControl({ botId: bot.id, workId: work.id,
        expectedVersion: pending.version, action: "return", operationId: "return" })
    }
    expect(host.getWork(bot.id, work.id).userControl).toBeUndefined()
    expect(store.getTask(task.id).state).toBe("completed")
    expect(acquire).toHaveBeenCalledTimes(cancelled ? 3 : 2)
    expect(onSettled).not.toHaveBeenCalled()
  } finally {
    releasePreparation()
    release()
    await host.stop()
    db.close()
  }
})

it("withdraws an exact held repair while delivering its original result and attachment once", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const { work, task } = store.createWork({
    botId: bot.id, operationId: "work", title: "Report", goal: "Produce report"
  })
  const unrelated = store.createWork({
    botId: bot.id, operationId: "other", title: "Other", goal: "Separate work"
  })
  const file = {
    filePath: "/work/report.md", attachmentPath: "/retained/report.md", name: "report.md", size: 3
  }
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  let repairId = ""
  let mainSignal: AbortSignal | undefined
  let unrelatedSignal: AbortSignal | undefined
  const publish = vi.fn()
  const acquire = vi.fn<BotRunPort["acquire"]>((_bot, turn) => ({
    release() {},
    async execute(signal) {
      if (turn.id === task.id) {
        host.recordPreparedInput(turn.id, turn.id, "Approved request")
        expect(host.armWorkResultReview(turn.id, "original-incarnation")).toBe(true)
        host.recordWorkResultEvidence(turn.id, {
          finalMessageId: "result", assistantMessageId: "file-card", callId: "delivery", files: [file]
        })
        return { state: "completed", result: "Original report is available" }
      }
      if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "review") {
        const decision = host.commitWorkResultReview(turn.id, {
          kind: "repair", gap: "Missing check", instruction: "Verify the report", evidenceIds: []
        }, [])
        if (decision.state !== "repair") throw new Error("Expected a repair")
        repairId = decision.task.id
        // A newer main-chat turn fences the repair before it can dispatch.
        host.send({ botId: bot.id, requestId: "new-main", message: "I have another question" })
      } else if (turn.requestId === "new-main") {
        mainSignal = signal
        await wait
      } else if (turn.id === unrelated.task.id) {
        unrelatedSignal = signal
        await wait
      } else if (turn.origin.kind === "work_result" && turn.origin.review?.phase === "publish") {
        publish(host.workResultPublication(turn.id))
        expect(host.acknowledgeWorkResultPublication(turn.id)).toBe(true)
      }
      return { state: "completed" }
    }
  }))
  const host = new LocalBotHost(store, { onAvailable: () => () => {}, acquire }, Number.POSITIVE_INFINITY)
  try {
    await vi.waitFor(() => {
      expect(mainSignal).toBeDefined()
      expect(unrelatedSignal).toBeDefined()
      expect(store.getTask(repairId).state).toBe("queued")
    })
    host.changeWorkControl({
      botId: bot.id, workId: work.id, expectedVersion: host.getWork(bot.id, work.id).version,
      action: "take", operationId: "take"
    })
    expect(host.workControlPending(bot.id, work.id).items.map(item => item.taskId)).toEqual([repairId])

    host.cancel(repairId)
    host.cancel(repairId)
    expect(store.getTask(repairId).state).toBe("cancelled")
    expect(host.workControlPending(bot.id, work.id).items).toEqual([])
    expect(mainSignal?.aborted).toBe(false)
    expect(unrelatedSignal?.aborted).toBe(false)
    expect(publish).not.toHaveBeenCalled()

    release()
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: "blocked", executionTaskId: task.id, finalMessageId: "result",
      summary: expect.stringContaining("Original report is available"),
      attachments: [{
        sourceTaskId: task.id, callId: "delivery", fileIndex: 0, file,
        finalMessageId: "result", assistantMessageId: "file-card"
      }]
    })))
    expect(store.getTask(unrelated.task.id).state).toBe("completed")
    const { version } = host.workControlPending(bot.id, work.id)
    host.changeWorkControl({
      botId: bot.id, workId: work.id, expectedVersion: version, action: "return",
      operationId: "return", confirmedTaskIds: []
    })
    host.cancel(repairId)
    store.flushReplies()
    expect(store.getTask(repairId).state).toBe("cancelled")
    expect(acquire.mock.calls.some(([, turn]) => turn.id === repairId)).toBe(false)
    const resultTurns = store.recentTasks().filter(turn =>
      turn.origin.kind === "work_result" && turn.origin.workId === work.id)
    expect(resultTurns).toHaveLength(2)
    expect(resultTurns.map(turn => turn.origin)).toEqual(expect.arrayContaining([
      expect.objectContaining({ review: { requestTaskId: task.id, phase: "review", attempt: 1 } }),
      expect.objectContaining({ review: { requestTaskId: task.id, phase: "publish" } })
    ]))
    expect(publish).toHaveBeenCalledOnce()
    const retainedConclusion = {
      state: "active",
      executionState: "completed",
      resultConclusion: { kind: "blocked", summary: expect.stringContaining("原任务本轮已完成，成果未自动核查。") }
    }
    expect.soft(host.getWork(bot.id, work.id)).toMatchObject(retainedConclusion)
    expect.soft(new BotStore(db).getWork(bot.id, work.id)).toMatchObject(retainedConclusion)
  } finally {
    release()
    await host.stop()
    db.close()
  }
})
