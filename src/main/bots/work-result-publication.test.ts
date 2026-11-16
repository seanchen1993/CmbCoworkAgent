import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { LocalBotHost } from "./host"
import { botImScopeId } from "./im-gateway-store"
import { BotStore } from "./store"
import { createBotResultEvidenceReader } from "./work-result-evidence"
import { reviewBotWorkResult } from "./work-result-review"
import { RetryableBotWorkPublicationError } from "./work-result-settlement"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))

function fixture(now = Date.now) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db, now)
  const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const start = (operationId = "work") => {
    const { work, task } = store.createWork({ botId: bot.id, operationId, title: "Report", goal: "Prepare report" })
    store.transition(task.id, "running")
    store.recordPreparedInput(task.id, task.message)
    expect(store.armWorkResultReview(task.id, "incarnation")).toBe(true)
    return { work, task }
  }
  return { db, store, bot, start }
}

function bindPersonalIm(store: BotStore, botId: string, realm = "fixture") {
  const principal = "owner", conversationKey = "personal-dm"
  const binding = {
    id: "personal-binding", botId, kind: "dm" as const, label: "Owner", version: 1,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString()
  }
  if (!store.imGateway.binding(botImScopeId(realm, principal, binding.id)))
    store.imGateway.register(realm, principal, { ...binding, state: "pending", conversationKey: null })
  const { id } = store.imGateway.register(realm, principal, { ...binding, state: "active", conversationKey })
  store.im.importImBinding({ id, botId, kind: "dm", label: "Owner", version: 1,
    channelKey: botImScopeId(realm, principal, conversationKey) })
  return id
}

const publicationTask = (store: BotStore, workId: string) => store.recentTasks().find(
  task => task.origin.kind === "work_result" && task.origin.review?.phase === "publish" && task.origin.workId === workId
)

function startReview(store: BotStore, workId: string) {
  store.flushReplies()
  const review = store.recentTasks().find(task => task.origin.kind === "work_result" &&
    task.origin.review?.phase === "review" && task.origin.workId === workId && task.state === "queued")!
  store.transition(review.id, "running")
  return review
}

function commitReadyResult(f: ReturnType<typeof fixture>, operationId?: string) {
  const { work, task } = f.start(operationId)
  f.store.settle(task.id, "completed", null, "Report prepared")
  const review = startReview(f.store, work.id)
  f.store.commitWorkResultReview(review.id, { kind: "ready", summary: "Report verified", evidenceIds: [] })
  f.store.settle(review.id, "completed", null)
  return work
}

it.each([
  { outcome: "ready", stage: "outbox" }, { outcome: "ready", stage: "queued" },
  { outcome: "ready", stage: "running" }, { outcome: "interrupted", stage: "outbox" },
  { outcome: "interrupted", stage: "queued" }, { outcome: "interrupted", stage: "running" }
] as const)("withdraws the older $outcome publication at $stage only after a same-work input is admitted", ({ outcome, stage }) => {
  const f = fixture()
  bindPersonalIm(f.store, f.bot.id)
  const unrelated = commitReadyResult(f, "unrelated")
  const { work, task } = f.start()
  f.store.recordWorkResultEvidence(task.id, { callId: "csv", files: [
    { filePath: "/work/report.csv", attachmentPath: "/retained/report.csv", name: "report.csv", size: 3 }
  ] })
  f.store.settle(task.id, "completed", null, "Report prepared")
  const review = startReview(f.store, work.id)
  if (outcome === "ready") f.store.commitWorkResultReview(review.id, { kind: "ready", summary: "Verified", evidenceIds: [] })
  f.store.settle(review.id, outcome === "ready" ? "completed" : "interrupted", null)
  if (stage !== "outbox") f.store.flushReplies()
  const old = publicationTask(f.store, work.id)
  if (stage === "running") f.store.transition(old!.id, "running")
  const message = "Keep the CSV local; report only in text."
  const next = stage === "running" ? f.store.enqueue({ botId: f.bot.id, workId: work.id, requestId: "correction", message }) : (() => {
    const user = f.store.enqueue({ botId: f.bot.id, requestId: "correction", message })
    f.store.transition(user.id, "running")
    f.store.recordPreparedInput(user.id, user.message)
    const forwarded = f.store.sendWork({ taskId: user.id, callId: "send", key: "correction" }, work.id, user.message)
    f.store.settle(user.id, "completed", null)
    return forwarded
  })()
  f.store.transition(next.id, "running")
  f.store.recordPreparedInput(next.id, next.message)
  expect(f.store.armWorkResultReview(next.id, "incarnation")).toBe(stage !== "running")
  if (old) {
    expect(f.store.getTask(old.id).state).toBe("cancelled")
    expect(f.store.getWorkResultPublication(old.id)).toBeUndefined()
    expect(f.store.acknowledgeWorkResultPublication(old.id)).toBe(false)
  }
  const reopened = new BotStore(f.db)
  reopened.recover()
  reopened.flushReplies()
  const previous = reopened.recentTasks().find(item => item.origin.kind === "work_result" &&
    item.origin.review?.phase === "publish" && item.origin.executionTaskId === task.id)
  expect(previous?.state).toBe(stage === "outbox" ? undefined : "cancelled")
  expect(publicationTask(reopened, unrelated.id)?.state).toBe("queued")
  expect(f.db.exec("SELECT COUNT(*) FROM bot_im_outbox WHERE file_delivery_id IS NOT NULL")[0].values[0][0]).toBe(0)
})

