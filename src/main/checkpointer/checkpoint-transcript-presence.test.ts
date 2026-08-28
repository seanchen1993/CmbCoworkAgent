import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  bootstrapLegacyCheckpointTranscript,
  hasVisibleCheckpointTranscript
} from "./runtime-projection-store"
import { bootstrapLegacyCheckpointTranscriptInWorker } from "./runtime-projection-client"

const temporaryDirectories: string[] = []

function createCheckpointDatabase(threadId: string, messages: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-presence-"))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, `${threadId}.sqlite`)
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      checkpoint_ts TEXT,
      type TEXT NOT NULL,
      checkpoint BLOB NOT NULL,
      metadata BLOB NOT NULL
    );
    CREATE TABLE checkpoint_message_snapshots (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      prefix_length INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL,
      generation TEXT NOT NULL DEFAULT '',
      type TEXT,
      suffix BLOB NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    );
    CREATE TABLE checkpoint_runtime_projections (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      checkpoint_ts TEXT NOT NULL,
      projection_version INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL,
      runtime_checkpoint BLOB NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns)
    );
  `)
  database
    .prepare(
      `INSERT INTO checkpoints (
         thread_id, checkpoint_ns, checkpoint_id, checkpoint_ts, type, checkpoint, metadata
       ) VALUES (?, '', 'checkpoint-1', '2026-08-26T00:00:00.000Z', 'json', ?, '{}')`
    )
    .run(
      threadId,
      JSON.stringify({
        channel_values: { messages },
        channel_versions: {},
        versions_seen: {}
      })
    )
  database.close()
  return databasePath
}

function createMessageDatabase(threadId: string): string {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-message-store-"))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, "messages.sqlite")
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE threads (thread_id TEXT PRIMARY KEY);
    CREATE TABLE thread_messages (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      provider_source_id TEXT,
      provider_occurrence INTEGER,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      tool_calls_json TEXT,
      tool_call_id TEXT,
      name TEXT,
      status TEXT,
      is_error INTEGER,
      content_priority INTEGER,
      goal_id TEXT,
      active_window_id TEXT,
      created_at INTEGER NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(thread_id, message_id)
    );
    CREATE TABLE thread_message_buckets (
      thread_id TEXT PRIMARY KEY,
      message_count INTEGER NOT NULL,
      next_ordinal INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE thread_message_fragments (
      fragment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      content_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE thread_message_fragment_states (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      total_chars INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, message_id)
    );
    CREATE TABLE thread_goal_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
  database.prepare("INSERT INTO threads (thread_id) VALUES (?)").run(threadId)
  database
    .prepare(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'existing-internal', 'user', ?, 0, 0)`
    )
    .run(
      threadId,
      JSON.stringify(
        "[Continuing active goal]\n<untrusted_objective>keep working</untrusted_objective>"
      )
    )
  database
    .prepare(
      `INSERT INTO thread_message_buckets
       (thread_id, message_count, next_ordinal, updated_at) VALUES (?, 2, 2, 0)`
    )
    .run(threadId)
  database
    .prepare(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'newer-visible', 'assistant', ?, 1, 1)`
    )
    .run(threadId, JSON.stringify("newer durable reply"))
  database
    .prepare(
      `INSERT INTO thread_goal_events (thread_id, message, created_at)
       VALUES (?, '__cmb_goal_user_message__:/goal resume', 1)`
    )
    .run(threadId)
  database.close()
  return databasePath
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("checkpoint transcript presence", () => {
  it("detects an upgraded task whose only message still lives in a legacy checkpoint", () => {
    const databasePath = createCheckpointDatabase("legacy-only", [
      { id: "legacy-message", content: "x".repeat(2 * 1024 * 1024) }
    ])

    expect(hasVisibleCheckpointTranscript(databasePath, "legacy-only")).toBe(true)
  })

  it("does not lock a genuinely empty legacy checkpoint", () => {
    const databasePath = createCheckpointDatabase("legacy-empty", [])
    expect(hasVisibleCheckpointTranscript(databasePath, "legacy-empty")).toBe(false)
  })

  it("does not lock a legacy checkpoint that contains only internal plumbing", () => {
    const databasePath = createCheckpointDatabase("legacy-internal", [
      {
        type: "human",
        content:
          "[Continuing active goal]\n<untrusted_objective>keep working</untrusted_objective>"
      },
      { type: "system", content: "Goal 已继续：keep working" },
      {
        type: "human",
        content:
          "[[CMB_WORKFLOW_NOTIFICATION_TURN]]\nProcess the completed workflow task-notification. This is an internal system turn, not a new user request."
      },
      {
        type: "human",
        content: "internal notification",
        additional_kwargs: { cmb_internal_coordinator_notification: true }
      }
    ])

    expect(hasVisibleCheckpointTranscript(databasePath, "legacy-internal")).toBe(false)
  })

  it("counts a starting-goal fallback that the renderer restores as a visible bubble", () => {
    const databasePath = createCheckpointDatabase("legacy-starting-goal", [
      {
        type: "human",
        content:
          "[Starting active goal]\n<untrusted_objective>ship it</untrusted_objective>"
      }
    ])

    expect(hasVisibleCheckpointTranscript(databasePath, "legacy-starting-goal")).toBe(true)
  })

  it("uses the visible user alias and ignores summarization-only checkpoint rows", () => {
    const aliasPath = createCheckpointDatabase("legacy-visible-alias", [
      {
        type: "human",
        content:
          "[Continuing active goal]\n<untrusted_objective>ship it</untrusted_objective>",
        additional_kwargs: { cmb_visible_user_message: "/goal resume" }
      }
    ])
    expect(hasVisibleCheckpointTranscript(aliasPath, "legacy-visible-alias")).toBe(true)

    const summaryPath = createCheckpointDatabase("legacy-summary-only", [
      {
        type: "ai",
        content: "A compacted transcript summary that is not shown as a chat bubble",
        additional_kwargs: { lc_source: "summarization" }
      }
    ])
    expect(hasVisibleCheckpointTranscript(summaryPath, "legacy-summary-only")).toBe(false)
  })

  it("migrates a checkpoint prefix despite newer visible rows and a visible goal sidecar", () => {
    const threadId = "legacy-mixed-durable"
    const checkpointPath = createCheckpointDatabase(threadId, [
      { id: "visible-user", type: "human", content: "restore this earlier request" },
      {
        id: "trailing-internal",
        type: "human",
        content:
          "[Continuing active goal]\n<untrusted_objective>keep working</untrusted_objective>"
      }
    ])
    const messagePath = createMessageDatabase(threadId)

    const result = bootstrapLegacyCheckpointTranscript(
      checkpointPath,
      messagePath,
      threadId,
      "",
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    )
    expect(result.stats).toMatchObject({ totalMessages: 2, migratedMessages: 2 })

    const database = new DatabaseSync(messagePath, { readOnly: true })
    const rows = database
      .prepare(
        `SELECT message_id, content_json, ordinal
         FROM thread_messages WHERE thread_id = ? ORDER BY ordinal`
      )
      .all(threadId) as Array<{ message_id: string; content_json: string; ordinal: number }>
    const migration = database
      .prepare(
        `SELECT status FROM legacy_checkpoint_transcript_migrations
         WHERE thread_id = ?`
      )
      .get(threadId) as { status: string }
    database.close()

    expect(rows.map((row) => row.message_id)).toEqual([
      "visible-user",
      "trailing-internal",
      "existing-internal",
      "newer-visible"
    ])
    expect(JSON.parse(rows[0].content_json)).toBe("restore this earlier request")
    expect(migration.status).toBe("complete")
  })

  it("treats an absent checkpoint database as a confirmed empty legacy source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "checkpoint-presence-missing-"))
    temporaryDirectories.push(directory)
    const checkpointDatabasePath = join(directory, "missing.sqlite")

    const result = bootstrapLegacyCheckpointTranscript(
      checkpointDatabasePath,
      join(directory, "unused-messages.sqlite"),
      "new-thread",
      "",
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    )

    expect(result).toMatchObject({
      runtimeTuple: null,
      stats: { checkpointId: null, totalMessages: 0, migratedMessages: 0 }
    })
    await expect(
      bootstrapLegacyCheckpointTranscriptInWorker(
        checkpointDatabasePath,
        join(directory, "unused-messages.sqlite"),
        "new-thread"
      )
    ).resolves.toMatchObject({
      runtimeTuple: null,
      stats: { checkpointId: null, totalMessages: 0, migratedMessages: 0 }
    })
    expect(existsSync(checkpointDatabasePath)).toBe(false)
  })
})
