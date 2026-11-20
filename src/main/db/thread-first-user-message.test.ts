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

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-first-user-turn-"))
  state.path = join(directory, "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

it("recognizes the first user turn even when system rows and later queued messages exist", () => {
  db.createThread("queued")
  db.upsertThreadMessages("queued", [
    { id: "setup", role: "system", content: "setup", created_at: new Date(1) },
    { id: "start", role: "user", content: "initial skill request", created_at: new Date(2) },
    { id: "queued", role: "user", content: "follow-up", created_at: new Date(3) }
  ])
  expect(db.isFirstThreadUserMessage("queued", "start")).toBe(true)
  expect(db.isFirstThreadUserMessage("queued", "queued")).toBe(false)
  expect(db.isFirstThreadUserMessage("queued", "missing")).toBe(false)
  expect(db.isFirstThreadUserMessage("queued")).toBe(false)
})

it("only uses the single-user fallback when a caller did not provide a message ID", () => {
  db.createThread("single")
  expect(db.isFirstThreadUserMessage("single")).toBe(false)
  db.upsertThreadMessages("single", [
    { id: "start", role: "user", content: "start", created_at: new Date(1) },
    { id: "answer", role: "assistant", content: "answer", created_at: new Date(2) }
  ])
  expect(db.isFirstThreadUserMessage("single")).toBe(true)
  expect(db.isFirstThreadUserMessage("single", "other")).toBe(false)
})