it.each(["prepared", "withdrawn", "injected", "blocked", "acknowledged"] as const)(
  "preserves publication admission and acknowledgement boundaries (%s)", stage => {
    const f = fixture()
    const work = commitReadyResult(f)
    f.store.flushReplies()
    const publication = publicationTask(f.store, work.id)!
    if (stage === "acknowledged") {
      f.store.transition(publication.id, "running")
      expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    }
    const parent = f.store.enqueue({ botId: f.bot.id, workId: work.id, requestId: "parent", message: "Read the report" })
    f.store.transition(parent.id, "running")
    f.store.recordPreparedInput(parent.id, "")
    const input = f.store.enqueue({ botId: f.bot.id, workId: work.id, requestId: "change", message: "Do not send the CSV" })
    f.store.beginInputPreparation(input.id)
    if (stage === "blocked") f.store.transition(input.id, "failed")
    else {
      f.store.recordPreparedInput(input.id, input.message)
      if (stage === "injected" || stage === "acknowledged") f.store.injectIntoRun(input.id, parent.id)
      if (stage === "withdrawn") f.store.transition(input.id, "cancelled")
    }
    if (stage === "injected") {
      expect(f.store.getTask(publication.id).state).toBe("cancelled")
      expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
    } else if (stage === "acknowledged") {
      expect(f.store.getTask(publication.id).state).toBe("running")
      f.store.settle(publication.id, "completed", null)
      expect(f.store.getTask(publication.id).state).toBe("completed")
    } else {
      f.store.transition(publication.id, "running")
      expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    }
  }
)

it.each(["outbox", "queued", "running"] as const)("withdraws only the target publication on full Stop (%s)", stage => {
  const f = fixture()
  const unrelated = commitReadyResult(f, "unrelated")
  const work = commitReadyResult(f)
  if (stage !== "outbox") f.store.flushReplies()
  const pending = publicationTask(f.store, work.id)
  if (stage === "running") f.store.transition(pending!.id, "running")
  const stopped = f.store.stopWorkDispatch(f.bot.id, work.id)
  if (pending) {
    expect(f.store.getTask(pending.id).state).toBe("cancelled")
    expect(f.store.acknowledgeWorkResultPublication(pending.id)).toBe(false)
    if (stage === "running") f.store.settle(pending.id, "interrupted", null)
  }
  const reopened = new BotStore(f.db)
  reopened.recover()
  reopened.changeWork(f.bot.id, work.id, stopped.version, "continue", "continue")
  reopened.flushReplies()
  expect(publicationTask(reopened, work.id)?.state).toBe(stage === "outbox" ? undefined : "cancelled")
  expect(publicationTask(reopened, unrelated.id)?.state).toBe("queued")
})

