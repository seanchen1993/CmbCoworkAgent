import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest"
import type { BotWorkItem } from "../../shared/bots/work"
import type { LocalBotHost } from "./host"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { botWorkHistoryHref, parseBotWorkHistoryHref } from "../../shared/bots/work-history"
import { BOT_ROUTINE_SILENT } from "../../shared/bots/routine-silence"
import { BotStore } from "./store"

const fixture = vi.hoisted(() => ({ path: "", afterRead: () => {} }))
vi.mock("../storage", () => ({
  getDbPath: () => fixture.path,
  peekThreadCheckpointPath: (id: string) => join(dirname(fixture.path), `${id}.sqlite`),
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("../thread-message-hydration/client", async () => {
  const db = await import("../db")
  return {
    readThreadMessagesPageInWorker: async (id, options) => {
      const result = db.getThreadMessagesPage(id, options)
      fixture.afterRead()
      return result
    }
  }
})
import * as db from "../db"
import { createLocalBotWorkHistory } from "./work-history"

let directory: string
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "bot-history-"))
  fixture.path = join(directory, "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function setup(name: string) {
  const preparedInputs = new Map<string, string | null>()
  const work = {
    id: name,
    botId: "owner",
    threadId: name,
    title: "关联任务",
    goal: "原目标",
    audienceKey: "desktop"
  } as BotWorkItem
  const row = db.createThread(name, {
    botId: "owner",
    botWorkId: name,
    botHostId: "local",
    botLocalConversation: true,
    botAudienceKey: "desktop",
    botWorkOrigin: "existing",
    workspacePath: directory
  })
  work.conversation = {
    origin: "existing",
    state: "bound",
    ref: { kind: "local_thread", threadId: name, incarnation: captureThreadIncarnation(row) }
  }
  const host = {
    getBot: () => ({ id: "owner", threadId: "main" }),
    getWork: (botId, id) => {
      if (botId !== "owner" || id !== name) throw new Error("not owned")
      return work
    },
    messageOrigins: () => [],
    hasPublishedWorkResultMessage: () => false,
    inputProjections: (_botId, _threadId, ids: readonly string[]) =>
      new Map(ids.filter(id => preparedInputs.has(id)).map(id => [id, preparedInputs.get(id)!])),
    projectWorkForModel: (item: Pick<BotWorkItem, "id" | "botId" | "title">) => item,
    workPromptGoal: () => work.goal
  } as unknown as LocalBotHost
  return { work, history: createLocalBotWorkHistory(() => host), preparedInputs, host }
}
describe("linked task history", () => {
  it("queries accepted bodies while preserving raw user history and ordinary UI search", async () => {
    const { work, history, preparedInputs, host } = setup("prepared-history")
    db.upsertThreadMessages(work.threadId, [
      { id: "rejected", role: "user", content: "REMOVED SECRET", created_at: new Date() },
      { id: "rewritten", role: "user", content: "REMOVED SECRET too", created_at: new Date() },
      { id: "normal", role: "user", content: "Normal requirement", created_at: new Date() },
      { id: "answer", role: "assistant", content: "Result stays visible", created_at: new Date() }
    ])
    preparedInputs.set("rejected", null)
    preparedInputs.set("rewritten", "Accepted policy version")
    const page = await history.query(work, { workId: work.id })
    expect(page.entries.map(e => e.text)).toEqual([
      "Accepted policy version", "Normal requirement", "Result stays visible"
    ])
    expect((await history.query(work, { workId: work.id, query: "REMOVED SECRET" })).entries).toEqual([])
    const found = await history.query(work, { workId: work.id, query: "policy version" })
    expect(found.entries.map(e => e.source.messageId)).toEqual(["rewritten"])
    expect((await history.resolve(work, found.entries[0].source)).messageId).toBe("rewritten")
    await expect(history.query(work, { workId: work.id, messageId: "rejected" })).rejects.toThrow()
    expect(db.searchThreadMessages(work.threadId, "REMOVED SECRET").matches).toHaveLength(2)
    expect(db.getThreadMessagesByIds(work.threadId, ["rewritten"])[0].content).toBe("REMOVED SECRET too")
    host.workPromptGoal = () => undefined
    expect((await history.query(work, { workId: work.id })).work).toEqual({ id: work.id, title: work.title, goal: "" })
    host.projectWorkForModel = item => ({ ...item, title: "原任务" })
    expect((await history.query(work, { workId: work.id })).work).toEqual({ id: work.id, title: "原任务", goal: "" })
  })
  it("reads and locates an IM task transcript only with matching stored audience metadata", async () => {
    const { work, history } = setup("im-history")
    work.conversation = undefined
    work.audienceKey = "im:binding"
    work.source = {
      transport: "im",
      bindingId: "binding",
      grantVersion: 1,
      conversationId: "group",
      audienceKey: "im:binding",
      eventId: "event",
      messageId: "message",
      senderId: "member"
    }
    db.updateThread(work.threadId, {
      metadata: JSON.stringify({
        botId: work.botId,
        botHostId: "local",
        botWorkId: work.id,
        botAudienceKey: work.audienceKey,
        botMockBindingId: "binding",
        botMockConversationId: "group",
        botMockGrantVersion: 1,
        workspacePath: directory
      })
    })
    db.upsertThreadMessages(work.threadId, [
      { id: "group-fact", role: "assistant", content: "本群决定下周演示", created_at: new Date() }
    ])
    const page = await history.query(work, { workId: work.id, query: "下周演示" })
    expect(page.entries).toHaveLength(1)
    expect((await history.resolve(work, page.entries[0].source)).threadId).toBe(work.threadId)
    work.source = { ...work.source, bindingId: "other" }
    await expect(history.query(work, { workId: work.id })).rejects.toThrow()
  })
  it("searches old durable history with empty continuation pages, then reads and resolves an exact citation", async () => {
    const { work, history } = setup("paged-history")
    db.upsertThreadMessages(
      work.threadId,
      Array.from({ length: 100 }, (_, i) => ({
        id: `m-${i}`,
        role: i % 2 ? ("assistant" as const) : ("user" as const),
        content: i === 2 ? "历史决定：审批期限为七天" : `最近聊天 ${i}`,
        created_at: new Date(i + 1)
      }))
    )
    let cursor: string | undefined
    const hits: string[] = [],
      cursors = new Set<string>()
    let pages = 0
    for (;;) {
      const page = await history.query(work, { workId: work.id, query: "审批期限", cursor })
      pages++
      expect(page.scanned).toBeLessThanOrEqual(32)
      hits.push(...page.entries.map((entry) => entry.source.messageId))
      if (!page.nextCursor) {
        expect(page.coverage).toBe("exhausted")
        break
      }
      expect(cursors.has(page.nextCursor)).toBe(false)
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    expect(pages).toBe(4)
    expect(hits).toEqual(["m-2"])
    const context = await history.query(work, { workId: work.id, messageId: "m-2" })
    expect(context.entries.map((entry) => entry.source.messageId)).toContain("m-3")
    const original = context.entries.find((entry) => entry.source.messageId === "m-2")!
    expect(parseBotWorkHistoryHref(original.href)).toEqual(original.source)
    expect(await history.resolve(work, original.source)).toEqual({
      threadId: work.threadId,
      messageId: "m-2",
      ordinal: original.ordinal
    })
    await expect(
      history.query(work, { workId: work.id, query: "changed query", cursor })
    ).rejects.toThrow()
  })
  it("excludes reasoning, internal rows and tool payloads while showing truncation", async () => {
    const { work, history } = setup("visible-only")
    db.upsertThreadMessages(work.threadId, [
      {
        id: "a",
        role: "assistant",
        content: "<think>hidden reasoning</think>可见决定",
        reasoning: "hidden secret",
        created_at: new Date(1)
      },
      { id: "t", role: "tool", content: "hidden tool payload", created_at: new Date(2) },
      { id: "s", role: "system", content: "hidden system prompt", created_at: new Date(3) },
      { id: "long", role: "assistant", content: "长正文".repeat(3000), created_at: new Date(4) }
    ])
    const page = await history.query(work, { workId: work.id })
    expect(page.entries.map((entry) => entry.source.messageId)).toEqual(["a", "long"])
    expect(JSON.stringify(page)).not.toContain("hidden")
    expect(page.truncated).toBe(true)
    expect(page.coverage).toBe("incomplete")
    expect(page.entries.every((entry) => entry.text.length <= 6000)).toBe(true)
    await expect(history.query(work, { workId: work.id, messageId: "t" })).rejects.toThrow()
  })
  it("invalidates citations after unlink, deletion, or replacement of the original conversation", async () => {
    const { work, history } = setup("stale-source")
    db.upsertThreadMessages(work.threadId, [
      { id: "a", role: "assistant", content: "original", created_at: new Date(1) }
    ])
    const source = (await history.query(work, { workId: work.id })).entries[0].source
    work.conversation!.state = "detached"
    await expect(history.resolve(work, source)).rejects.toThrow("历史来源已失效")
    work.conversation!.state = "bound"
    db.deleteThread(work.threadId)
    db.createThread(work.threadId, { botId: "owner", botWorkId: work.id })
    await expect(history.resolve(work, source)).rejects.toThrow()
  })
  it.each([false, true])("keeps only the acknowledged plain-text result link valid after unlink (quiet callback: %s)", async (quietCallback) => {
    const controlDb = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    try {
      const store = new BotStore(controlDb)
      const bot = store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
      const { work, task } = store.createWork({ botId: bot.id, operationId: "plain-result",
        title: "Plain result", goal: "Compare two options" })
      const row = db.createThread(work.threadId, {
        workspacePath: directory, botId: bot.id, botWorkId: work.id, botHostId: "local",
        botLocalConversation: true, botAudienceKey: "desktop", botWorkOrigin: "created"
      })
      const ref = { kind: "local_thread" as const, threadId: work.threadId, incarnation: captureThreadIncarnation(row) }
      const incarnation = createHash("sha256").update(JSON.stringify(ref.incarnation)).digest("hex")
      store.conversations.prepareCreated(bot.id, work.id, ref)
      store.conversations.bound(bot.id, work.id, ref)
      db.upsertThreadMessages(work.threadId, [
        { id: "unrelated", role: "assistant", content: "Earlier reply", created_at: new Date(1) },
        { id: "result", role: "assistant", content: "Choose the first option.", created_at: new Date(2) }
      ])
      store.transition(task.id, "running")
      store.recordPreparedInput(task.id, task.message)
      expect(store.armWorkResultReview(task.id, incarnation)).toBe(true)
      store.recordWorkResultEvidence(task.id, { finalMessageId: "result" })
      if (quietCallback) store.acceptCommand(task.id, {
        id: "check", threadId: work.threadId, command: "check", cwd: directory, startedAt: 1
      })
      store.settle(task.id, "completed", null, "Choose the first option.")
      let executionTaskId = task.id
      if (quietCallback) {
        store.settleCommand({
          id: "check", threadId: work.threadId, exitCode: 0, output: "Checked", cancelled: false, truncated: false
        })
        const callback = store.recentTasks().find(item => item.origin.kind === "notification")!
        executionTaskId = callback.id
        store.transition(callback.id, "running")
        db.upsertThreadMessages(work.threadId, [
          { id: "quiet", role: "assistant", content: BOT_ROUTINE_SILENT, created_at: new Date(3) }
        ])
        store.recordWorkResultEvidence(callback.id, { finalMessageId: "quiet" })
        store.settle(callback.id, "completed", null, BOT_ROUTINE_SILENT)
      }
      store.flushReplies()
      const review = store.recentTasks().find(item =>
        item.origin.kind === "work_result" && item.origin.review?.phase === "review")!
      store.transition(review.id, "running")
      const decision = store.commitWorkResultReview(review.id, {
        kind: "ready", summary: "Options compared.", evidenceIds: []
      })
      expect(decision.state).toBe("publish")
      if (decision.state !== "publish" || !decision.publication.finalMessageId)
        throw new Error("Expected a published result source")
      expect(decision.publication.executionTaskId).toBe(executionTaskId)
      store.settle(review.id, "completed", null)
      store.flushReplies()
      const publication = store.recentTasks().find(item =>
        item.origin.kind === "work_result" && item.origin.review?.phase === "publish")!
      const binding = { botId: bot.id, workId: work.id, workThreadId: work.threadId,
        incarnation, finalMessageId: "result" }
      store.transition(publication.id, "running")
      expect(store.hasPublishedWorkResultMessage(binding)).toBe(false)
      expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
      store.settle(publication.id, "completed", null)
      store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
      const detached = store.conversations.detached(bot.id, work.id)
      db.updateThread(work.threadId, { metadata: JSON.stringify({ workspacePath: directory,
        cmb_thread_incarnation: ref.incarnation.token }) })

      const reopened = new BotStore(controlDb)
      const history = createLocalBotWorkHistory(() => ({
        hasPublishedWorkResultMessage: input => reopened.hasPublishedWorkResultMessage(input)
      }) as LocalBotHost)
      const source = parseBotWorkHistoryHref(botWorkHistoryHref({
        workId: work.id, messageId: decision.publication.finalMessageId, incarnation
      }))!
      const original = db.getThreadMessagesByIds(work.threadId, ["result"])[0]
      await expect(history.resolve(detached, source)).resolves.toEqual({
        threadId: work.threadId, messageId: original.id, ordinal: original.ordinal, detached: true
      })
      await expect(history.resolve(detached, { ...source, messageId: "unrelated" })).rejects.toThrow("历史来源已失效")
      if (quietCallback)
        await expect(history.resolve(detached, { ...source, messageId: "quiet" })).rejects.toThrow("历史来源已失效")
      for (const field of ["botId", "workId", "workThreadId", "incarnation", "finalMessageId"] as const)
        expect(reopened.hasPublishedWorkResultMessage({ ...binding, [field]: "other" })).toBe(false)
      db.deleteThread(work.threadId)
      db.createThread(work.threadId, { workspacePath: directory })
      await expect(history.resolve(detached, source)).rejects.toThrow()
    } finally {
      controlDb.close()
    }
  })
  it("checks ownership again after asynchronous hydration", async () => {
    const { work, history } = setup("race-source")
    db.upsertThreadMessages(work.threadId, [
      { id: "a", role: "user", content: "private", created_at: new Date(1) }
    ])
    fixture.afterRead = () => {
      work.conversation!.state = "detached"
    }
    try {
      await expect(history.query(work, { workId: work.id })).rejects.toThrow()
    } finally {
      fixture.afterRead = () => {}
    }
  })
  it("rejects remote, other-audience and non-owned transcripts", async () => {
    const { work, history } = setup("scope-source")
    await expect(history.query({ ...work, botId: "other" }, { workId: work.id })).rejects.toThrow()
    work.audienceKey = "external:other"
    await expect(history.query(work, { workId: work.id })).rejects.toThrow()
  })
})
