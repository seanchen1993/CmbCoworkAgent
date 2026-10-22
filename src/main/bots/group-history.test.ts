import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UserInputRequest } from "../types"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { botIdentifier } from "../../shared/bots/validation"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

function historyFixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db)
  const bot = store.create({ name: "History", instructions: "", color: "#ea2845", modelRef: null })
  const a = store.saveGroup({ name: "A", memberIds: [bot.id] })
  const b = store.saveGroup({ name: "B", memberIds: [bot.id] })
  for (let index = 1; index <= 80; index++) {
    for (const [prefix, groupId, offset] of [
      ["a", a.id, 0],
      ["b", b.id, 50]
    ] as const) {
      db.run(
        `INSERT INTO bot_group_messages
         (ordinal,id,group_id,author_bot_id,text,targets_json,created_at,reply_to_id)
         VALUES (?,?,?,NULL,?,'[]',?,?)`,
        [
          index * 100 + offset,
          `${prefix}-${index}`,
          groupId,
          `${prefix} ${index}`,
          index,
          index === 40 ? `${prefix}-39` : null
        ]
      )
    }
  }
  return { store, a, b }
}

describe("bounded group history windows", () => {
  it("resolves a delayed group handoff to its original request beyond the latest history page", () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    databases.push(db)
    let store = new BotStore(db, () => 1000)
    const a = store.create({ name: "A", instructions: "", color: "#ea2845", modelRef: null })
    const b = store.create({ name: "B", instructions: "", color: "#ea2845", modelRef: null })
    const group = store.saveGroup({ name: "Room", memberIds: [a.id, b.id] })
    const original = "Original report " + "row;".repeat(600) + " retain the final note."
    store.sendGroup({
      groupId: group.id,
      requestId: "original",
      text: original,
      targetBotIds: [a.id]
    })
    const root = store.recentTasks()[0]
    store.transition(root.id, "running")
    const child = store.delegate(root.id, b.id, "Prepare the report", "report")
    store.settle(root.id, "completed", null, "Delegated")
    for (let i = 0; i < 55; i++) {
      db.run(
        "INSERT INTO bot_group_messages (id,group_id,author_bot_id,text,targets_json,created_at) VALUES (?,?,NULL,?,'[]',?)",
        [`later-${i}`, group.id, `Unrelated later question ${i}`, 1001 + i]
      )
    }
    expect(store.groupMessages(group.id).some((m) => m.id === "original")).toBe(false)
    const expected = { id: "original", text: original, createdAt: 1000 }
    expect(store.groupTaskRequest(child.id)).toEqual(expected)
    store.transition(child.id, "running")
    store.settle(child.id, "completed", null, "Prepared")
    store.flushReplies()
    const callback = store.recentTasks().find((t) => t.requestId === `reply-${child.id}`)!
    store = new BotStore(db, () => 2000)
    expect(store.groupTaskRequest(callback.id)).toEqual(expected)
    expect(store.groupTaskRequest(root.id)).toBeNull()
    const other = store.saveGroup({ name: "Other room", memberIds: [a.id, b.id] })
    db.run("UPDATE bot_group_messages SET group_id=? WHERE id='original'", [other.id])
    expect(store.groupTaskRequest(callback.id)).toBeNull()
    db.run("UPDATE bot_group_messages SET group_id=? WHERE id='original'", [group.id])
    // A missing source must never be replaced by the most recent human message.
    db.run("DELETE FROM bot_group_messages WHERE id='original'")
    expect(store.groupTaskRequest(callback.id)).toBeNull()
    const privateTask = store.enqueue({
      botId: a.id,
      requestId: "private",
      message: "Private request"
    })
    store.transition(privateTask.id, "running")
    const privateChild = store.delegate(privateTask.id, b.id, "Private handoff", "private")
    expect(store.groupTaskRequest(privateChild.id)).toBeNull()
  })

  it("retains legacy public progress and new explicit messages across reopening", () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    databases.push(db)
    let store = new BotStore(db, () => 1000)
    const bot = store.create({ name: "A", instructions: "", color: "#ea2845", modelRef: null })
    const group = store.saveGroup({ name: "Room", memberIds: [bot.id] })
    store.sendGroup({ groupId: group.id, requestId: "root", text: "Ask", targetBotIds: [bot.id] })
    const task = store.recentTasks()[0]
    store.transition(task.id, "running")
    // Old persisted progress remains history; the obsolete auto-publication path is removed.
    db.run(
      "INSERT INTO bot_group_messages (id,group_id,author_bot_id,text,targets_json,created_at) VALUES (?,?,?,?,'[]',?)",
      ["progress-legacy", group.id, bot.id, "Markdown", 1000]
    )
    const receipt = store.publishGroupMessage(task.id, "provider:message/".repeat(30), "Progress")
    const progress = store.groupMessages(group.id).at(-1)!
    expect(botIdentifier(receipt.messageId)).toBe(receipt.messageId)
    expect(store.groupMessages(group.id, { targetMessageId: receipt.messageId })).toContainEqual(
      progress
    )
    store.recordGroupQuestion(task.id, {
      requestId: "q",
      threadId: task.threadId,
      createdAt: new Date(1000).toISOString(),
      questions: [{ id: "q", header: "Format", question: "Next?", options: [] }]
    })
    store.settle(task.id, "superseded", null)
    expect(() => store.publishGroupMessage(task.id, "late", "Late")).toThrow("活动群任务")
    store = new BotStore(db, () => 1001)
    expect(store.groupMessages(group.id).map((m) => [m.text, !!m.question])).toEqual([
      ["Ask", false],
      ["Markdown", false],
      ["Progress", false],
      ["", true]
    ])
    expect(store.groupMessages(group.id)[1].authorBotId).toBe(bot.id)
  })

  it("retains question position and exact receipt references across reopening without copying answers", () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    databases.push(db)
    const read = vi.fn(() => ({ content: '{"status":"submitted","answers":{}}' }))
    let store = new BotStore(db, () => 1000, undefined, undefined, read)
    const bot = store.create({ name: "A", instructions: "", color: "#ea2845", modelRef: null })
    const group = store.saveGroup({ name: "Room", memberIds: [bot.id] })
    store.sendGroup({ groupId: group.id, requestId: "root", text: "Ask", targetBotIds: [bot.id] })
    const task = store.recentTasks()[0]
    store.transition(task.id, "running")
    const request: UserInputRequest = {
      requestId: "question",
      threadId: task.threadId,
      createdAt: new Date(1000).toISOString(),
      questions: [{ id: "format", header: "Format", question: "Which format?", options: [] }]
    }
    store.recordGroupQuestion(task.id, request)
    const pending = store.groupMessages(group.id).at(-1)!
    expect(pending.question).toEqual({ taskId: task.id, request, state: "running" })
    store.recordGroupQuestion(task.id, request)
    expect(store.groupMessages(group.id)).toHaveLength(2)
    store.recordGroupQuestionResult("other-task", request.requestId, "wrong")
    expect(read).not.toHaveBeenCalled()
    store.recordGroupQuestionResult(task.id, request.requestId, "actual-tool-message")
    store.settle(task.id, "completed", null, "Done")
    store = new BotStore(db, () => 1001, undefined, undefined, read)
    const restored = store.groupMessages(group.id).find((item) => item.id === pending.id)!
    expect(restored.ordinal).toBe(pending.ordinal)
    expect(restored.question).toMatchObject({
      resultId: "actual-tool-message",
      state: "completed",
      result: read()
    })
    expect(read).toHaveBeenCalledWith(request, "actual-tool-message")
    expect(
      String(
        db.exec("SELECT question_json FROM bot_group_messages WHERE question_json IS NOT NULL")[0]
          .values[0][0]
      )
    ).not.toContain("answers")
    expect(store.groupMessages(group.id, undefined, false).map((item) => item.text)).toEqual([
      "Ask",
      "Done"
    ])
    for (let i = 0; i < 60; i++)
      db.run(
        "INSERT INTO bot_group_messages (id,group_id,text,targets_json,created_at) VALUES (?,?,?,'[]',?)",
        [`later-${i}`, group.id, `Later ${i}`, 2000 + i]
      )
    read.mockClear()
    const latest = store.groupMessages(group.id)
    expect(latest).toHaveLength(50)
    expect(latest.some((item) => item.question)).toBe(false)
    expect(read).not.toHaveBeenCalled()
    const earlier = store.groupMessages(group.id, latest[0].ordinal)
    expect(earlier.find((item) => item.id === pending.id)?.question?.resultId).toBe(
      "actual-tool-message"
    )
    expect(
      store
        .groupMessages(group.id, { targetMessageId: pending.id })
        .find((item) => item.id === pending.id)?.ordinal
    ).toBe(pending.ordinal)
  })

  it("does not capture private/foreign requests and restores unanswered cards as interrupted", () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    databases.push(db)
    const store = new BotStore(db)
    const bot = store.create({ name: "A", instructions: "", color: "#ea2845", modelRef: null })
    const group = store.saveGroup({ name: "Room", memberIds: [bot.id] })
    const privateTask = store.enqueue({ botId: bot.id, requestId: "private", message: "Private" })
    store.transition(privateTask.id, "running")
    const request: UserInputRequest = {
      requestId: "q",
      threadId: privateTask.threadId,
      createdAt: new Date().toISOString(),
      questions: [{ id: "q", header: "Format", question: "Choose", options: [] }]
    }
    store.recordGroupQuestion(privateTask.id, request)
    expect(store.groupMessages(group.id)).toEqual([])
    store.settle(privateTask.id, "completed", null, "Done")
    store.sendGroup({ groupId: group.id, requestId: "root", text: "Ask", targetBotIds: [bot.id] })
    const task = store.recentTasks().find((item) => item.origin.kind === "group")!
    store.transition(task.id, "running")
    store.recordGroupQuestion(task.id, request)
    expect(store.groupMessages(group.id)).toHaveLength(1)
    store.recordGroupQuestion(task.id, { ...request, threadId: task.threadId })
    store.recover()
    const question = store.groupMessages(group.id).find((item) => item.question)!.question!
    expect(question.state).toBe("interrupted")
    expect(question.result).toBeUndefined()
    // Disposable task bodies can expire; the existing archive retains the
    // question's owner/state without copying its Runtime messages or answers.
    for (let i = 0; i < 101; i++) {
      const newer = store.enqueue({ botId: bot.id, requestId: `newer-${i}`, message: "Done" })
      store.transition(newer.id, "running")
      store.settle(newer.id, "completed", null, "Done")
    }
    db.run("UPDATE bot_tasks SET updated_at=0 WHERE id=?", [task.id])
    const reopened = new BotStore(db, () => 60 * 24 * 60 * 60 * 1000)
    expect(reopened.pruneTaskHistory()).toBeGreaterThan(0)
    expect(() => reopened.getTask(task.id)).toThrow()
    expect(reopened.groupMessages(group.id).find((item) => item.question)?.question?.state).toBe(
      "interrupted"
    )
  })

  it("retains backward cursor ordering and group isolation", () => {
    const { store, a } = historyFixture()
    const latest = store.groupMessages(a.id)
    expect(latest.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `a-${index + 31}`)
    )
    const older = store.groupMessages(a.id, latest[0].ordinal)
    expect(older.map((item) => item.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `a-${index + 1}`)
    )
  })

  it("opens exact targets with following context despite sparse global ordinals", () => {
    const { store, a } = historyFixture()
    const page = store.groupMessages(a.id, { targetMessageId: "a-40" })
    expect(page.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `a-${index + 16}`)
    )
    expect(page.find((item) => item.id === "a-40")?.replyTo).toEqual({
      id: "a-39",
      ordinal: 3900,
      authorBotId: null,
      text: "a 39"
    })
    expect(store.groupMessages(a.id, page[0].ordinal).at(-1)?.id).toBe("a-15")
  })

  it("includes following context for the earliest target and remains bounded at the end", () => {
    const { store, a } = historyFixture()
    const first = store.groupMessages(a.id, { targetMessageId: "a-1" })
    expect(first.map((item) => item.id)).toEqual(
      Array.from({ length: 26 }, (_, index) => `a-${index + 1}`)
    )
    expect(store.groupMessages(a.id, { targetMessageId: "a-80" })).toEqual(
      store.groupMessages(a.id)
    )
  })

  it("rejects unavailable and other-group targets without reading their context", () => {
    const { store, a } = historyFixture()
    for (const targetMessageId of ["b-40", "missing"]) {
      expect(() => store.groupMessages(a.id, { targetMessageId })).toThrow("被回复的消息已不可用")
    }
    expect(() => store.groupMessages("missing-group", { targetMessageId: "a-40" })).toThrow()
  })
})