it("does not withdraw a publication already acknowledged when the user stops the work", () => {
  const f = fixture()
  const work = commitReadyResult(f)
  f.store.flushReplies()
  const publication = publicationTask(f.store, work.id)!
  f.store.transition(publication.id, "running")
  expect(f.store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
  f.store.stopWorkDispatch(f.bot.id, work.id)
  expect(f.store.getTask(publication.id).state).toBe("running")
  f.store.settle(publication.id, "completed", null)
  expect(f.store.getTask(publication.id).state).toBe("completed")
})

it.each(["execution interrupted", "review interrupted", "review unavailable", "service unverified"] as const)(
  "keeps exact formal attachments and their anchors when %s",
  (scenario) => {
    const { store, start } = fixture()
    const { work, task } = start()
    const file = { filePath: "/work/report.zip", attachmentPath: "/retained/latest/report.zip", name: "report.zip", size: 3 }
    store.recordWorkResultEvidence(task.id, {
      callId: "earlier", assistantMessageId: "older-anchor", files: [{ ...file, attachmentPath: "/retained/old/report.zip" }]
    })
    store.recordWorkResultEvidence(task.id, { callId: "formal", assistantMessageId: "file-anchor", files: [file] })
    if (scenario === "service unverified") store.acceptCommand(task.id, {
      id: "preview", threadId: work.threadId, command: "preview", cwd: "/work", startedAt: 1, notifyOnComplete: false
    })
    store.settle(task.id, scenario === "execution interrupted" ? "interrupted" : "completed", null)
    if (scenario === "review interrupted" || scenario === "review unavailable" || scenario === "service unverified") {
      const review = startReview(store, work.id)
      if (scenario === "review unavailable") store.commitWorkResultReview(review.id, null)
      if (scenario === "service unverified") store.commitWorkResultReview(review.id, {
        kind: "ready", summary: "Preview result", evidenceIds: [], serviceIds: ["preview"]
      })
      store.settle(review.id, scenario === "review interrupted" ? "interrupted" : "completed", null)
    }
    store.flushReplies()
    const publication = publicationTask(store, work.id)!
    store.transition(publication.id, "running")
    expect(store.getWorkResultPublication(publication.id)).toMatchObject({
      kind: scenario.endsWith("interrupted") ? "interrupted" : "blocked",
      attachments: [{ sourceTaskId: task.id, callId: "formal", fileIndex: 0, assistantMessageId: "file-anchor", file }]
    })
  }
)

it.each([
  { outcome: "unavailable", input: "same" },
  { outcome: "interrupted", input: "same" },
  { outcome: "unavailable", input: "withdrawn" },
  { outcome: "interrupted", input: "withdrawn" },
  { outcome: "unavailable", input: "replacement" },
  { outcome: "interrupted", input: "replacement" },
  { outcome: "repair unavailable", input: "replacement" },
  { outcome: "implicit selection", input: "replacement" }
] as const)("keeps fallback files in the $input input when review is $outcome", ({ outcome, input }) => {
  const { store, bot, start } = fixture()
  const { work, task } = start()
  const old = { filePath: "/work/report.csv", attachmentPath: "/retained/report.csv", name: "report.csv", size: 3 }
  const revised = { filePath: "/work/report.xlsx", attachmentPath: "/retained/report.xlsx", name: "report.xlsx", size: 9 }
  store.recordWorkResultEvidence(task.id, { callId: "original-file", files: [old] })
  store.acceptCommand(task.id, {
    id: "original-check", threadId: work.threadId, command: "check report", cwd: "/work", startedAt: 1,
    notifyOnComplete: true
  })
  store.settle(task.id, "completed", null, "Waiting for the original report check")

  let current = task
  if (input !== "same") {
    current = store.enqueue({ botId: bot.id, workId: work.id, requestId: "change-delivery",
      message: input === "withdrawn" ? "Do not send the CSV. Report in text only." : "Send only the revised workbook." })
    store.transition(current.id, "running")
    store.recordPreparedInput(current.id, current.message)
    expect(store.armWorkResultReview(current.id, "incarnation")).toBe(true)
    if (input === "replacement") store.recordWorkResultEvidence(current.id, { callId: "replacement-file", files: [revised] })
    store.settle(current.id, "completed", null, "Updated requested result")
  }
  store.settleCommand({ id: "original-check", threadId: work.threadId, exitCode: 0, output: "Check complete",
    cancelled: false, truncated: false })
  const callback = store.recentTasks().find(item => item.origin.kind === "notification")!
  store.transition(callback.id, "running")
  store.settle(callback.id, "completed", null, "Verification finished")

  const review = startReview(store, work.id)
  const evidence = store.getWorkResultReview(review.id)
  expect(evidence?.executionTaskId).toBe(input === "same" ? callback.id : current.id)
  expect(evidence?.evidence.find(item => item.taskId === task.id)?.deliveries).toMatchObject([{ file: old }])
  if (outcome === "unavailable") {
    store.commitWorkResultReview(review.id, null)
  } else if (outcome === "implicit selection") {
    store.commitWorkResultReview(review.id, { kind: "ready", summary: "Revised result", evidenceIds: [] })
  } else if (outcome === "repair unavailable") {
    const repair = store.commitWorkResultReview(review.id, {
      kind: "repair", gap: "Workbook lacks verification", instruction: "Verify the retained workbook", evidenceIds: []
    })
    if (repair.state !== "repair") throw new Error("Expected an original-work repair")
    store.settle(review.id, "completed", null)
    store.transition(repair.task.id, "running")
    store.settle(repair.task.id, "completed", null, "Workbook verified")
    const next = startReview(store, work.id)
    store.commitWorkResultReview(next.id, null)
    store.settle(next.id, "completed", null)
  }
  if (outcome !== "repair unavailable")
    store.settle(review.id, outcome === "interrupted" ? "interrupted" : "completed", null)

  store.flushReplies()
  const publication = publicationTask(store, work.id)!
  store.transition(publication.id, "running")
  expect(store.getWorkResultPublication(publication.id)?.attachments.map(item => item.file)).toEqual(
    input === "same" ? [old] : input === "replacement" ? [revised] : []
  )
})

it.each([
  { outcome: "unavailable", deliverReplacement: false, legacy: false },
  { outcome: "interrupted", deliverReplacement: false, legacy: false },
  { outcome: "unavailable", deliverReplacement: true, legacy: false },
  { outcome: "interrupted", deliverReplacement: true, legacy: false },
  { outcome: "unavailable", deliverReplacement: true, legacy: true }
] as const)("uses the in-run supplement's file boundary ($outcome, replacement=$deliverReplacement, legacy=$legacy)",
  ({ outcome, deliverReplacement, legacy }) => {
    const { db, store, bot, start } = fixture()
    const { work, task } = start()
    const old = { filePath: "/work/report.csv", attachmentPath: "/retained/report.csv", name: "report.csv", size: 3 }
    const revised = { filePath: "/work/report.xlsx", attachmentPath: "/retained/report.xlsx", name: "report.xlsx", size: 9 }
    store.recordWorkResultEvidence(task.id, { callId: "original-file", files: [old] })
    const supplement = store.enqueue({ botId: bot.id, workId: work.id, requestId: "change-delivery",
      message: deliverReplacement ? "Send only the revised workbook." : "Do not send the CSV. Report in text only." })
    store.recordPreparedInput(supplement.id, supplement.message)
    expect(store.injectIntoRun(supplement.id, task.id)).toBe(true)
    if (deliverReplacement) store.recordWorkResultEvidence(task.id, { callId: "replacement-file", files: [revised] })
    if (legacy) db.run("UPDATE bot_work_items SET work_review_json=json_remove(work_review_json,'$.attachmentBoundary') WHERE id=?", [work.id])
    store.settleRun(task.id, [supplement.id], "completed", null, "Updated requested result")

    const review = startReview(store, work.id)
    expect(store.getWorkResultReview(review.id)?.evidence[0].deliveries.map(item => item.file)).toEqual(
      deliverReplacement ? [old, revised] : [old]
    )
    if (outcome === "unavailable") store.commitWorkResultReview(review.id, null)
    store.settle(review.id, outcome === "interrupted" ? "interrupted" : "completed", null)

    store.flushReplies()
    const publication = publicationTask(store, work.id)!
    store.transition(publication.id, "running")
    expect(store.getWorkResultPublication(publication.id)?.attachments.map(item => item.file)).toEqual(
      deliverReplacement && !legacy ? [revised] : []
    )
  }
)

it.each([
  { action: "retain", message: "Keep the submitted CSV. Add an explanation to the final response.", kind: "ready" },
  { action: "withdraw", message: "Do not send the CSV. Report in text only.", kind: "ready" },
  { action: "omit", message: "Do not send the CSV. Report in text only.", kind: "blocked" },
  { action: "replace", message: "Send only the revised workbook.", kind: "ready" }
] as const)("publishes the reviewed attachment selection after an in-run supplement ($action)", async ({
  action, message, kind
}) => {
  const { bot, store, start } = fixture()
  const { work, task } = start()
  const old = { filePath: "/work/report.csv", attachmentPath: "/retained/report.csv", name: "report.csv", size: 3 }
  const revised = { filePath: "/work/report.xlsx", attachmentPath: "/retained/report.xlsx", name: "report.xlsx", size: 9 }
  const originalReceipt = { sourceTaskId: task.id, callId: "original-file", fileIndex: 0 }
  const revisedReceipt = { sourceTaskId: task.id, callId: "replacement-file", fileIndex: 0 }
  store.recordWorkResultEvidence(task.id, {
    callId: originalReceipt.callId, assistantMessageId: "original-anchor", files: [old]
  })
  const user = store.enqueue({ botId: bot.id, requestId: "supplement", message })
  store.transition(user.id, "running")
  store.recordPreparedInput(user.id, user.message)
  const supplement = store.sendWork({ taskId: user.id, callId: "forward", key: "supplement" }, work.id, user.message)
  store.recordPreparedInput(supplement.id, supplement.message)
  expect(store.injectIntoRun(supplement.id, task.id)).toBe(true)
  store.settle(user.id, "completed", null)
  if (action === "replace") {
    store.recordWorkResultEvidence(task.id, {
      callId: revisedReceipt.callId, assistantMessageId: "replacement-anchor", files: [revised]
    })
  }
  store.settleRun(task.id, [supplement.id], "completed", null, "Updated result and explanation")

  const review = startReview(store, work.id)
  const context = store.getWorkResultReview(review.id)!
  const defaults = context.defaultAttachments
  expect(defaults).toEqual(action === "replace" ? [revisedReceipt] : [])
  expect(context.requests.at(-1)?.text).toBe(message)
  const reader = createBotResultEvidenceReader(
    { botId: bot.id, workId: work.id, threadId: work.threadId, executionTaskId: task.id, reviewTaskId: review.id },
    () => context.evidence.flatMap(execution => execution.deliveries.map(delivery => ({
      ...delivery, kind: "snapshot" as const, root: "/retained"
    })))
  )
  const catalogue = reader.list().items
  const originalId = catalogue.find(item => item.reference.callId === originalReceipt.callId)!.id
  const defaultIds = catalogue.filter(item => defaults.some(ref =>
    ref.sourceTaskId === item.reference.sourceTaskId && ref.callId === item.reference.callId &&
    ref.fileIndex === item.reference.fileIndex
  )).map(item => item.id)
  const report = { kind: "ready", summary: "Updated result and explanation", evidenceIds: [] }
  const invoke = vi.fn().mockResolvedValue(JSON.stringify({
    ...report,
    ...(action === "retain" ? { attachments: [originalId] } : action === "withdraw" ? { attachments: [] } : {})
  }))
  const decision = await reviewBotWorkResult({
    ...context, catalogue, attachmentDefaults: { ids: defaultIds, unlisted: defaults.length - defaultIds.length }
  }, invoke, (id, signal) => reader.read(id, { signal }), new AbortController().signal)
  expect(invoke).toHaveBeenCalledOnce()
  expect(decision?.kind ?? null).toBe(action === "omit" ? null : "ready")
  store.commitWorkResultReview(review.id, decision,
    decision && decision.kind !== "repair" && decision.attachments?.includes(originalId) ? [originalReceipt] : [])
  store.settle(review.id, "completed", null)

  store.flushReplies()
  const publication = publicationTask(store, work.id)!
  store.transition(publication.id, "running")
  const expected = action === "retain"
    ? [{ ...originalReceipt, assistantMessageId: "original-anchor", file: old }]
    : action === "replace"
      ? [{ ...revisedReceipt, assistantMessageId: "replacement-anchor", file: revised }]
      : []
  expect(store.getWorkResultPublication(publication.id)).toMatchObject({ kind, attachments: expected })
  const mirror = vi.spyOn(store.im, "mirrorPersonal")
  expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
  expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(false)
  expect(mirror).toHaveBeenCalledOnce()
  expect(mirror.mock.calls[0].slice(0, 3)).toEqual([
    expect.objectContaining({ id: publication.id }), expect.any(String), expected.map(item => item.file)
  ])
})

it.each(["interrupted", "unverified"])("keeps eight exact files and reports the remainder when %s", mode => {
  const { store, bot, start } = fixture()
  const bindingId = bindPersonalIm(store, bot.id)
  const { work, task } = start()
  const duplicate = { filePath: "/work/report-0.zip", attachmentPath: "/retained/old/report-0.zip",
    name: "report-0.zip", size: 3 }
  store.recordWorkResultEvidence(task.id, { callId: "superseded", assistantMessageId: "old-card", files: [duplicate] })
  for (let index = 0; index < 10; index++) {
    const name = `report-${index}.zip`
    store.recordWorkResultEvidence(task.id, {
      callId: `delivery-${index}`, assistantMessageId: `card-${index}`,
      files: [{ filePath: `/work/${name}`, attachmentPath: `/retained/${name}`, name, size: 3 }]
    })
  }
  store.settle(task.id, mode === "interrupted" ? "interrupted" : "completed", null)
  if (mode === "unverified") {
    const review = startReview(store, work.id)
    expect(store.commitWorkResultReview(review.id, null).state).toBe("publish")
    store.settle(review.id, "completed", null)
  }
  store.flushReplies()
  const publication = publicationTask(store, work.id)!
  store.transition(publication.id, "running")
  const result = store.getWorkResultPublication(publication.id)!
  expect(result).toMatchObject({
    kind: mode === "interrupted" ? "interrupted" : "blocked",
    moreAttachments: { count: 2, messageId: "card-1" }
  })
  expect(result.attachments.map(item => item.callId)).toEqual(
    Array.from({ length: 8 }, (_, index) => `delivery-${9 - index}`)
  )
  expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
  expect(store.im.beginDelivery("text")).toMatchObject({ bindingId, workId: work.id,
    text: expect.stringContaining("原任务还有 2 个文件可查看。请在 CmbCowork 中打开原任务。") })
  expect(store.im.fileStatuses(bot.id, work.threadId, "delivery-1")).toEqual([])
  expect(store.im.fileStatuses(bot.id, work.threadId, "superseded")).toEqual([])
})

it.each([
  { count: 9, explicitCount: undefined, sent: 9, remaining: 0 },
  { count: 18, explicitCount: undefined, sent: 16, remaining: 2 },
  { count: 18, explicitCount: 8, sent: 8, remaining: 10 },
  { count: 18, explicitCount: 0, sent: 0, remaining: 0 }
])("publishes $sent of $count formal files and exposes any capped remainder (selection=$explicitCount)", ({
  count, explicitCount, sent, remaining
}) => {
  const { db, store, bot, start } = fixture()
  const bindingId = bindPersonalIm(store, bot.id)
  const { work, task } = start()
  const files = Array.from({ length: count }, (_, index) => {
    const name = `report-${index}.zip`
    return { filePath: `/work/${name}`, attachmentPath: `/retained/${name}`, name, size: index }
  })
  store.recordWorkResultEvidence(task.id, {
    callId: "superseded", assistantMessageId: "old-card",
    files: [{ ...files[0], attachmentPath: "/retained/old/report-0.zip" }]
  })
  for (let offset = 0; offset < files.length; offset += 8) {
    store.recordWorkResultEvidence(task.id, {
      callId: `delivery-${offset}`, assistantMessageId: `card-${offset}`, files: files.slice(offset, offset + 8)
    })
  }
  store.settle(task.id, "completed", null, "Reports prepared")
  const review = startReview(store, work.id)
  const defaults = store.getWorkResultReview(review.id)!.defaultAttachments
  expect(defaults).toHaveLength(Math.min(count, 16))
  const expected = files.slice().reverse().slice(0, sent)
  const selected = explicitCount === undefined ? undefined : defaults.slice(0, explicitCount)
  const decision = {
    kind: "ready" as const, summary: "Reports verified", evidenceIds: [],
    ...(selected ? { attachments: selected.map((_, index) => index.toString(16).padStart(64, "0")) } : {})
  }
  const committed = store.commitWorkResultReview(review.id, decision, selected)
  if (committed.state !== "publish") throw new Error("Expected a publication")
  expect(committed.publication.attachments.map(item => item.file)).toEqual(expected)
  expect(committed.publication.moreAttachments).toEqual(remaining ? {
    count: remaining, messageId: `card-${Math.floor((count - sent - 1) / 8) * 8}`
  } : undefined)
  store.settle(review.id, "completed", null)
  store.flushReplies()
  const publication = publicationTask(store, work.id)!
  store.transition(publication.id, "running")
  expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
  expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(false)

  const text = store.im.beginDelivery("text")!
  expect(text).toMatchObject({ bindingId, workId: work.id, text: remaining
    ? `Reports verified\n\n原任务还有 ${remaining} 个文件可查看。请在 CmbCowork 中打开原任务。` : "Reports verified" })
  const received: BotDeliveredFile[] = []
  for (let index = 0; index < expected.length; index++) {
    const row = store.im.beginDelivery("file")!
    expect(row).toMatchObject({ bindingId, workId: work.id, sourceTaskId: publication.id })
    expect(row.files).toHaveLength(1)
    received.push(row.files![0])
    store.im.delivered(row.id, "sent")
  }
  expect(received).toEqual(expect.arrayContaining(expected))
  expect(store.im.beginDelivery("file")).toBeNull()
  expect(store.im.fileStatuses(bot.id, work.threadId, "superseded")).toEqual([])
  expect(db.exec("SELECT COUNT(*) FROM bot_im_outbox WHERE source_task_id=?", [publication.id])[0].values[0][0])
    .toBe(sent + 1)
})

it("sends only the ninth file after an eight-file interrupted IM publication", () => {
  const { store, bot, start } = fixture()
  const bindingId = bindPersonalIm(store, bot.id)
  const { work, task } = start()
  const files = Array.from({ length: 9 }, (_, index) => {
    const name = `report-${index}.zip`
    return { filePath: `/work/${name}`, attachmentPath: `/retained/${name}`, name, size: index }
  })
  store.recordWorkResultEvidence(task.id, { callId: "first", files: files.slice(0, 8) })
  store.recordWorkResultEvidence(task.id, { callId: "second", files: files.slice(8) })
  store.settle(task.id, "outcome_unknown", "Completion unconfirmed")
  store.flushReplies()
  const interrupted = publicationTask(store, work.id)!
  store.transition(interrupted.id, "running")
  expect(store.getWorkResultPublication(interrupted.id)?.attachments.map(item => item.file))
    .toEqual(files.slice(1).reverse())
  expect(store.acknowledgeWorkResultPublication(interrupted.id)).toBe(true)
  store.settle(interrupted.id, "completed", null)
  for (let index = 0; index < 8; index++) {
    const row = store.im.beginDelivery("file")!
    store.im.delivered(row.id, "sent")
  }

  const user = store.enqueue({ botId: bot.id, requestId: "continue-review", message: "Check the saved reports." })
  store.transition(user.id, "running")
  store.recordPreparedInput(user.id, user.message)
  store.changeWork(bot.id, work.id, store.getWork(bot.id, work.id).version, "continue", "continue",
    { taskId: user.id, callId: "continue", key: "continue" })
  store.settle(user.id, "completed", null)
  const review = startReview(store, work.id)
  const committed = store.commitWorkResultReview(review.id, { kind: "ready", summary: "Verified", evidenceIds: [] })
  expect(committed.state).toBe("publish")
  store.settle(review.id, "completed", null)
  store.flushReplies()
  const final = store.recentTasks().find(item => item.state === "queued" && item.origin.kind === "work_result" &&
    item.origin.review?.phase === "publish" && item.origin.workId === work.id)!
  store.transition(final.id, "running")
  expect(store.getWorkResultPublication(final.id)?.attachments.map(item => item.file)).toEqual(files.slice().reverse())
  expect(store.acknowledgeWorkResultPublication(final.id)).toBe(true)
  expect(store.im.beginDelivery("file")).toMatchObject({ bindingId, sourceTaskId: final.id, files: [files[0]] })
  expect(store.im.beginDelivery("file")).toBeNull()
})

it("exposes only acknowledged exact versions to the original attachment cards and retries one failed file", () => {
  const { store, bot, start } = fixture()
  const bindingId = bindPersonalIm(store, bot.id)
  const { work, task } = start()
  const file = { filePath: "/work/report.csv", attachmentPath: `/work/.bot-deliveries/${"b".repeat(64)}/report.csv`,
    name: "report.csv", size: 3 }
  const draft = { ...file, attachmentPath: `/work/.bot-deliveries/${"a".repeat(64)}/report.csv` }
  const other = { filePath: "/work/checks.txt", attachmentPath: `/work/.bot-deliveries/${"c".repeat(64)}/checks.txt`,
    name: "checks.txt", size: 5 }
  store.recordWorkResultEvidence(task.id, { callId: "draft", files: [draft] })
  store.recordWorkResultEvidence(task.id, { callId: "confirmed", files: [file, other] })
  store.settle(task.id, "completed", null, "Report prepared")
  const review = startReview(store, work.id)
  expect(store.commitWorkResultReview(review.id, { kind: "ready", summary: "Report verified", evidenceIds: [] }).state)
    .toBe("publish")
  store.settle(review.id, "completed", null)
  store.flushReplies()
  const publication = publicationTask(store, work.id)!
  store.transition(publication.id, "running")
  const statuses = (callId = "confirmed") => store.im.fileStatuses(bot.id, work.threadId, callId)
  expect(store.im.beginDelivery("file")).toBeNull()
  expect(statuses()).toEqual([])

  expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
  expect(statuses("draft")).toEqual([])
  expect(statuses()).toEqual(expect.arrayContaining([
    expect.objectContaining({ file, state: "pending" }), expect.objectContaining({ file: other, state: "pending" })
  ]))
  const [first, second] = [store.im.beginDelivery("file")!, store.im.beginDelivery("file")!]
  expect(first).toMatchObject({ sourceTaskId: publication.id, bindingId })
  expect(second).toMatchObject({ sourceTaskId: publication.id, bindingId })
  const failed = first.files?.[0].filePath === file.filePath ? first : second
  const untouched = failed === first ? second : first
  store.im.delivered(failed.id, "failed", "FILE_REJECTED")
  store.im.delivered(untouched.id, "sent")
  expect(statuses()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: failed.id, file, state: "failed", reasonCode: "FILE_REJECTED" }),
    expect.objectContaining({ id: untouched.id, file: other, state: "sent" })
  ]))
  store.im.retryFile(bot.id, failed.id)
  expect(statuses()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: failed.id, file, state: "pending" }),
    expect.objectContaining({ id: untouched.id, file: other, state: "sent" })
  ]))
  expect(store.im.beginDelivery("file")).toMatchObject({
    id: failed.id, fileDeliveryId: failed.fileDeliveryId, retryRequested: true, files: [file]
  })
  expect(store.im.beginDelivery("file")).toBeNull()
})

