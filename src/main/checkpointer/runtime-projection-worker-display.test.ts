import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple
} from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it } from "vitest"
import { readLatestCheckpointTuple } from "./runtime-projection-store"
import { SqlJsSaver } from "./sqljs-saver"

const directories: string[] = []
afterEach(() => {
  const failures: unknown[] = []
  for (const directory of directories.splice(0)) {
    try {
      if (
        dirname(resolve(directory)) !== resolve(tmpdir()) ||
        !basename(directory).startsWith("cmb-worker-display-sql-")
      )
        throw Error("Only the isolated worker display SQL fixture may be removed")
      rmSync(directory, { recursive: true, force: true })
    } catch (reason) {
      failures.push(reason)
    }
  }
  if (failures.length) throw new AggregateError(failures, "Worker display SQL cleanup failed")
})

async function fixture(messages: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), "cmb-worker-display-sql-"))
  directories.push(directory)
  const databasePath = join(directory, "checkpoint.sqlite")
  const threadId = `actual-worker-${randomUUID()}`
  const checkpoint: Checkpoint = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    channel_values: { messages, __start__: { messages }, __pregel_tasks: [["task", { messages }]] },
    channel_versions: { messages: 1 },
    versions_seen: {}
  }
  const saver = new SqlJsSaver(databasePath)
  const metadata: CheckpointMetadata<{ writes: Record<string, never> }> = {
    source: "loop",
    step: 1,
    writes: {},
    parents: {}
  }
  try {
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: "" } },
      checkpoint,
      metadata
    )
  } finally {
    await saver.close()
  }
  // A genuine older inline checkpoint exercises both raw JSON and the real oversized SQL fallback.
  const writer = new DatabaseSync(databasePath)
  try {
    writer
      .prepare("UPDATE checkpoints SET type='json',checkpoint=? WHERE thread_id=?")
      .run(JSON.stringify(checkpoint), threadId)
    writer.prepare("DELETE FROM checkpoint_message_snapshots WHERE thread_id=?").run(threadId)
    writer.prepare("DELETE FROM checkpoint_runtime_projections WHERE thread_id=?").run(threadId)
  } finally {
    writer.close()
  }
  const raw = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      return database
        .prepare("SELECT type,checkpoint FROM checkpoints WHERE thread_id=?")
        .get(threadId)
    } finally {
      database.close()
    }
  }
  const before = raw()
  const read = () =>
    readLatestCheckpointTuple(databasePath, threadId, "", {
      messageLimit: 500,
      messageByteBudget: 1024 * 1024
    }) as CheckpointTuple
  return { read, raw, before, checkpoint, threadId }
}

function messages(tuple: CheckpointTuple): Array<{
  id: string
  content: string
  additional_kwargs?: Record<string, unknown>
}> {
  return tuple.checkpoint.channel_values.messages as Array<{
    id: string
    content: string
    additional_kwargs?: Record<string, unknown>
  }>
}

describe("bounded ordinary worker checkpoint display", () => {
  it.each([256, 128 * 1024])(
    "uses visible Human text for a %i-byte raw message through actual SQLite",
    async (size) => {
      const hidden = "HIDDEN_WORKER_CONTEXT" + "x".repeat(size)
      const visible = "Visible full request 中文\nsecond line"
      const f = await fixture([
        {
          id: ["langchain_core", "messages", "HumanMessage"],
          kwargs: {
            id: "original-human-id",
            content: hidden,
            additional_kwargs: { cmb_visible_user_message: visible }
          }
        },
        { id: "original-ai-id", type: "ai", content: "Complete assistant body" }
      ])
      const value = f.read()
      expect(messages(value).map((message) => [message.id, message.content])).toEqual([
        ["original-human-id", visible],
        ["original-ai-id", "Complete assistant body"]
      ])
      expect(JSON.stringify(value)).not.toContain("HIDDEN_WORKER_CONTEXT")
      expect(value.config.configurable?.thread_id).toBe(f.threadId)
      expect(value.checkpoint.channel_values).not.toHaveProperty("__start__")
      expect(value.checkpoint.channel_values).not.toHaveProperty("__pregel_tasks")
      expect(value).not.toHaveProperty("pendingWrites")
      expect(f.raw()).toEqual(f.before)
    }
  )

  it("keeps top-level alias precedence, empty aliases and non-Human content unchanged", async () => {
    const f = await fixture([
      {
        id: "top",
        type: "human",
        content: "Raw top hidden",
        additional_kwargs: {
          cmb_visible_user_message: "Selected top alias"
        },
        kwargs: {
          additional_kwargs: { cmb_visible_user_message: "Unused nested alias" }
        }
      },
      {
        id: "empty",
        type: "human",
        content: "Original empty-alias body",
        additional_kwargs: { cmb_visible_user_message: "" }
      },
      {
        id: "assistant",
        type: "ai",
        content: "Original assistant body",
        additional_kwargs: { cmb_visible_user_message: "Unused assistant alias" }
      },
      {
        id: "priority",
        type: "human",
        content: "Original empty-object priority",
        additional_kwargs: {},
        kwargs: { additional_kwargs: { cmb_visible_user_message: "Unused fallback" } }
      }
    ])
    expect(messages(f.read()).map((message) => message.content)).toEqual([
      "Selected top alias",
      "Original empty-alias body",
      "Original assistant body",
      "Original empty-object priority"
    ])
    expect(f.raw()).toEqual(f.before)
  })

  it.each(["valid", "invalid"] as const)(
    "preserves %s canonical markers and does not substitute their alias",
    async (kind) => {
      const stamp = {
        conversationId: "actual",
        branchId: "branch",
        uuid: "canonical-human",
        sequence: 1,
        door: "note",
        messageType: "user",
        isMeta: true,
        origin: { kind: "plugin", name: "ActualPlugin" }
      }
      const raw = "CANONICAL_ORIGINAL_CONTEXT" + "x".repeat(128 * 1024)
      const f = await fixture([
        {
          id: ["langchain_core", "messages", "HumanMessage"],
          kwargs: {
            id: "canonical-human",
            content: raw,
            additional_kwargs: {
              function_row: kind === "valid" ? stamp : null,
              cmb_visible_user_message: "Not a canonical display authorization"
            }
          }
        }
      ])
      const message = messages(f.read())[0]
      expect(message.content).toBe(raw.slice(0, 120_000))
      if (kind === "valid") expect(message.additional_kwargs?.function_row).toEqual(stamp)
      else expect(message.additional_kwargs?.function_row_invalid).toBe(true)
      expect(f.raw()).toEqual(f.before)
    }
  )

  it("applies the existing content and whole-message byte bounds to an oversized visible alias", async () => {
    const alias = "可见".repeat(130_000)
    const f = await fixture([
      {
        id: "bounded-human",
        type: "human",
        content: "HIDDEN_RAW",
        additional_kwargs: { cmb_visible_user_message: alias }
      }
    ])
    const value = f.read()
    expect(messages(value)[0]).toMatchObject({
      id: "bounded-human",
      content: alias.slice(0, 120_000)
    })
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThan(1024 * 1024)
    expect(JSON.stringify(value)).not.toContain("HIDDEN_RAW")
    expect(f.raw()).toEqual(f.before)
  })
})
