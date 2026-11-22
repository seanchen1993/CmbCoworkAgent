import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { canReadThreadSearchContent } from "./thread-search-display"

const mocks = vi.hoisted(() => ({ database: vi.fn(), protects: vi.fn() }))
vi.mock("../db", () => ({
  getDb: mocks.database,
  getThreadRuntimeScope: () => ({ metadata: '{"workspacePath":"workspace"}' })
}))
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ protects: mocks.protects }) }))

describe("raw thread search eligibility", () => {
  let sqlite: DatabaseSync

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:")
    sqlite.exec(`CREATE TABLE thread_messages (thread_id TEXT, function_row_json TEXT);
      INSERT INTO thread_messages VALUES ('legacy', NULL), ('native', 'invalid stamp')`)
    mocks.database.mockReturnValue(new NativeSqliteAdapter(sqlite))
    mocks.protects.mockReset().mockReturnValue(false)
  })

  afterEach(() => sqlite.close())

  it("denies unverified native rows even when their receipt is missing", () => {
    expect(canReadThreadSearchContent("legacy")).toBe(true)
    expect(canReadThreadSearchContent("native")).toBe(false)
  })

  it("denies receipt-owned and policy-protected text", () => {
    sqlite.exec(`CREATE TABLE function_conversation_projection_receipts (thread_id TEXT);
      INSERT INTO function_conversation_projection_receipts VALUES ('legacy')`)
    expect(canReadThreadSearchContent("legacy")).toBe(false)
    sqlite.exec("DELETE FROM function_conversation_projection_receipts")
    mocks.protects.mockReturnValue(true)
    expect(canReadThreadSearchContent("legacy")).toBe(false)
    expect(mocks.protects).toHaveBeenCalledWith("workspace")
  })
})
