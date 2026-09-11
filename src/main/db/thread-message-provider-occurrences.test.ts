import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => state.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as db from "./index"
import { buildMessageSameRoleDuplicateId } from "../../shared/message-role-collision"
let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-provider-occurrences-"))
  state.path = join(directory, "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

it("keeps prior-user maxima separate from more than 32 current tool cycles", () => {
  const threadId = "provider-boundary"
  db.createThread(threadId)
  const rows = [{ id: "u1", role: "user" as const, content: "old turn", created_at: new Date(1) }]
  const messages: Parameters<typeof db.upsertThreadMessages>[1][number][] = [...rows]
  for (let i = 1; i <= 70; i += 1) {
    if (i === 6)
      messages.push({
        id: "u2",
        role: "user",
        content: "current turn",
        created_at: new Date(i * 2)
      })
    messages.push({
      id: i === 1 ? "shared" : buildMessageSameRoleDuplicateId("shared", "assistant", i),
      provider_source_id: "shared",
      provider_occurrence: i,
      role: "assistant",
      content: "x".repeat(2000),
      created_at: new Date(i * 2)
    })
    messages.push({
      id: `tool-${i}`,
      provider_source_id: "shared",
      provider_occurrence: i,
      role: "tool",
      tool_call_id: `call-${i}`,
      content: "result",
      created_at: new Date(i * 2 + 1)
    })
  }
  db.upsertThreadMessages(threadId, messages)
  const result = db.getThreadMessageProviderOccurrencesBeforeUser(threadId, "u2", [
    "shared",
    "unrelated"
  ])
  expect(result).toHaveLength(2)
  expect(result).toEqual(
    expect.arrayContaining([
      { provider_source_id: "shared", role: "assistant", provider_occurrence: 5 },
      { provider_source_id: "shared", role: "tool", provider_occurrence: 5 }
    ])
  )
  expect(db.getThreadMessageProviderOccurrencesBeforeUser(threadId, "u1", ["shared"])).toEqual([])
  expect(
    db.getThreadMessageProviderOccurrencesBeforeUser(threadId, "missing", ["shared"])
  ).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain("content")
})

it("reads legacy encoded occurrences without a provider column or message bodies", () => {
  const threadId = "legacy-provider-boundary"
  db.createThread(threadId)
  const legacyId = buildMessageSameRoleDuplicateId("legacy", "assistant", 12)
  db.upsertThreadMessages(threadId, [
    { id: legacyId, role: "assistant", content: "old", created_at: new Date(1) },
    { id: "boundary", role: "user", content: "new", created_at: new Date(2) }
  ])
  db.getDb().run(
    "UPDATE thread_messages SET provider_source_id = NULL, provider_occurrence = NULL WHERE thread_id = ?",
    [threadId]
  )
  expect(
    db.getThreadMessageProviderOccurrencesBeforeUser(threadId, "boundary", ["legacy"])
  ).toEqual([{ provider_source_id: "legacy", role: "assistant", provider_occurrence: 12 }])
})
