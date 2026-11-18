import { afterEach, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { buildAttachmentMessageParts } from "../../shared/attachment-message-parts"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))

function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  let now = 1000
  const store = new BotStore(db, () => now)
  const bot = store.create({ name: "Inputs", instructions: "", color: "#ea2845", modelRef: null })
  const pick = (botId = bot.id, workId?: string) => store.retainInputFile(botId, {
    filename: "sample.txt", filePath: "/editable/sample.txt", content: "selected bytes",
    size: 14, mimeType: "text/plain", truncated: false
  }, `/fixture/.bot-deliveries/${"a".repeat(64)}/sample.txt`, workId)
  const original = pick()
  const message = "Create a work with the selected input" + buildAttachmentMessageParts([original]).attachmentModelBlocks
  const source = store.enqueue({ botId: bot.id, requestId: "source", message, inputFileIds: [original.botInputId!] })
  store.transition(source.id, "running")
  store.recordPreparedInput(source.id, message)
  const input = { botId: bot.id, operationId: "create", title: "Read input", goal: "Read the selected input",
    inputFileIds: [original.botInputId!] }
  const command = { taskId: source.id, callId: "create", key: "create" }
  const created = store.createWork(input, command)
  if (created.task.origin.kind !== "work") throw new Error("Expected create dispatch")
  const copiedId = created.task.origin.inputFileIds![0]
  const target = { botId: bot.id, workId: created.work.id, threadId: created.work.threadId,
    version: created.work.version, incarnation: null }
  const legacy = () => db.run("UPDATE bot_input_files SET payload=json_remove(payload,'$.workId') WHERE id=?", [copiedId])
  return { db, store, bot, pick, original, source, input, command, created, copiedId, target, legacy,
    advance: (ms: number) => { now += ms } }
}

it("owns the first transferred clone and deletes it only after successful work cleanup", () => {
  const f = fixture()
  const other = f.store.createWork({ botId: f.bot.id, operationId: "other", title: "Other", goal: "Other work" })
  const otherFile = f.pick(f.bot.id, other.work.id)
  const peer = f.store.create({ name: "Other Bot", instructions: "", color: "#ea2845", modelRef: null })
  const peerFile = f.pick(peer.id)
  expect(f.copiedId).not.toBe(f.original.botInputId)
  expect(f.store.inputFiles(f.bot.id, [f.copiedId])[0].workId).toBe(f.created.work.id)
  expect(f.store.createWork(f.input, f.command).task.id).toBe(f.created.task.id)
  expect(f.db.exec("SELECT COUNT(*) FROM bot_input_files")[0].values).toEqual([[4]])
  const stopping = f.store.beginWorkDeletion(f.target)
  expect(f.store.inputFiles(f.bot.id, [f.copiedId])[0].attachment?.content).toBe("selected bytes")
  // A failed physical cleanup leaves a retryable fence and retained input.
  const restarted = new BotStore(f.db)
  expect(restarted.beginWorkDeletion(f.target)).toEqual(stopping)
  const ready = restarted.advanceWorkDeletion(stopping, "ready")
  expect(restarted.inputFiles(f.bot.id, [f.copiedId])).toHaveLength(1)
  restarted.advanceWorkDeletion(ready, "deleted")
  expect(() => restarted.inputFiles(f.bot.id, [f.copiedId])).toThrow("不可用")
  expect(restarted.inputFiles(f.bot.id, [f.original.botInputId!, otherFile.botInputId!])).toHaveLength(2)
  expect(restarted.inputFiles(peer.id, [peerFile.botInputId!])).toHaveLength(1)
})

it.each(["live", "archived"] as const)("binds a legacy cloned ID from exact %s creation evidence before history disappears", location => {
  const f = fixture()
  f.legacy()
  expect(f.store.inputFiles(f.bot.id, [f.copiedId])[0].workId).toBeUndefined()
  if (location === "archived") {
    f.store.transition(f.created.task.id, "cancelled")
    f.advance(1)
    const latest = f.store.enqueue({ botId: f.bot.id, workId: f.created.work.id, requestId: "latest", message: "Later input" })
    f.store.transition(latest.id, "cancelled")
    for (let i = 0; i < 100; i++) {
      const tail = f.store.enqueue({ botId: f.bot.id, requestId: `tail-${i}`, message: "Later request" })
      f.store.transition(tail.id, "cancelled")
    }
    f.advance(31 * 86400000)
    f.store.pruneTaskHistory()
    expect(() => f.store.getTask(f.created.task.id)).toThrow()
    expect(f.db.exec("SELECT id FROM bot_exchange_archive WHERE id=?", [f.created.task.id])[0].values)
      .toEqual([[f.created.task.id]])
    f.target.version = f.store.getWork(f.bot.id, f.created.work.id).version
  }
  const stopping = f.store.beginWorkDeletion(f.target)
  expect(f.store.inputFiles(f.bot.id, [f.copiedId])[0].workId).toBe(f.created.work.id)
  // Native thread cleanup may erase the last history record after the fence.
  f.db.run("DELETE FROM bot_tasks WHERE id=?", [f.created.task.id])
  f.db.run("DELETE FROM bot_exchange_archive WHERE id=?", [f.created.task.id])
  const restarted = new BotStore(f.db)
  expect(restarted.beginWorkDeletion(f.target)).toEqual(stopping)
  restarted.advanceWorkDeletion(restarted.advanceWorkDeletion(stopping, "ready"), "deleted")
  expect(() => restarted.inputFiles(f.bot.id, [f.copiedId])).toThrow("不可用")
  expect(restarted.inputFiles(f.bot.id, [f.original.botInputId!])[0].workId).toBeUndefined()
})

