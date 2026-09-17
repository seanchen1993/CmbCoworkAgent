import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it } from "vitest"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { readFunctionSessionCheckpoint } from "./session-checkpoint"
import {
  FunctionSessionTranscriptWindow,
  projectFunctionSessionMessages
} from "./session-transcript"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !directory.includes("mods-session-checkpoint-")
    )
      throw new Error("Unexpected fixture path")
    rmSync(directory, { recursive: true, force: true })
  }
})

async function fixture(messages: unknown[], inline = false, state: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mods-session-checkpoint-"))
  directories.push(directory)
  const path = join(directory, "checkpoint.sqlite")
  const saver = new SqlJsSaver(path)
  const checkpoint = {
    v: 1,
    id: "01",
    ts: "2026-09-18T00:00:00Z",
    channel_values: { ...state, messages },
    channel_versions: { messages: 1 },
    versions_seen: {}
  } as Checkpoint
  await saver.put({ configurable: { thread_id: "thread", checkpoint_ns: "" } }, checkpoint, {
    source: "loop",
    step: 1,
    writes: {},
    parents: {}
  } as CheckpointMetadata)
  const [type, payload] = await saver.serde.dumpsTyped(checkpoint)
  await saver.close()
  if (inline) {
    const db = new DatabaseSync(path)
    try {
      db.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
      db.exec(
        "DELETE FROM checkpoint_runtime_projections; DELETE FROM checkpoint_message_snapshots"
      )
    } finally {
      db.close()
    }
  }
  return path
}

for (const inline of [true, false])
  it(`reads complete ${inline ? "inline" : "external"} engine messages without UI truncation`, async () => {
    const messages = [
      new HumanMessage("prompt"),
      new AIMessage({
        content: "answer",
        tool_calls: [
          { id: "call", name: "tool", args: { value: "a".repeat(40000) }, type: "tool_call" }
        ]
      }),
      new ToolMessage({
        tool_call_id: "call",
        content: "b".repeat(80000),
        artifact: { actual: [1, 2] }
      })
    ]
    const path = await fixture(messages, inline)
    const value = readFunctionSessionCheckpoint(path, "thread", "")
    expect(value).toEqual({
      checkpointId: "01",
      messageCount: 3,
      turns: 1,
      messages: projectFunctionSessionMessages(messages)
    })
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      expect(db.prepare("SELECT count(*) AS n FROM checkpoints").get()?.n).toBe(1)
      if (inline)
        expect(
          db.prepare("SELECT count(*) AS n FROM checkpoint_runtime_projections").get()?.n
        ).toBe(0)
    } finally {
      db.close()
    }
  })

for (const inline of [true, false])
  it(`reads only post-compaction usage from ${inline ? "inline" : "external"} checkpoints`, async () => {
    const messages = [
      new HumanMessage("prompt"),
      new AIMessage({
        content: "old",
        usage_metadata: { input_tokens: 900, output_tokens: 3, total_tokens: 903 }
      }),
      new HumanMessage("continue")
    ]
    const state = {
      _summarizationEvent: {
        cutoffIndex: 1,
        usageStartIndex: 3,
        summaryMessage: new HumanMessage("summary"),
        filePath: null
      }
    }
    const compacted = await fixture(messages, inline, state)
    const first = readFunctionSessionCheckpoint(compacted, "thread", "", undefined, "usage")
    expect(first?.usage).toBeUndefined()
    expect(first).not.toHaveProperty("messages")
    const current = await fixture(
      [
        ...messages,
        new AIMessage({
          content: "new",
          usage_metadata: { input_tokens: 50, output_tokens: 2, total_tokens: 52 }
        })
      ],
      inline,
      state
    )
    expect(readFunctionSessionCheckpoint(current, "thread", "", undefined, "usage")?.usage).toEqual(
      {
        input_tokens: 50,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    )
  })

for (const inline of [true, false])
  it(`does not resurrect usage from legacy or invalid ${inline ? "inline" : "external"} boundaries`, async () => {
    const messages = [
      new AIMessage({
        content: "old",
        usage_metadata: { input_tokens: 900, output_tokens: 3, total_tokens: 903 }
      })
    ]
    for (const event of [{ cutoffIndex: 0 }, { usageStartIndex: -1 }, { usageStartIndex: "0" }]) {
      const path = await fixture(messages, inline, { _summarizationEvent: event })
      expect(
        readFunctionSessionCheckpoint(path, "thread", "", undefined, "usage")?.usage
      ).toBeUndefined()
    }
    const path = await fixture(messages, inline)
    expect(
      readFunctionSessionCheckpoint(path, "thread", "", undefined, "usage")?.usage?.input_tokens
    ).toBe(900)
  })

it("returns absent checkpoints, rejects cancelled reads, oversized rows and malformed inline entries", async () => {
  const path = await fixture([new HumanMessage("prompt")], true)
  expect(readFunctionSessionCheckpoint(path, "missing", "")).toBeNull()
  const cancellation = new Int32Array(new SharedArrayBuffer(4))
  Atomics.store(cancellation, 0, 1)
  expect(() => readFunctionSessionCheckpoint(path, "thread", "", cancellation.buffer)).toThrow(
    expect.objectContaining({ name: "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED" })
  )
  const oversized = await fixture([{ type: "human", content: "x".repeat(1048577) }])
  expect(() => readFunctionSessionCheckpoint(oversized, "thread", "")).toThrow(
    "CHECKPOINT_MESSAGE_SIZE_LIMIT"
  )
  const malformed = await fixture(["not a message"], true)
  expect(() => readFunctionSessionCheckpoint(malformed, "thread", "")).toThrow(
    "CHECKPOINT_MESSAGES_INVALID"
  )
  const db = new DatabaseSync(path)
  try {
    db.exec(
      "UPDATE checkpoints SET checkpoint = json_set(CAST(checkpoint AS TEXT), '$.channel_values.messages', json('{}'))"
    )
  } finally {
    db.close()
  }
  expect(() => readFunctionSessionCheckpoint(path, "thread", "")).toThrow(
    "CHECKPOINT_MESSAGES_INVALID"
  )
})

it("keeps the newest eligible 4096 entries and counts prompts outside that window", () => {
  const window = new FunctionSessionTranscriptWindow()
  window.push({ type: "user", content: "x".repeat(700000) })
  window.push({ type: "user", content: "x".repeat(700000) })
  expect(() => window.finish()).toThrow("MODS_JSON_SIZE")
  for (let index = 0; index < 4096; index++) {
    window.push({ type: "user", isMeta: true, content: "hidden" })
    window.push({ type: "user", content: String(index) })
  }
  const result = window.finish()
  expect(result.turns).toBe(4098)
  expect(result.messages).toHaveLength(4096)
  expect(result.messages[0].text).toBe("0")
  expect(result.messages.at(-1)?.text).toBe("4095")
})
