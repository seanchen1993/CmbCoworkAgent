import { beforeEach, describe, expect, it, vi } from "vitest"
import { captureStockLegacyTranscriptSource } from "./legacy-stock-transcript-admission"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "./runtime-projection-protocol"

const state = vi.hoisted(() => ({
  database: {},
  openFile: vi.fn(),
  thread: vi.fn(),
  protects: vi.fn()
}))
vi.mock("../db", () => ({
  getDb: () => state.database,
  getOpenDatabaseFile: state.openFile,
  getThreadRuntimeScope: state.thread
}))
vi.mock("../db/sqlite-recovery-family", () => ({ sqliteRecoveryFamilyKey: () => "family" }))
vi.mock("../mods/manager", () => {
  const manager = { protects: state.protects }
  return { getModsManager: () => manager }
})

describe("ordinary legacy transcript admission", () => {
  const file = { dev: "1", ino: "2", birthtime: "3" }
  const incarnation = { token: "original", legacyCreatedAt: 10 }
  const admit = () => captureStockLegacyTranscriptSource({
    database: state.database as Parameters<typeof captureStockLegacyTranscriptSource>[0]["database"],
    checkpointPath: "checkpoint.db",
    threadId: "thread",
    incarnation,
    assertCurrent: vi.fn()
  })

  beforeEach(() => {
    state.openFile.mockReset().mockReturnValue(file)
    state.thread.mockReset().mockReturnValue({ metadata: JSON.stringify({ workspacePath: "workspace" }) })
    state.protects.mockReset().mockReturnValue(false)
  })

  it("binds an ordinary source to the open database and rechecks protection before delivery", () => {
    const source = admit()
    expect(source?.authority).toEqual({ messageDatabaseFile: file, checkpointFamilyKey: "family",
      incarnation, workspace: "workspace" })
    expect(state.protects).toHaveBeenCalledWith("workspace")
    expect(() => source?.assertCurrent()).not.toThrow()
    state.protects.mockReturnValue(true)
    expect(() => source?.assertCurrent()).toThrow(
      expect.objectContaining({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED })
    )
    expect(admit()).toBeUndefined()
  })

  it("keeps project plugins and unreadable policy on the guarded path", () => {
    state.thread.mockReturnValueOnce({ metadata: JSON.stringify({ pluginId: "legacy-project" }) })
    expect(admit()).toBeUndefined()
    state.protects.mockImplementation(() => { throw Error("MODS_POLICY_UNAVAILABLE") })
    expect(admit()).toBeUndefined()
  })

  it("requires the database identity captured when the Main connection opened", () => {
    state.openFile.mockReturnValue(undefined)
    expect(admit()).toBeUndefined()
  })

  it("rejects results from a conversation rebound to a different workspace", () => {
    const source = admit()
    state.thread.mockReturnValue({ metadata: '{"workspacePath":"other"}' })
    expect(() => source?.assertCurrent()).toThrow(
      expect.objectContaining({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED })
    )
  })
})
