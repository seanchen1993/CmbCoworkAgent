/**
 * Regression coverage for incremental checkpoint transcript storage.
 *
 * Run:
 *   npx tsx tests/checkpointer-message-delta.spec.ts
 */

import assert from "assert"
import { mkdtemp, rm } from "fs/promises"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { SerializerProtocol } from "@langchain/langgraph-checkpoint"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "os"
import { join } from "path"
import { SqlJsSaver } from "../src/main/checkpointer/sqljs-saver"

function config(threadId: string, checkpointId?: string): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: "",
      checkpoint_id: checkpointId
    }
  }
}

function checkpoint(id: string, version: number, messages: unknown[]): Checkpoint {
  return {
    v: 1,
    id,
    ts: new Date(Date.UTC(2026, 7, 21, 0, 0, 0, version)).toISOString(),
    channel_values: {
      messages,
      unrelated: "small",
      todos: [{ id: "todo-1", content: "keep runtime state", status: "pending" }],
      __interrupt__: [{ value: { actionRequests: [{ action: "shell", args: {} }] } }]
    },
    channel_versions: { messages: version, unrelated: 1 },
    versions_seen: {},
    pending_sends: []
  } as Checkpoint
}

const metadata = {
  source: "loop",
  step: 1,
  writes: {},
  parents: {}
} as CheckpointMetadata

function poisonStablePrefix(messages: Array<Record<string, unknown>>): void {
  for (const message of messages) {
    Object.defineProperty(message, "toJSON", {
      configurable: true,
      get() {
        throw new Error("stable checkpoint history was serialized again")
      }
    })
  }
}

