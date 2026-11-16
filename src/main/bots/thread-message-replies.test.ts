import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { BotMessageReply } from "../../shared/bots/contracts"
import { BotStore } from "./store"
import { formatBotMessageReply } from "../../shared/bots/message-reply"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { createBotThreadReplyResolver } from "./thread-message-replies"
import { botHistoricalMessageReader, decorateBotHistoryPage, setBotHistoryInputSource } from "./history-input-projection"

const storage = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as db from "../db"
let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "bot-search-integration-"))
  storage.path = join(directory, "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const quote: BotMessageReply = {
    id: "quoted",
    ordinal: 0,
    role: "assistant",
    text: "quoted-only"
  }
  const store = new BotStore(db.getDb(), Date.now, undefined, (_threadId, id) =>
    id === quote.id ? quote : null
  )
  const bot = store.create({ name: "Test", instructions: "", color: "#123456", modelRef: null })
  const { work } = store.createWork({
    botId: bot.id,
    operationId: bot.id,
    title: "Plan",
    goal: "Write"
  })
  const metadata = {
    botId: bot.id,
    botHostId: "local",
    botWorkId: work.id,
    botAudienceKey: "desktop",
    workspacePath: "/test"
  }
  db.createThread(work.threadId, metadata)
  const input = store.enqueue({
    botId: bot.id,
    workId: work.id,
    requestId: `reply-${bot.id}`,
    message: formatBotMessageReply("current-body", quote),
    replyToId: quote.id
  })
  db.upsertThreadMessages(work.threadId, [
    { id: input.requestId, role: "user", created_at: new Date(1), content: input.message }
  ])
  const host = {
    getBot: store.getBot.bind(store),
    getWork: store.getWork.bind(store),
    messageOrigins: vi.fn(store.messageOrigins.bind(store))
  }
  const row = db.getThreadCore(work.threadId)!
  return { store, bot, work, metadata, host, row, requestId: input.requestId }
}
describe("beta search in independent work conversations", () => {
  it("keeps native history and search aligned after unlink without rewriting persisted input", async () => {
    const f = fixture()
    const threadId = `detached-${f.bot.id}`
    db.createThread(threadId, { cmb_thread_incarnation: threadId })
    const row = db.getThreadCore(threadId)!
    const ref = { kind: "local_thread" as const, threadId, incarnation: captureThreadIncarnation(row) }
    const work = f.store.conversations.prepare({ botId: f.bot.id, operationId: threadId,
      conversation: ref, title: "History", goal: "Review" })
    f.store.conversations.bound(f.bot.id, work.id, ref)
    const quote = { id: "quoted", ordinal: 0, role: "assistant" as const, text: "quoted-only" }
    const raw = formatBotMessageReply("current-body", quote)
    const task = f.store.enqueue({ botId: f.bot.id, workId: work.id, requestId: threadId, message: raw,
      replyToId: quote.id, explicitSkill: { name: "Review", path: "/skills/review/SKILL.md" } })
    f.store.transition(task.id, "running")
    f.store.transition(task.id, "completed")
    db.upsertThreadMessages(threadId, [
      { id: task.requestId, role: "user", created_at: new Date(1), content: raw },
      { id: "literal", role: "user", created_at: new Date(2), content: raw }
    ])
    setBotHistoryInputSource({ works: id => f.store.desktopDeliveryWorks(id), inputs: () => new Map(),
      origins: (id, incarnation, ids) => f.store.historicalMessageOrigins(id, incarnation, ids, true) })
    try {
      for (const detached of [false, true]) {
        if (detached) {
          f.store.conversations.beginDetach(f.bot.id, work.id, f.store.getWork(f.bot.id, work.id).version)
          f.store.conversations.detached(f.bot.id, work.id)
        }
        const page = await decorateBotHistoryPage(threadId, db.getThreadMessagesPage(threadId), () => row)
        expect(page.messages[0].content).toBe(raw)
        expect(page.messages[0].botHistoryInputOrigin?.explicitSkill?.name).toBe("Review")
        expect(page.messages[1].botHistoryInputOrigin).toBeUndefined()
        const read = botHistoricalMessageReader(threadId, () => row)!
        const replies = (ids: string[]) => new Map([...read(ids)].flatMap(([id, origin]) =>
          origin.replyTo ? [[id, origin.replyTo] as const] : []))
        expect(db.searchThreadMessages(threadId, "quoted-only", {}, replies).matches.map(item => item.messageId)).toEqual(["literal"])
        expect(db.searchThreadMessages(threadId, "current-body", {}, replies).matches.map(item => item.messageId).sort())
          .toEqual(["literal", task.requestId].sort())
      }
      expect(db.getThreadMessagesPage(threadId).messages.every(message => message.content === raw && !message.botHistoryInputOrigin)).toBe(true)
    } finally { setBotHistoryInputSource(undefined) }
  })
  it("searches visible reply bodies without matching their quoted transport, in task and linked Chat views", () => {
    const f = fixture()
    const resolve = createBotThreadReplyResolver(f.work.threadId, f.row, f.metadata, f.host)
    expect(resolve).toBeDefined()
    expect(db.searchThreadMessages(f.work.threadId, "current-body", {}, resolve).matches).toEqual([
      expect.objectContaining({ messageId: f.requestId, occurrenceCount: 1 })
    ])
    for (const query of ["quoted-only", "CMBDEVCLAW-BOT-REPLY-V1"]) {
      expect(db.searchThreadMessages(f.work.threadId, query, {}, resolve).matches).toEqual([])
      expect(db.searchThreadMessages(f.work.threadId, query).matches).toHaveLength(1)
    }
    expect(f.host.messageOrigins).toHaveBeenCalledWith(
      f.bot.id,
      [f.requestId],
      undefined,
      f.work.id
    )
    const metadata = { ...f.metadata, botLocalConversation: true, botWorkOrigin: "existing" }
    const linked = {
      ...f.work,
      conversation: {
        origin: "existing" as const,
        state: "bound" as const,
        ref: {
          kind: "local_thread" as const,
          threadId: f.work.threadId,
          incarnation: captureThreadIncarnation(f.row)
        }
      }
    }
    const host = { ...f.host, getWork: () => linked }
    const linkedResolve = createBotThreadReplyResolver(f.work.threadId, f.row, metadata, host)
    expect(
      db.searchThreadMessages(f.work.threadId, "quoted-only", {}, linkedResolve).matches
    ).toEqual([])
    expect(() =>
      createBotThreadReplyResolver(
        f.work.threadId,
        { ...f.row, created_at: 0, metadata: "{}" },
        metadata,
        host
      )
    ).toThrow("身份不一致")
    expect(
      createBotThreadReplyResolver(f.work.threadId, f.row, metadata, {
        ...host,
        getWork: () => ({ ...linked, conversation: { ...linked.conversation, state: "detaching" } })
      })
    ).toBeUndefined()
  })
  it("does not borrow another task's or the main conversation's quote origins", () => {
    const f = fixture()
    const other = f.store.createWork({
      botId: f.bot.id,
      operationId: "other",
      title: "Other",
      goal: "Other"
    }).work
    expect(
      createBotThreadReplyResolver(
        f.work.threadId,
        f.row,
        { ...f.metadata, botWorkId: other.id },
        f.host
      )
    ).toBeUndefined()
    expect(
      createBotThreadReplyResolver(
        f.work.threadId,
        f.row,
        { ...f.metadata, botGroupId: "group" },
        f.host
      )
    ).toBeUndefined()
    expect(f.host.messageOrigins).not.toHaveBeenCalled()
    const mainResolve = createBotThreadReplyResolver(
      f.bot.threadId,
      f.row,
      { botId: f.bot.id, botHostId: "local" },
      f.host
    )
    expect(mainResolve?.([f.requestId]).size).toBe(0)
    expect(f.host.messageOrigins).toHaveBeenCalledWith(
      f.bot.id,
      [f.requestId],
      undefined,
      undefined
    )
  })
  it("keeps one batched origin lookup per bounded page and stable search continuation", () => {
    const f = fixture()
    db.upsertThreadMessages(
      f.work.threadId,
      Array.from({ length: db.THREAD_MESSAGE_SEARCH_SCAN_LIMIT + 1 }, (_, index) => ({
        id: `user-${index}`,
        role: "user" as const,
        created_at: new Date(index + 2),
        content: "ordinary"
      }))
    )
    const resolve = createBotThreadReplyResolver(f.work.threadId, f.row, f.metadata, f.host)
    const first = db.searchThreadMessages(f.work.threadId, "current-body", {}, resolve)
    expect(first.matches).toHaveLength(0)
    expect(first.hasMore).toBe(true)
    expect(f.host.messageOrigins).toHaveBeenCalledTimes(1)
    expect(f.host.messageOrigins.mock.calls[0][1]).toHaveLength(db.THREAD_MESSAGE_SEARCH_SCAN_LIMIT)
    const second = db.searchThreadMessages(
      f.work.threadId,
      "current-body",
      {
        beforeOrdinal: first.beforeOrdinal!,
        beforeMessageId: first.beforeMessageId!
      },
      resolve
    )
    expect(second.matches).toEqual([expect.objectContaining({ messageId: f.requestId })])
    expect(second.hasMore).toBe(false)
    expect(f.host.messageOrigins).toHaveBeenCalledTimes(2)
  })
})
