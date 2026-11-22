import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { sqliteRecoveryFamilyKey } from "../db/sqlite-recovery-family"
import { readCheckpointDatabaseFileIdentity } from "./checkpoint-database-identity"
import { assertStockCheckpointIsOrdinary, createStockLegacyTranscriptAccess } from "./legacy-stock-transcript-authority"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "./runtime-projection-protocol"

it("accepts the encoded unset native channel from a normal checkpoint", () => {
  const cancellation = new Int32Array(new SharedArrayBuffer(4))
  const check = (cmbFunctionConversation: unknown) => assertStockCheckpointIsOrdinary({
    channel_values: { cmbFunctionConversation }
  }, cancellation)
  expect(() => check({ lc: 2, type: "undefined" })).not.toThrow()
  expect(() => check({ lc: 2, type: "undefined", conversationId: "native" }))
    .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  expect(() => check({ conversationId: "native" })).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
})

it("rolls back an ordinary recovery batch when its persisted workspace authority changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-stock-transcript-guard-"))
  const checkpointDatabasePath = join(directory, "checkpoint.sqlite")
  const messageDatabasePath = join(directory, "messages.sqlite")
  const database = new DatabaseSync(messageDatabasePath)
  try {
    database.exec(`
      CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT);
      INSERT INTO threads VALUES ('thread', 15, '{"workspacePath":"original"}');
      CREATE TABLE thread_messages (thread_id TEXT, message_id TEXT);
    `)
    const access = createStockLegacyTranscriptAccess({
      checkpointDatabasePath, messageDatabasePath, threadId: "thread",
      cancellation: new Int32Array(new SharedArrayBuffer(4)),
      authority: {
        messageDatabaseFile: await readCheckpointDatabaseFileIdentity(messageDatabasePath),
        checkpointFamilyKey: sqliteRecoveryFamilyKey(checkpointDatabasePath),
        incarnation: { token: null, legacyCreatedAt: 15 },
        workspace: "original"
      }
    })
    const writer = access.openWriter(100)
    try {
      writer.exec("BEGIN IMMEDIATE")
      writer.prepare("INSERT INTO thread_messages VALUES (?, ?)").run("thread", "partial")
      writer.prepare("UPDATE threads SET metadata=? WHERE thread_id=?")
        .run('{"workspacePath":"different"}', "thread")
      expect(() => writer.exec("COMMIT")).toThrow(
        expect.objectContaining({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED })
      )
    } finally {
      writer.close()
    }
    expect(database.prepare("SELECT message_id FROM thread_messages").all()).toEqual([])
    expect(database.prepare("SELECT metadata FROM threads").get()?.metadata)
      .toBe('{"workspacePath":"original"}')
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

it.each(["project change", "native owner"])("rolls back a project reservation batch on %s", async (change) => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-project-reservation-guard-"))
  const checkpointDatabasePath = join(directory, "checkpoint.sqlite")
  const messageDatabasePath = join(directory, "messages.sqlite")
  const database = new DatabaseSync(messageDatabasePath)
  try {
    database.exec(`
      CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT);
      CREATE TABLE thread_messages (thread_id TEXT, message_id TEXT);
      CREATE TABLE function_logical_sessions (thread_id TEXT);
      CREATE TABLE legacy_checkpoint_transcript_migrations
        (thread_id TEXT, checkpoint_id TEXT, status TEXT, scoped_order INTEGER, ordinal_reservation TEXT);
      INSERT INTO legacy_checkpoint_transcript_migrations VALUES ('thread', 'checkpoint', 'reserving', 1, '{}');
    `)
    const metadata = { workspacePath: directory, harnessProjectSession: { projectId: "project", kind: "chat" } }
    database.prepare("INSERT INTO threads VALUES ('thread', 15, ?)").run(JSON.stringify(metadata))
    const access = createStockLegacyTranscriptAccess({
      checkpointDatabasePath, messageDatabasePath, threadId: "thread",
      cancellation: new Int32Array(new SharedArrayBuffer(4)),
      authority: {
        messageDatabaseFile: await readCheckpointDatabaseFileIdentity(messageDatabasePath),
        checkpointFamilyKey: sqliteRecoveryFamilyKey(checkpointDatabasePath),
        incarnation: { token: null, legacyCreatedAt: 15 }, workspace: directory,
        projectReservation: { projectId: "project", kind: "chat", checkpointId: "checkpoint" }
      }
    })
    access.assertOrdinary()
    const writer = access.openWriter(100)
    try {
      writer.exec("BEGIN IMMEDIATE")
      writer.prepare("INSERT INTO thread_messages VALUES ('thread', 'partial')").run()
      if (change === "project change") writer.prepare("UPDATE threads SET metadata=?").run(JSON.stringify({
        ...metadata, harnessProjectSession: { projectId: "different-project", kind: "chat" }
      }))
      else writer.prepare("INSERT INTO function_logical_sessions VALUES ('thread')").run()
      expect(() => writer.exec("COMMIT")).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    } finally {
      writer.close()
    }
    expect(database.prepare("SELECT message_id FROM thread_messages").all()).toEqual([])
    expect(database.prepare("SELECT metadata FROM threads").get()?.metadata).toBe(JSON.stringify(metadata))
    expect(database.prepare("SELECT thread_id FROM function_logical_sessions").all()).toEqual([])
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