function rejectLargeDeserialization(
  delegate: SerializerProtocol,
  maxBytes: number,
  observedBytes: number[]
): SerializerProtocol {
  return {
    dumpsTyped: (value) => delegate.dumpsTyped(value),
    loadsTyped: (type, value) => {
      const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength
      observedBytes.push(bytes)
      if (bytes > maxBytes) {
        throw new Error(`runtime projection read ${bytes} serialized bytes`)
      }
      return delegate.loadsTyped(type, value)
    }
  }
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "checkpointer-message-delta-"))
  const databasePath = join(directory, "thread.sqlite")
  const threadId = "long-history"

  try {
    const sameVersionThreadId = "same-version-replacement"
    const sameVersionSaver = new SqlJsSaver(databasePath)
    const firstSameVersionMessages = [
      { id: "same-version-old", role: "assistant", content: "old" }
    ]
    const replacementSameVersionMessages = [
      { id: "same-version-new", role: "assistant", content: "new" }
    ]
    await sameVersionSaver.put(
      config(sameVersionThreadId),
      checkpoint("same-version-1", 1, firstSameVersionMessages),
      metadata
    )
    await sameVersionSaver.put(
      config(sameVersionThreadId, "same-version-1"),
      checkpoint("same-version-2", 1, replacementSameVersionMessages),
      metadata
    )
    await sameVersionSaver.close()

    const sameVersionReopened = new SqlJsSaver(databasePath)
    const sameVersionTuple = await sameVersionReopened.getTuple(config(sameVersionThreadId))
    assert.deepEqual(
      (sameVersionTuple?.checkpoint.channel_values as { messages?: unknown[] }).messages,
      replacementSameVersionMessages,
      "channel version equality must not alias a different same-length transcript"
    )
    await sameVersionReopened.close()

    const stablePrefixBacking = Array.from({ length: 10_000 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `stable-${index}`
    }))
    let stablePrefixIndexReads = 0
    const stablePrefix = new Proxy(stablePrefixBacking, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          stablePrefixIndexReads += 1
        }
        return Reflect.get(target, property, receiver)
      }
    })
    const saver = new SqlJsSaver(databasePath)
    await saver.put(config(threadId), checkpoint("cp-1", 1, stablePrefix), metadata)

    poisonStablePrefix(stablePrefix)
    const firstTail = { id: "live-tail", role: "assistant", content: "a" }
    const firstExtendedMessages = [...stablePrefix, firstTail]
    stablePrefixIndexReads = 0
    await saver.put(
      config(threadId, "cp-1"),
      checkpoint("cp-2", 2, firstExtendedMessages),
      metadata
    )
    assert(
      stablePrefixIndexReads <= 64,
      `append-only checkpoint rescanned ${stablePrefixIndexReads} stable message references`
    )
    await saver.close()

    const reopened = new SqlJsSaver(databasePath)
    const hydrationTarget = reopened as unknown as {
      hydrateCheckpointMessages: (...args: unknown[]) => Promise<Checkpoint>
    }
    const originalHydrateCheckpointMessages = hydrationTarget.hydrateCheckpointMessages.bind(
      reopened
    )
    hydrationTarget.hydrateCheckpointMessages = async () => {
      throw new Error("runtime state read hydrated the 10k transcript")
    }
    const runtimeTuple = await reopened.getLatestRuntimeTuple(config(threadId))
    const runtimeValues = runtimeTuple?.checkpoint.channel_values as Record<string, unknown>
    assert.equal(runtimeTuple?.checkpoint.id, "cp-2")
    assert.equal("messages" in runtimeValues, false)
    assert.equal(runtimeValues.unrelated, "small")
    assert.deepEqual(runtimeValues.todos, [
      { id: "todo-1", content: "keep runtime state", status: "pending" }
    ])
    assert.deepEqual(runtimeValues.__interrupt__, [
      { value: { actionRequests: [{ action: "shell", args: {} }] } }
    ])
    hydrationTarget.hydrateCheckpointMessages = originalHydrateCheckpointMessages

    const restored = await reopened.getTuple(config(threadId))
    const restoredMessages = (restored?.checkpoint.channel_values as { messages?: unknown[] })
      .messages
    assert.equal(restored?.checkpoint.id, "cp-2")
    assert.equal(restoredMessages?.length, 10_001)
    assert.deepEqual(restoredMessages?.at(-1), firstTail)

    const restoredPrefix = restoredMessages!.slice(0, -1) as Array<Record<string, unknown>>
    poisonStablePrefix(restoredPrefix)
    const completedTail = { id: "live-tail", role: "assistant", content: "answer" }
    let completedTailIndexReads = 0
    const completedTailMessages = new Proxy([...restoredPrefix, completedTail], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          completedTailIndexReads += 1
        }
        return Reflect.get(target, property, receiver)
      }
    })
    await reopened.put(
      config(threadId, "cp-2"),
      checkpoint("cp-3", 3, completedTailMessages),
      metadata
    )
    assert(
      completedTailIndexReads <= 128,
      `tail replacement rescanned ${completedTailIndexReads} stable message references`
    )
    await reopened.close()

    const finalSaver = new SqlJsSaver(databasePath)
    const finalTuple = await finalSaver.getTuple(config(threadId))
    const finalMessages = (finalTuple?.checkpoint.channel_values as { messages?: unknown[] })
      .messages
    assert.equal(finalTuple?.checkpoint.id, "cp-3")
    assert.equal(finalMessages?.length, 10_001)
    assert.deepEqual(finalMessages?.at(-1), completedTail)
    assert.equal(
      (finalMessages?.[9_999] as { content?: string }).content,
      "stable-9999",
      "a pruned parent checkpoint must keep the external snapshot chain needed by the latest row"
    )
    const chainPrefix = finalMessages!.slice(0, -1) as Array<Record<string, unknown>>
    poisonStablePrefix(chainPrefix)
    let parentCheckpointId = "cp-3"
    let expectedTail = completedTail
    for (let index = 0; index < 96; index += 1) {
      expectedTail = {
        id: "live-tail",
        role: "assistant",
        content: `answer-${index}`
      }
      const checkpointId = `cp-chain-${String(index).padStart(3, "0")}`
      let checkpointIndexReads = 0
      const checkpointMessages = new Proxy([...chainPrefix, expectedTail], {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            checkpointIndexReads += 1
          }
          return Reflect.get(target, property, receiver)
        }
      })
      await finalSaver.put(
        config(threadId, parentCheckpointId),
        checkpoint(checkpointId, index + 10, checkpointMessages),
        metadata
      )
      assert(
        checkpointIndexReads <= 128,
        `checkpoint ${checkpointId} rescanned ${checkpointIndexReads} stable references`
      )
      parentCheckpointId = checkpointId
    }
    await finalSaver.close()

    const chainSaver = new SqlJsSaver(databasePath)
    const chainTuple = await chainSaver.getTuple(config(threadId))
    const chainMessages = (chainTuple?.checkpoint.channel_values as { messages?: unknown[] })
      .messages
    assert.equal(chainTuple?.checkpoint.id, parentCheckpointId)
    assert.equal(chainMessages?.length, 10_001)
    assert.deepEqual(chainMessages?.at(-1), expectedTail)
    assert.equal((chainMessages?.[0] as { content?: string }).content, "stable-0")
    await chainSaver.close()

    const legacyThreadId = "legacy-inline-runtime-projection"
    const legacyMessages = Array.from({ length: 10_000 }, (_, index) => ({
      id: `legacy-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `legacy checkpoint content ${index}`
    }))
    const legacyCheckpoint = checkpoint("legacy-inline-cp", 180, legacyMessages)
    const legacySeed = new SqlJsSaver(databasePath)
    await legacySeed.put(config(legacyThreadId), legacyCheckpoint, metadata)
    const [legacyType, legacyPayload] = await legacySeed.serde.dumpsTyped(legacyCheckpoint)
    await legacySeed.close()

    const legacyRaw = new DatabaseSync(databasePath)
    legacyRaw
      .prepare(
        `UPDATE checkpoints SET type = ?, checkpoint = ?
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .run(legacyType, legacyPayload, legacyThreadId, legacyCheckpoint.id)
    legacyRaw
      .prepare(
        `DELETE FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .run(legacyThreadId, legacyCheckpoint.id)
    legacyRaw.close()

    const legacyMigrator = new SqlJsSaver(databasePath)
    const firstLegacyRuntime = await legacyMigrator.getLatestRuntimeTuple(config(legacyThreadId))
    assert.equal(firstLegacyRuntime?.checkpoint.id, legacyCheckpoint.id)
    assert.equal(
      "messages" in (firstLegacyRuntime?.checkpoint.channel_values as Record<string, unknown>),
      false
    )

    const sameInstanceObservedBytes: number[] = []
    legacyMigrator.serde = rejectLargeDeserialization(
      legacyMigrator.serde,
      64 * 1024,
      sameInstanceObservedBytes
    )
    const repeatedLegacyRuntime = await legacyMigrator.getLatestRuntimeTuple(config(legacyThreadId))
    assert.equal(repeatedLegacyRuntime?.checkpoint.id, legacyCheckpoint.id)
    assert(
      Math.max(0, ...sameInstanceObservedBytes) < 64 * 1024,
      "repeat runtime hydration must read only the compact checkpoint projection"
    )
    await legacyMigrator.close()

    const compactRaw = new DatabaseSync(databasePath, { readOnly: true })
    const compactLegacyRow = compactRaw
      .prepare(
        `SELECT LENGTH(checkpoint) AS checkpoint_bytes
         FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .get(legacyThreadId, legacyCheckpoint.id) as { checkpoint_bytes: number }
    const legacySnapshotRow = compactRaw
      .prepare(
        `SELECT message_count
         FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .get(legacyThreadId, legacyCheckpoint.id) as { message_count: number }
    compactRaw.close()
    assert(
      Number(compactLegacyRow.checkpoint_bytes) < 64 * 1024,
      `legacy checkpoint remained ${compactLegacyRow.checkpoint_bytes} bytes after migration`
    )
    assert.equal(Number(legacySnapshotRow.message_count), legacyMessages.length)

    const reopenedLegacy = new SqlJsSaver(databasePath)
    const reopenedObservedBytes: number[] = []
    reopenedLegacy.serde = rejectLargeDeserialization(
      reopenedLegacy.serde,
      64 * 1024,
      reopenedObservedBytes
    )
    const reopenedLegacyRuntime = await reopenedLegacy.getLatestRuntimeTuple(config(legacyThreadId))
    assert.equal(reopenedLegacyRuntime?.checkpoint.id, legacyCheckpoint.id)
    assert(
      Math.max(0, ...reopenedObservedBytes) < 64 * 1024,
      "reopened runtime hydration must not parse the migrated transcript snapshot"
    )
    await reopenedLegacy.close()

    const restoredLegacy = new SqlJsSaver(databasePath)
    const restoredLegacyTuple = await restoredLegacy.getTuple(config(legacyThreadId))
    const restoredLegacyMessages = (
      restoredLegacyTuple?.checkpoint.channel_values as { messages?: unknown[] }
    ).messages
    assert.equal(restoredLegacyMessages?.length, legacyMessages.length)
    assert.deepEqual(restoredLegacyMessages?.at(-1), legacyMessages.at(-1))
    await restoredLegacy.close()

    const boundedThreadId = "bounded-chain"
    const boundedSaver = new SqlJsSaver(databasePath)
    let boundedMessages: Array<Record<string, unknown>> = [
      { id: "bounded-0", role: "user", content: "base" }
    ]
    let boundedParent: string | undefined
    for (let index = 0; index < 150; index += 1) {
      const checkpointId = `bounded-${String(index).padStart(3, "0")}`
      if (index > 0) {
        boundedMessages = [
          ...boundedMessages,
          { id: `bounded-${index}`, role: "assistant", content: `tail-${index}` }
        ]
      }
      await boundedSaver.put(
        config(boundedThreadId, boundedParent),
        checkpoint(checkpointId, index + 200, boundedMessages),
        metadata
      )
      boundedParent = checkpointId
    }
    await boundedSaver.close()

    const raw = new DatabaseSync(databasePath, { readOnly: true })
    const snapshotCount = raw
      .prepare(
        `SELECT COUNT(*) AS count FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = ''`
      )
      .get(boundedThreadId) as { count: number }
    let chainDepth = 0
    let cursor: string | null = boundedParent ?? null
    const parentStatement = raw.prepare(
      `SELECT parent_checkpoint_id FROM checkpoint_message_snapshots
       WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
    )
    while (cursor) {
      const row = parentStatement.get(boundedThreadId, cursor) as
        | { parent_checkpoint_id: string | null }
        | undefined
      assert(row, `missing physical message snapshot ${cursor}`)
      chainDepth += 1
      cursor = row.parent_checkpoint_id
    }
    raw.close()

    assert(chainDepth <= 128, `message snapshot restore depth grew to ${chainDepth}`)
    assert(
      Number(snapshotCount.count) <= 128,
      `rebased message snapshots were not collected: ${snapshotCount.count}`
    )

    const boundedReopened = new SqlJsSaver(databasePath)
    const boundedTuple = await boundedReopened.getTuple(config(boundedThreadId))
    const boundedRestored = (
      boundedTuple?.checkpoint.channel_values as { messages?: unknown[] }
    ).messages
    assert.equal(boundedRestored?.length, 150)
    assert.deepEqual(boundedRestored?.at(-1), boundedMessages.at(-1))
    await boundedReopened.close()

    console.log("checkpointer message delta tests passed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
