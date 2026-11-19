import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { canReadThreadSearchContent } from "./thread-search-display"

const mocks = vi.hoisted(() => ({
  thread: vi.fn(),
  database: vi.fn(),
  manager: vi.fn(),
  protects: vi.fn()
}))

vi.mock("../db", () => ({ getDb: mocks.database, getThreadRuntimeScope: mocks.thread }))
vi.mock("../mods/manager", () => ({ getModsManager: mocks.manager }))

describe("search transcript publication", () => {
  let sqlite: DatabaseSync

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:")
    mocks.database.mockReturnValue({
      prepareReadOne: (sql: string) => (parameters: SQLInputValue[]) =>
        sqlite.prepare(sql).get(...parameters)
    })
    mocks.thread.mockReturnValue({ metadata: '{"workspacePath":"/ordinary"}' })
    mocks.protects.mockReturnValue(false)
    mocks.manager.mockReturnValue({ protects: mocks.protects })
  })

  afterEach(() => {
    sqlite.close()
    vi.resetAllMocks()
  })

  it("uses the current stored workspace policy and fails closed when it is unavailable", () => {
    expect(canReadThreadSearchContent("ordinary")).toBe(true)
    expect(mocks.protects).toHaveBeenCalledWith("/ordinary")
    mocks.protects.mockReturnValue(true)
    expect(canReadThreadSearchContent("ordinary")).toBe(false)
    mocks.manager.mockImplementation(() => { throw Error("policy unavailable") })
    expect(canReadThreadSearchContent("ordinary")).toBe(false)
  })

  it("requires the transcript publication path when the thread has native row receipts", () => {
    sqlite.exec("CREATE TABLE function_conversation_projection_receipts (thread_id TEXT)")
    sqlite.prepare("INSERT INTO function_conversation_projection_receipts VALUES (?)").run("native")
    expect(canReadThreadSearchContent("ordinary")).toBe(true)
    expect(canReadThreadSearchContent("native")).toBe(false)
  })
})
