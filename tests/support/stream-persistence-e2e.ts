import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import type { Page } from "playwright"

interface TranscriptPage {
  messages: Array<{ id: string; role: string; content: unknown }>
  hasMore: boolean
  beforeOrdinal: number | null
  beforeMessageId: string | null
  total: number
}
interface PersistenceApi {
  getMessagesPage(id: string, options: Record<string, unknown>): Promise<TranscriptPage>
  appendMessages(id: string, messages: Record<string, unknown>[]): Promise<unknown>
  fork(params: {
    sourceThreadId: string
    title: string
  }): Promise<{ thread: { thread_id: string } }>
}

/** Uses the production preload/IPC routes after a real local SSE agent run. */
export async function exerciseStreamPersistenceE2e(
  page: Page,
  fixture: { threadId: string; title: string; secondReply: string },
  databasePath: string
): Promise<string[]> {
  const checks: string[] = []
  const result = await page.evaluate(
    async ({ threadId, reply }) => {
      const threads = (window as unknown as { api: { threads: PersistenceApi } }).api.threads
      const latest = await threads.getMessagesPage(threadId, { limit: 20 })
      const final = latest.messages.find(
        (message) => message.role === "assistant" && message.content === reply
      )
      if (!final) throw new Error("Missing native SSE final")
      await threads.appendMessages(threadId, [
        {
          id: final.id,
          role: "assistant",
          content: "STALE_RENDERER_ECHO",
          created_at: new Date().toISOString()
        }
      ])
      const after = await threads.getMessagesPage(threadId, { limit: 20 })
      const seen = new Set<string>()
      let currentPage = after
      let pages = 0
      while (true) {
        pages += 1
        for (const message of currentPage.messages) {
          if (seen.has(message.id)) throw new Error("Pagination repeated a durable identity")
          seen.add(message.id)
        }
        if (!currentPage.hasMore) break
        if (pages > 30) throw new Error("Pagination failed to terminate")
        currentPage = await threads.getMessagesPage(threadId, {
          limit: 80,
          beforeOrdinal: currentPage.beforeOrdinal,
          beforeMessageId: currentPage.beforeMessageId
        })
      }
      return {
        id: final.id,
        content: after.messages.find((message) => message.id === final.id)?.content,
        count: seen.size,
        total: after.total,
        pages
      }
    },
    { threadId: fixture.threadId, reply: fixture.secondReply }
  )
  assert.equal(result.content, fixture.secondReply)
  assert.equal(result.count, result.total)
  assert.ok(result.pages > 10)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const stored = database
      .prepare(
        "SELECT content_json AS content, stream_authority FROM thread_messages WHERE thread_id = ? AND message_id = ?"
      )
      .get(fixture.threadId, result.id) as { content: string; stream_authority: number }
    assert.ok(
      (stored.stream_authority & 1) !== 0,
      "native full values establishes durable field authority"
    )
    assert.equal(JSON.parse(stored.content), fixture.secondReply)
  } finally {
    database.close()
  }
  checks.push("local SSE native final rejects stale preload IPC echo in SQLite")
  checks.push("long history compound-cursor pagination has no missing or duplicate rows")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText(fixture.title, { exact: true }).first().click()
  await page.getByText(fixture.secondReply, { exact: true }).last().waitFor({ timeout: 30_000 })
  checks.push("renderer reload hydrates the durable corrected final")
  const forked = await page.evaluate(async (sourceThreadId) => {
    const threads = (window as unknown as { api: { threads: PersistenceApi } }).api.threads
    const fork = await threads.fork({ sourceThreadId, title: "Persistence E2E fork" })
    return threads.getMessagesPage(fork.thread.thread_id, { limit: 20 })
  }, fixture.threadId)
  assert.ok(forked.messages.some((message) => message.content === fixture.secondReply))
  assert.ok(!forked.messages.some((message) => message.content === "STALE_RENDERER_ECHO"))
  checks.push("production checkpoint fork preserves the native final without stale echo")
  return checks
}