it.each([
  { previousState: "pending", differentSnapshot: false, queuesFile: false },
  { previousState: "sending", differentSnapshot: false, queuesFile: false },
  { previousState: "accepted", differentSnapshot: false, queuesFile: false },
  { previousState: "sent", differentSnapshot: false, queuesFile: false },
  { previousState: "sent", differentSnapshot: true, queuesFile: true },
  { previousState: "failed", differentSnapshot: false, queuesFile: true },
  { previousState: "unknown", differentSnapshot: false, queuesFile: false },
  { previousState: "unknown", differentSnapshot: true, queuesFile: true },
  { previousState: "sent", differentSnapshot: false, queuesFile: false, mixed: true },
  { previousState: "sent", differentSnapshot: false, queuesFile: true, mixed: true, otherState: "failed" },
  { previousState: "pending", differentSnapshot: false, queuesFile: false, routeChange: "revoked" },
  { previousState: "sent", differentSnapshot: false, queuesFile: true, routeChange: "other" }
] as const)("keeps personal IM delivery exact when a result review resumes ($previousState, different=$differentSnapshot, mixed=$mixed, other=$otherState, route=$routeChange)", ({
  previousState, differentSnapshot, queuesFile, mixed = false, otherState = "unknown" as const, routeChange
}) => {
  // The interruption and final publication can share a timestamp.
  const now = Date.now() + 1_000
  const { db, store, bot, start } = fixture(() => now)
  const bindingId = bindPersonalIm(store, bot.id)
  const otherRealm = "other-realm"
  const otherBindingId = routeChange === "other" ? bindPersonalIm(store, bot.id, otherRealm) : undefined
  if (otherBindingId) bindPersonalIm(store, bot.id)
  if (previousState === "pending") store.im.setAllOffline()

  const { work, task } = start()
  const draft = { filePath: "/work/report.csv", attachmentPath: `/work/.bot-deliveries/${"a".repeat(64)}/report.csv`,
    name: "report.csv", size: 3 }
  const latest = { ...draft, attachmentPath: `/work/.bot-deliveries/${"b".repeat(64)}/report.csv` }
  const other = { filePath: "/work/checks.txt", attachmentPath: `/work/.bot-deliveries/${"c".repeat(64)}/checks.txt`,
    name: "checks.txt", size: 5 }
  const draftRef = { sourceTaskId: task.id, callId: "draft", fileIndex: 0 }
  const latestRef = { sourceTaskId: task.id, callId: "latest", fileIndex: mixed ? 1 : 0 }
  const otherRef = { sourceTaskId: task.id, callId: "latest", fileIndex: 0 }
  const status = (callId: string, file: typeof draft) => store.im.fileStatuses(bot.id, work.threadId, callId)
    .find(item => item.file.filePath === file.filePath && item.file.attachmentPath === file.attachmentPath)
  store.recordWorkResultEvidence(task.id, { callId: draftRef.callId, files: [draft] })
  store.recordWorkResultEvidence(task.id, { callId: latestRef.callId, files: mixed ? [other, latest] : [latest] })
  store.settle(task.id, "outcome_unknown", "Completion unconfirmed")

  const publish = (kind: "interrupted" | "ready", files: typeof draft[]) => {
    store.flushReplies()
    const publication = store.recentTasks().find(item => item.state === "queued" &&
      item.origin.kind === "work_result" && item.origin.review?.phase === "publish" && item.origin.workId === work.id)
    if (!publication) throw new Error("Expected a queued publication")
    store.transition(publication.id, "running")
    const result = store.getWorkResultPublication(publication.id)
    expect(result?.kind).toBe(kind)
    expect(result?.attachments.map(item => item.file)).toEqual(files)
    expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    store.settle(publication.id, "completed", null)
    return publication
  }

  const interruption = publish("interrupted", mixed ? [latest, other] : [latest])
  const initialFileId = `im-personal-${interruption.id}:file:0`
  if (previousState === "pending") {
    expect(store.im.beginDelivery("file")).toBeNull()
  } else {
    const initialRows = Array.from({ length: mixed ? 2 : 1 }, () => store.im.beginDelivery("file"))
    expect(initialRows).toContainEqual(expect.objectContaining({
      id: initialFileId, fileDeliveryId: initialFileId, sourceTaskId: interruption.id, bindingId, files: [latest]
    }))
    if (previousState === "sending") store.im.progress(initialFileId, 37)
    else store.im.delivered(initialFileId, previousState)
    if (mixed) store.im.delivered(initialRows.find(row => row && row.id !== initialFileId)!.id, otherState)
  }
  expect(status(latestRef.callId, latest)).toMatchObject({ id: initialFileId, state: previousState })
  expect(status(draftRef.callId, draft)).toBeUndefined()

  if (routeChange === "revoked") {
    const route = store.imGateway.binding(bindingId)!
    store.imGateway.register(route.realm, route.principal, { ...route.binding, version: 2, state: "revoked" })
    store.im.revoke(bot.id, bindingId, 1)
    expect(status(latestRef.callId, latest)).toMatchObject({ id: initialFileId, state: "blocked" })
  } else if (otherBindingId) {
    // Restore a route that was already authorized before the work was admitted.
    expect(bindPersonalIm(store, bot.id, otherRealm)).toBe(otherBindingId)
  }

  const user = store.enqueue({ botId: bot.id, requestId: "continue-review", message: "Continue checking the saved reports." })
  store.transition(user.id, "running")
  store.recordPreparedInput(user.id, user.message)
  const current = store.getWork(bot.id, work.id)
  store.changeWork(bot.id, work.id, current.version, "continue", "continue",
    { taskId: user.id, callId: "continue", key: "continue" })
  store.settle(user.id, "completed", null, "The original review will continue.")
  const review = startReview(store, work.id)
  const selected = differentSnapshot ? draft : latest
  const selectedRef = differentSnapshot ? draftRef : latestRef
  expect(store.commitWorkResultReview(review.id, {
    kind: "ready", summary: "Report verified.", evidenceIds: [],
    attachments: mixed ? ["a".repeat(64), "b".repeat(64)] : ["a".repeat(64)]
  }, mixed ? [selectedRef, otherRef] : [selectedRef]).state).toBe("publish")
  store.settle(review.id, "completed", null)

  const final = publish("ready", mixed ? [selected, other] : [selected])
  expect(db.exec(`SELECT COUNT(*) FROM bot_im_outbox WHERE source_task_id=? AND file_delivery_id IS NOT NULL`,
    [final.id])[0].values).toEqual([[queuesFile ? 1 : 0]])
  if (queuesFile) {
    const queued = mixed ? other : selected
    const ref = mixed ? otherRef : selectedRef
    const delivery = store.im.beginDelivery("file")!
    expect(delivery).toMatchObject({
      id: `im-personal-${final.id}:file:0`, fileDeliveryId: `im-personal-${final.id}:file:0`,
      sourceTaskId: final.id, bindingId: otherBindingId ?? bindingId, files: [queued]
    })
    expect(status(ref.callId, queued)).toMatchObject({ id: delivery.id, state: "sending" })
    store.im.delivered(delivery.id, "sent")
    expect(status(ref.callId, queued)).toMatchObject({ id: delivery.id, state: "sent" })
  } else if (routeChange === "revoked") {
    expect(status(latestRef.callId, latest)).toMatchObject({ id: initialFileId, state: "blocked" })
    expect(store.im.beginDelivery("text")).toBeNull()
  } else {
    expect(status(latestRef.callId, latest)).toMatchObject({
      id: initialFileId, state: previousState, ...(previousState === "sending" ? { progress: 37 } : {})
    })
    if (previousState === "pending") {
      expect(store.im.beginDelivery("file")).toBeNull()
      store.im.setOnline(bot.id, bindingId, true)
      expect(store.im.beginDelivery("file")).toMatchObject({
        id: initialFileId, fileDeliveryId: initialFileId, sourceTaskId: interruption.id, bindingId, files: [latest]
      })
      expect(store.im.beginDelivery("file")).toBeNull()
      store.im.delivered(initialFileId, "failed", "FILE_REJECTED")
      const failed = status(latestRef.callId, latest)!
      expect(failed).toMatchObject({ id: initialFileId, state: "failed", reasonCode: "FILE_REJECTED" })
      store.im.retryFile(bot.id, failed.id)
      expect(store.im.beginDelivery("file")).toMatchObject({
        id: initialFileId, fileDeliveryId: initialFileId, retryRequested: true, files: [latest]
      })
      store.im.delivered(initialFileId, "sent")
    } else if (previousState === "sending") {
      expect(store.im.mayDeliver(initialFileId)).toBe(true)
      store.im.delivered(initialFileId, "sent")
    } else if (previousState === "accepted") {
      expect(store.im.receiptBatch()).toMatchObject([{ id: initialFileId, fileDeliveryId: initialFileId }])
      store.im.receipt(initialFileId, "sent")
    }
    expect(status(latestRef.callId, latest)).toMatchObject({
      id: initialFileId, state: previousState === "unknown" ? "unknown" : "sent"
    })
  }
  if (mixed || differentSnapshot)
    expect(status(latestRef.callId, latest)).toMatchObject({ id: initialFileId, state: previousState })
  const uncertain = previousState === "unknown" ? status(latestRef.callId, latest)
    : mixed && otherState === "unknown" ? status(otherRef.callId, other) : undefined
  if (uncertain) {
    expect(uncertain).toMatchObject({
      id: `im-personal-${interruption.id}:file:${mixed ? 1 : 0}`, state: "unknown"
    })
    expect(() => store.im.retryFile(bot.id, uncertain.id)).toThrow("送达不确定")
  }
  expect(store.im.beginDelivery("file")).toBeNull()
  if (routeChange !== "revoked")
    expect(Array.from({ length: 3 }, () => store.im.beginDelivery("text"))).toContainEqual(
      expect.objectContaining({ sourceTaskId: final.id, bindingId: otherBindingId ?? bindingId, text: "Report verified." })
    )
})

