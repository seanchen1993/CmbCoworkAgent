import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest"
import type { BotWorkItem } from "../../shared/bots/work"
import type { LocalBotHost } from "./host"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { parseBotWorkHistoryHref } from "../../shared/bots/work-history"

const fixture = vi.hoisted(() => ({ path: "", afterRead: () => {} }))
vi.mock("../storage", () => ({
  getDbPath: () => fixture.path,
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
    messageOrigins: () => []
  } as unknown as LocalBotHost
  return { work, history: createLocalBotWorkHistory(() => host) }
}
describe("linked task history", () => {
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
    await expect(history.resolve(work, source)).rejects.toThrow()
    work.conversation!.state = "bound"
    db.deleteThread(work.threadId)
    db.createThread(work.threadId, { botId: "owner", botWorkId: work.id })
    await expect(history.resolve(work, source)).rejects.toThrow()
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
