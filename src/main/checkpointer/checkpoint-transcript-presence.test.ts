import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { hasCheckpointTranscript } from "./runtime-projection-store"

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
      message_count INTEGER NOT NULL
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

    expect(hasCheckpointTranscript(databasePath, "legacy-only")).toBe(true)
  })

  it("does not lock a genuinely empty legacy checkpoint", () => {
    const databasePath = createCheckpointDatabase("legacy-empty", [])
    expect(hasCheckpointTranscript(databasePath, "legacy-empty")).toBe(false)
  })
})