it.each(["follow_up", "wrong_thread", "missing", "already_owned"] as const)("does not claim unproven legacy input (%s)", evidence => {
  const f = fixture()
  f.legacy()
  if (evidence === "follow_up")
    f.db.run("UPDATE bot_tasks SET origin_json=json_set(origin_json,'$.dispatch','follow_up') WHERE id=?", [f.created.task.id])
  if (evidence === "wrong_thread")
    f.db.run("UPDATE bot_tasks SET thread_id='another-thread' WHERE id=?", [f.created.task.id])
  if (evidence === "missing") f.db.run("DELETE FROM bot_tasks WHERE id=?", [f.created.task.id])
  if (evidence === "already_owned")
    f.db.run("UPDATE bot_input_files SET payload=json_set(payload,'$.workId','another-work') WHERE id=?", [f.copiedId])
  const stopping = f.store.beginWorkDeletion(f.target)
  f.store.advanceWorkDeletion(f.store.advanceWorkDeletion(stopping, "ready"), "deleted")
  expect(f.store.inputFiles(f.bot.id, [f.copiedId])[0].workId)
    .toBe(evidence === "already_owned" ? "another-work" : undefined)
})

it("keeps the original main-chat ID used by an explicit skill draft", () => {
  const f = fixture()
  const draft = f.store.createWork({ botId: f.bot.id, operationId: "skill", title: "Skill", goal: "Review input",
    inputFileIds: [f.original.botInputId!], explicitSkill: { name: "review", path: "/skills/review/SKILL.md" } })
  const target = { botId: f.bot.id, workId: draft.work.id, threadId: draft.work.threadId,
    version: draft.work.version, incarnation: null }
  expect(draft.task.origin).toMatchObject({ kind: "user", inputFileIds: [f.original.botInputId!] })
  const stopping = f.store.beginWorkDeletion(target)
  f.store.advanceWorkDeletion(f.store.advanceWorkDeletion(stopping, "ready"), "deleted")
  expect(f.store.inputFiles(f.bot.id, [f.original.botInputId!])[0].workId).toBeUndefined()
})

it("clears a deleted detached thread's work inputs while retaining other receipts and its published result", () => {
  const { store, bot, pick, original, source, created, copiedId } = fixture()
  store.settle(source.id, "completed", null)
  const conversation = {
    kind: "local_thread" as const, threadId: "original", incarnation: { token: "original", legacyCreatedAt: 1 }
  }
  const { id: workId } = store.conversations.prepare({
    botId: bot.id, operationId: "link", title: "Original", goal: "Continue", conversation
  })
  store.conversations.bound(bot.id, workId, conversation)
  const attachment = pick(bot.id, workId)
  const workInputId = attachment.botInputId!
  const message = "Review this file" + buildAttachmentMessageParts([attachment]).attachmentModelBlocks
  const execution = store.enqueue({ botId: bot.id, workId, requestId: "linked-input", message, inputFileIds: [workInputId] })
  store.transition(execution.id, "running")
  store.recordPreparedInput(execution.id, message)
  expect(store.armWorkResultReview(execution.id, "incarnation", true)).toBe(true)
  store.recordWorkResultEvidence(execution.id, { finalMessageId: "final" })
  store.settle(execution.id, "completed", null, "Report ready")
  store.flushReplies()
  const review = store.recentTasks().find(task => task.origin.kind === "work_result" && task.origin.review?.phase === "review")!
  store.transition(review.id, "running")
  const result = store.commitWorkResultReview(review.id, { kind: "ready", summary: "Report verified", evidenceIds: [] })
  if (result.state !== "publish") throw new Error("Expected a publication")
  store.settle(review.id, "completed", null)
  store.flushReplies()
  const publication = store.recentTasks().find(task => task.requestId === result.publication.id)!
  store.transition(publication.id, "running")
  expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
  store.settle(publication.id, "completed", null)

  store.conversations.beginDetach(bot.id, workId, store.getWork(bot.id, workId).version)
  store.conversations.detached(bot.id, workId)
  expect(store.inputFiles(bot.id, [workInputId])[0].attachment?.content).toBe("selected bytes")
  store.removeMessageReactionsForThreads([conversation.threadId])

  expect(() => store.getWork(bot.id, workId)).toThrow()
  expect(() => store.inputFiles(bot.id, [workInputId])).toThrow("不可用")
  expect(store.inputFiles(bot.id, [original.botInputId!, copiedId]).map(file => file.workId))
    .toEqual([undefined, created.work.id])
  expect(store.hasPublishedWorkResultMessage(result.publication)).toBe(true)
})

it("rolls back the newly inserted work when transfer validation fails", () => {
  const f = fixture()
  const unapproved = f.pick()
  const count = f.db.exec("SELECT COUNT(*) FROM bot_work_items")[0].values
  expect(() => f.store.createWork({ ...f.input, operationId: "denied", inputFileIds: [unapproved.botInputId!] },
    { ...f.command, callId: "denied", key: "denied" })).toThrow()
  expect(f.db.exec("SELECT COUNT(*) FROM bot_work_items")[0].values).toEqual(count)
  expect(f.store.inputFiles(f.bot.id, [unapproved.botInputId!])[0].workId).toBeUndefined()
})