it("retries only the same durable publication after a recoverable dispatch error", async () => {
  const f = fixture()
  const work = commitReadyResult(f)
  const ids: string[] = []
  const mirrors = vi.spyOn(f.store.im, "mirrorPersonal")
  const host = new LocalBotHost(f.store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({
      release() {},
      async execute() {
        ids.push(task.id)
        if (ids.length === 1) throw new RetryableBotWorkPublicationError()
        expect(host.workResultPublication(task.id)?.summary).toBe("Report verified")
        expect(host.acknowledgeWorkResultPublication(task.id)).toBe(true)
        return { state: "completed" as const }
      }
    })
  })
  try {
    await vi.waitFor(() => expect(publicationTask(f.store, work.id)?.state).toBe("completed"))
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(1)
    expect(mirrors).toHaveBeenCalledOnce()
  } finally {
    await host.stop()
  }
})

it("aborts an active publication on full Stop and does not retry an error during cancellation", async () => {
  const f = fixture()
  const work = commitReadyResult(f)
  let publicationSignal: AbortSignal | undefined
  const acquire = vi.fn(() => ({
    release() {},
    async execute(signal: AbortSignal) {
      publicationSignal = signal
      if (!signal.aborted)
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
      throw new RetryableBotWorkPublicationError()
    }
  }))
  const host = new LocalBotHost(f.store, { onAvailable: () => () => {}, acquire })
  try {
    await vi.waitFor(() => expect(publicationSignal).toBeDefined())
    host.stopWork(f.bot.id, work.id)
    expect(publicationSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(host.hasActiveRuns()).toBe(false))
    expect(publicationTask(f.store, work.id)?.state).toBe("cancelled")
    expect(acquire).toHaveBeenCalledOnce()
  } finally {
    await host.stop()
  }
})

it("keeps a retry across recovery and bounds repeated failures", () => {
  const f = fixture()
  const work = commitReadyResult(f)
  f.store.flushReplies()
  const pending = publicationTask(f.store, work.id)!
  f.store.transition(pending.id, "running")
  expect(f.store.retryWorkResultPublication(pending.id)).toBe(true)
  const reopened = new BotStore(f.db)
  reopened.recover()
  expect(reopened.nextQueued([])?.id).toBe(pending.id)
  reopened.transition(pending.id, "running")
  expect(reopened.retryWorkResultPublication(pending.id)).toBe(true)
  reopened.transition(pending.id, "running")
  expect(reopened.retryWorkResultPublication(pending.id)).toBe(false)
  reopened.settle(pending.id, "failed", "投递未确认")
  reopened.recover()
  expect(reopened.nextQueued([])).toBeNull()
})
