import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const storageState = vi.hoisted(() => ({ databasePath: "" }))

vi.mock("../storage", () => ({
  getDbPath: () => storageState.databasePath,
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))

import * as threadDb from "./index"

let temporaryDirectory = ""

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "thread-workspace-bindings-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("persisted thread workspace bindings", () => {
  it("projects only durable workspace identity fields for all bound threads", () => {
    threadDb.createThread("thread-a", {
      workspacePath: "C:\\repo\\feature-a",
      isWorktree: true,
      worktreeBranch: "feature/a",
      unrelated: "x".repeat(256 * 1024)
    })
    threadDb.createThread("thread-b", { workspacePath: "C:\\repo\\main" })
    threadDb.createThread("thread-unbound", { title: "no workspace" })
    expect(threadDb.getPersistedThreadWorkspaceBindings()).toEqual([
      {
        threadId: "thread-a",
        workspacePath: "C:\\repo\\feature-a",
        isWorktree: true,
        worktreeBranch: "feature/a"
      },
      {
        threadId: "thread-b",
        workspacePath: "C:\\repo\\main",
        isWorktree: false,
        worktreeBranch: null
      }
    ])

    threadDb.getDb().run(
      "INSERT INTO threads (thread_id, created_at, updated_at, metadata) VALUES (?, 0, 0, ?)",
      ["thread-malformed", "{not-json"]
    )
    expect(() => threadDb.getPersistedThreadWorkspaceBindings()).toThrow(
      /task thread-malformed has invalid metadata/i
    )
  })
})
