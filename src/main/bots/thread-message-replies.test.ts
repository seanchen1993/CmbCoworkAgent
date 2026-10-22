import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { BotMessageReply } from "../../shared/bots/contracts"
import { BotStore } from "./store"
import { formatBotMessageReply } from "../../shared/bots/message-reply"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { createBotThreadReplyResolver } from "./thread-message-replies"

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
