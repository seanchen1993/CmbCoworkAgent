import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { readPriorToolReplayIds } from "./tool-replay-evidence"

it("verifies exact older tool output outside the page, excluding variants and fragment heads", () => {
  const database = new DatabaseSync(":memory:")
  try {
    database.exec(`
      CREATE TABLE thread_messages (
        thread_id TEXT, message_id TEXT, provider_source_id TEXT, provider_occurrence INTEGER,
        role TEXT, ordinal INTEGER, content_json TEXT, tool_call_id TEXT, name TEXT, reasoning TEXT,
        status TEXT, is_error INTEGER, goal_id TEXT, active_window_id TEXT,
        PRIMARY KEY(thread_id, message_id)
      );
      CREATE INDEX provider_order ON thread_messages(thread_id, provider_source_id, role, provider_occurrence, ordinal);
      CREATE TABLE thread_message_fragment_states (thread_id TEXT, message_id TEXT);
    `)
    const add = database.prepare(`INSERT INTO thread_messages
      (thread_id, message_id, provider_source_id, provider_occurrence, role, ordinal,
       content_json, tool_call_id, name, status, is_error)
      VALUES ('thread', ?, ?, ?, 'tool', ?, ?, 'same-call', 'read_file', 'success', 0)`)
    add.run("older", null, null, 1, '"Original output"')
    add.run("exact-replay", "older", 2, 12, '"Original output"')
    add.run("different-version", "older", 3, 13, '"Revised output"')
    add.run("fragment-replay", "older", 4, 14, '"Original output"')
    database
      .prepare("INSERT INTO thread_message_fragment_states VALUES ('thread', 'fragment-replay')")
      .run()
    type Row = { id: string; ordinal: number; provider_occurrence?: number }
    const lookup = (rows: Row[]) =>
      readPriorToolReplayIds(
        "thread",
        rows.map((row) => ({ ...row, role: "tool" })),
        (sql, thread, ids, cutoff) =>
          database
            .prepare(sql)
            .all(thread, ids, cutoff)
            .map(({ message_id, earlier_id }) => [message_id, earlier_id])
      )
    const page = [
      { id: "exact-replay", ordinal: 12, provider_occurrence: 2 },
      { id: "different-version", ordinal: 13, provider_occurrence: 3 },
      { id: "fragment-replay", ordinal: 14, provider_occurrence: 4 }
    ]
    expect(lookup(page)).toEqual(new Map([["exact-replay", "older"]]))
    expect(lookup([{ id: "older", ordinal: 1 }, ...page]).size).toBe(0)
  } finally {
    database.close()
  }
})
