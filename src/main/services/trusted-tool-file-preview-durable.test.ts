import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

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

import * as threadDb from "../db"
import { resolveExternalFileReadGrant } from "./external-file-read-tokens"
import {
  clearTrustedToolFilePreviewSourcesForThread,
  clearTrustedToolFilePreviewMemoryForTests,
  clearTrustedToolFilePreviewSourcesForTests,
  collectTrustedToolFilePreviewScopeKeysForThread,
  issueTrustedToolFilePreviewGrant,
  recordTrustedToolFilePreviewSource,
  resolveTrustedToolFilePreviewSource,
  runWithTrustedToolFilePreviewContext
} from "./trusted-tool-file-preview"

let temporaryDirectory = ""

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(path.join(tmpdir(), "cmb-tool-preview-durable-"))
  storageState.databasePath = path.join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()
})

beforeEach(() => {
  threadDb.createThread("thread-1")
})

afterEach(() => {
  clearTrustedToolFilePreviewSourcesForTests()
  if (threadDb.threadExists("thread-1")) threadDb.deleteThread("thread-1")
  if (threadDb.threadExists("thread-delete")) threadDb.deleteThread("thread-delete")
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("durable trusted tool file preview sources", () => {
  it("restores a source after the database and in-memory registry restart", async () => {
    const filePath = path.join(temporaryDirectory, "report.md")
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-1", toolCallId: "call-1", toolName: "write_file" },
      () => recordTrustedToolFilePreviewSource(filePath, "write")
    )
    clearTrustedToolFilePreviewMemoryForTests()
    await threadDb.closeDatabase()
    await threadDb.initializeDatabase()

    expect(resolveTrustedToolFilePreviewSource("thread-1", "call-1")).toMatchObject({
      filePath,
      operation: "write"
    })
  })

  it("keeps an ambiguous persisted tool-call id fail-closed", () => {
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-1", toolCallId: "call-1", toolName: "read_file" },
      () => {
        recordTrustedToolFilePreviewSource(path.join(temporaryDirectory, "one.md"), "read")
        recordTrustedToolFilePreviewSource(path.join(temporaryDirectory, "two.md"), "read")
      }
    )
    clearTrustedToolFilePreviewMemoryForTests()

    expect(resolveTrustedToolFilePreviewSource("thread-1", "call-1")).toBeNull()
  })

  it("removes durable sources when a thread is deleted", () => {
    threadDb.createThread("thread-delete")
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-delete", toolCallId: "call-1", toolName: "write_file" },
      () =>
        recordTrustedToolFilePreviewSource(
          path.join(temporaryDirectory, "deleted.md"),
          "write"
        )
    )

    threadDb.deleteThread("thread-delete")
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-delete", toolCallId: "call-late", toolName: "write_file" },
      () =>
        recordTrustedToolFilePreviewSource(
          path.join(temporaryDirectory, "late-after-delete.md"),
          "write"
        )
    )

    expect(resolveTrustedToolFilePreviewSource("thread-delete", "call-1")).toBeNull()
    expect(resolveTrustedToolFilePreviewSource("thread-delete", "call-late")).toBeNull()
  })

  it("revokes a grant after its source was evicted from memory before thread deletion", async () => {
    const filePath = path.join(temporaryDirectory, "evicted.md")
    writeFileSync(filePath, "evicted", "utf8")
    runWithTrustedToolFilePreviewContext(
      { threadId: "thread-1", toolCallId: "call-evicted", toolName: "read_file" },
      () => recordTrustedToolFilePreviewSource(filePath, "read")
    )
    const issued = issueTrustedToolFilePreviewGrant("thread-1", "call-evicted", 7)
    expect(issued.success).toBe(true)
    if (!issued.success) return
    clearTrustedToolFilePreviewMemoryForTests()

    const capturedScopeKeys = collectTrustedToolFilePreviewScopeKeysForThread("thread-1")
    threadDb.deleteThread("thread-1")
    clearTrustedToolFilePreviewSourcesForThread("thread-1", capturedScopeKeys)

    await expect(resolveExternalFileReadGrant(issued.grant, 7, filePath)).resolves.toEqual({
      error: "Invalid or expired grant"
    })
  })
})
