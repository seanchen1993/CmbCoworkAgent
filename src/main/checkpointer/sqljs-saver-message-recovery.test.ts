import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { RunnableConfig } from "@langchain/core/runnables"
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
  SerializerProtocol
} from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it } from "vitest"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import {
  CheckpointMessageSnapshotRecoveryError,
  SqlJsSaver
} from "./sqljs-saver"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cmb-snapshot-recovery-"))
  directories.push(directory)
  return join(directory, "thread.sqlite")
}

function config(threadId: string, checkpointId?: string, checkpointNs = ""): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      ...(checkpointId ? { checkpoint_id: checkpointId } : {})
    }
  }
}

function message(id: string, content = id): Record<string, unknown> {
  return { id, role: id.startsWith("u") ? "user" : "assistant", content }
}

function checkpoint(
  id: string,
  order: number,
  messages: unknown[],
  options: { interrupt?: boolean; pendingSends?: boolean } = {}
): Checkpoint {
  return {
    v: 1,
    id,
    ts: new Date(Date.UTC(2026, 7, 28, 0, 0, 0, order)).toISOString(),
    channel_values: {
      messages,
      todos: [{ id: "todo", content: "preserve me", status: "pending" }],
      ...(options.interrupt
        ? { __interrupt__: [{ value: { actionRequests: [{ action: "shell", args: {} }] } }] }
        : {})
    },
    channel_versions: { messages: order },
    versions_seen: {},
    pending_sends: options.pendingSends ? [{ taskId: "pending-task", writes: [] }] : []
  } as Checkpoint
}

const metadata = {
  source: "loop",
  step: 1,
  writes: {},
  parents: {}
} as CheckpointMetadata

const completedBoundaryMetadata = {
  ...metadata,
  cmb_fork_boundary: {
    source: "agent_run_complete",
    outcome: "completed",
    markedAt: "2026-08-28T00:00:10.000Z"
  }
} as CheckpointMetadata

function deleteSnapshot(path: string, threadId: string, checkpointId: string): void {
  const database = new DatabaseSync(path)
  database
    .prepare(
      `DELETE FROM checkpoint_message_snapshots
       WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
    )
    .run(threadId, checkpointId)
  database.close()
}

async function addLegacyPendingSends(
  path: string,
  threadId: string,
  checkpointId: string,
  serde: SerializerProtocol
): Promise<void> {
  const database = new DatabaseSync(path)
  const row = database
    .prepare(
      `SELECT type, checkpoint FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
    )
    .get(threadId, checkpointId) as { type?: unknown; checkpoint?: unknown } | undefined
  if (
    typeof row?.type !== "string" ||
    (typeof row.checkpoint !== "string" && !(row.checkpoint instanceof Uint8Array))
  ) {
    database.close()
    throw new Error("expected serialized checkpoint fixture")
  }
  const checkpoint = (await serde.loadsTyped(row.type, row.checkpoint)) as Checkpoint & {
    pending_sends?: unknown[]
  }
  checkpoint.pending_sends = [{ taskId: "legacy-pending-task", writes: [] }]
  const [type, serialized] = await serde.dumpsTyped(checkpoint)
  database
    .prepare(
      `UPDATE checkpoints SET type = ?, checkpoint = ?
       WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
    )
    .run(type, serialized, threadId, checkpointId)
  database.close()
}

function snapshotParent(
  path: string,
  threadId: string,
  checkpointId: string
): string | null | undefined {
  const database = new DatabaseSync(path, { readOnly: true })
  const row = database
    .prepare(
      `SELECT parent_checkpoint_id FROM checkpoint_message_snapshots
       WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
    )
    .get(threadId, checkpointId) as { parent_checkpoint_id: string | null } | undefined
  database.close()
  return row?.parent_checkpoint_id
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function wrapSerializer(
  delegate: SerializerProtocol,
  beforeDump: (value: unknown) => void | Promise<void>
): SerializerProtocol {
  return {
    dumpsTyped: async (value) => {
      await beforeDump(value)
      return delegate.dumpsTyped(value)
    },
    loadsTyped: (type, value) => delegate.loadsTyped(type, value)
  }
}

function putAsExternalSaver(
  saver: SqlJsSaver,
  runnableConfig: RunnableConfig,
  value: Checkpoint,
  valueMetadata: CheckpointMetadata
): Promise<RunnableConfig> {
  // Bypass the in-process FIFO to exercise the SQLite fence that protects
  // against a writer in another Electron process.
  return (
    saver as unknown as {
      putUnlocked: (
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata
      ) => Promise<RunnableConfig>
    }
  ).putUnlocked(runnableConfig, value, valueMetadata)
}

function getAsExternalSaver(
  saver: SqlJsSaver,
  runnableConfig: RunnableConfig,
  allowBoundedHistoryRecovery = false
): ReturnType<SqlJsSaver["getTuple"]> {
  return (
    saver as unknown as {
      getTupleUnlocked: (
        config: RunnableConfig,
        allowBounded?: boolean
      ) => ReturnType<SqlJsSaver["getTuple"]>
    }
  ).getTupleUnlocked(runnableConfig, allowBoundedHistoryRecovery)
}

function putWritesAsExternalSaver(
  saver: SqlJsSaver,
  runnableConfig: RunnableConfig,
  writes: PendingWrite[],
  taskId: string
): Promise<void> {
  return (
    saver as unknown as {
      putWritesUnlocked: (
        config: RunnableConfig,
        values: PendingWrite[],
        task: string
      ) => Promise<void>
    }
  ).putWritesUnlocked(runnableConfig, writes, taskId)
}

function saverInternals(saver: SqlJsSaver): {
  db: NativeSqliteAdapter | null
  maxRootCheckpoints: number
  pruneRootCheckpoints: (threadId: string, database: NativeSqliteAdapter) => void
} {
  return saver as unknown as {
    db: NativeSqliteAdapter | null
    maxRootCheckpoints: number
    pruneRootCheckpoints: (threadId: string, database: NativeSqliteAdapter) => void
  }
}

describe("SqlJsSaver checkpoint message integrity", () => {
  it("repairs only a missing snapshot, persists the base, and preserves interrupt state", async () => {
    const path = databasePath()
    const threadId = "recover-interrupt"
    const originalMessages = [message("u-1"), message("a-1")]
    const seed = new SqlJsSaver(path)
    await seed.put(
      config(threadId),
      checkpoint("cp-1", 1, originalMessages, { interrupt: true }),
      metadata
    )
    await seed.close()
    deleteSnapshot(path, threadId, "cp-1")

    let recoveryCalls = 0
    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async (context) => {
        recoveryCalls += 1
        expect(context.missingCheckpointId).toBe("cp-1")
        expect(context.hasInterrupt).toBe(true)
        return { messages: originalMessages, complete: true }
      }
    })
    const [first, second] = await Promise.all([
      saver.getTuple(config(threadId)),
      saver.getTuple(config(threadId))
    ])
    expect(recoveryCalls).toBe(1)
    expect(first?.checkpoint.channel_values.messages).toEqual(originalMessages)
    expect(second?.checkpoint.channel_values.messages).toEqual(originalMessages)
    expect(first?.checkpoint.channel_values.__interrupt__).toEqual([
      { value: { actionRequests: [{ action: "shell", args: {} }] } }
    ])
    expect(first?.checkpoint.channel_values.todos).toEqual([
      { id: "todo", content: "preserve me", status: "pending" }
    ])
    await saver.close()

    const reopened = new SqlJsSaver(path)
    const restored = await reopened.getTuple(config(threadId))
    expect(restored?.checkpoint.channel_values.messages).toEqual(originalMessages)
    expect(snapshotParent(path, threadId, "cp-1")).toBeNull()
    await reopened.close()
  })

  it("repairs the latest checkpoint through the product list(limit: 1) preflight path", async () => {
    const path = databasePath()
    const threadId = "recover-list-preflight"
    const originalMessages = [message("u-list-repair")]
    const seed = new SqlJsSaver(path)
    await seed.put(config(threadId), checkpoint("cp-list-repair", 1, originalMessages), metadata)
    await seed.close()
    deleteSnapshot(path, threadId, "cp-list-repair")

    let recoveryCalls = 0
    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => {
        recoveryCalls += 1
        return { messages: originalMessages, complete: true }
      }
    })
    const tuples: CheckpointTuple[] = []
    for await (const tuple of saver.list(config(threadId), { limit: 1 })) tuples.push(tuple)
    expect(recoveryCalls).toBe(1)
    expect(tuples).toHaveLength(1)
    expect(tuples[0]?.checkpoint.channel_values.messages).toEqual(originalMessages)
    expect(snapshotParent(path, threadId, "cp-list-repair")).toBeNull()
    await saver.close()
  })

  it("accepts a bounded completed-turn recovery and updates the old marker count", async () => {
    const path = databasePath()
    const threadId = "recover-bounded"
    const originalMessages = Array.from({ length: 1_501 }, (_, index) =>
      message(index % 2 === 0 ? `u-${index}` : `a-${index}`)
    )
    const recoveredMessages = originalMessages.slice(-1_000)
    const seed = new SqlJsSaver(path)
    await seed.put(
      config(threadId),
      checkpoint("cp-long", 1, originalMessages),
      metadata
    )
    await seed.close()
    deleteSnapshot(path, threadId, "cp-long")

    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => ({
        messages: recoveredMessages,
        complete: false,
        boundedByHistory: true
      })
    })
    const tuple = await saver.getLatestTupleForDurableTailRecovery(threadId)
    expect(tuple?.checkpoint.channel_values.messages).toEqual(recoveredMessages)
    await saver.close()

    const reopened = new SqlJsSaver(path)
    const restored = await reopened.getTuple(config(threadId))
    expect(restored?.checkpoint.channel_values.messages).toHaveLength(1_000)
    expect(restored?.checkpoint.channel_values.messages).toEqual(recoveredMessages)
    await reopened.close()
  })

  it("keeps ordinary reads exact even when the checkpoint has a completed marker", async () => {
    const path = databasePath()
    const threadId = "recover-completed-ordinary-exact"
    const originalMessages = Array.from({ length: 1_501 }, (_, index) =>
      message(index % 2 === 0 ? `u-${index}` : `a-${index}`)
    )
    const seed = new SqlJsSaver(path)
    await seed.put(
      config(threadId),
      checkpoint("cp-completed-ordinary", 1, originalMessages),
      completedBoundaryMetadata
    )
    await seed.close()
    deleteSnapshot(path, threadId, "cp-completed-ordinary")

    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => ({
        messages: originalMessages.slice(-1_000),
        complete: false,
        boundedByHistory: true
      })
    })
    await expect(saver.getTuple(config(threadId))).rejects.toBeInstanceOf(
      CheckpointMessageSnapshotRecoveryError
    )
    await saver.close()
  })

  it("keeps ordinary unmarked reads exact but lets the dedicated settled preflight recover", async () => {
    const path = databasePath()
    const threadId = "recover-bounded-in-progress"
    const originalMessages = Array.from({ length: 1_501 }, (_, index) =>
      message(index % 2 === 0 ? `u-${index}` : `a-${index}`)
    )
    const seed = new SqlJsSaver(path)
    await seed.put(config(threadId), checkpoint("cp-in-progress", 1, originalMessages), metadata)
    await seed.close()
    deleteSnapshot(path, threadId, "cp-in-progress")

    const exactRequirements: boolean[] = []
    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async (context) => {
        exactRequirements.push(context.requiresExactRecovery)
        return {
          messages: originalMessages.slice(-1_000),
          complete: false,
          boundedByHistory: true
        }
      }
    })
    await expect(saver.getTuple(config(threadId))).rejects.toBeInstanceOf(
      CheckpointMessageSnapshotRecoveryError
    )
    const recovered = await saver.getLatestTupleForDurableTailRecovery(threadId)
    expect(exactRequirements).toEqual([true, false])
    expect(recovered?.checkpoint.channel_values.messages).toEqual(originalMessages.slice(-1_000))
    await saver.close()
  })

  it("fails closed when an interrupted checkpoint only has a bounded recovery", async () => {
    const path = databasePath()
    const threadId = "recover-interrupt-incomplete"
    const seed = new SqlJsSaver(path)
    await seed.put(
      config(threadId),
      checkpoint("cp-interrupt", 1, [message("u-1")], { interrupt: true }),
      metadata
    )
    await seed.close()
    deleteSnapshot(path, threadId, "cp-interrupt")

    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => ({
        messages: [message("u-1")],
        complete: false,
        boundedByHistory: true
      })
    })
    await expect(saver.getLatestTupleForDurableTailRecovery(threadId)).rejects.toBeInstanceOf(
      CheckpointMessageSnapshotRecoveryError
    )
    expect(snapshotParent(path, threadId, "cp-interrupt")).toBeUndefined()
    await saver.close()
  })

  it("fails closed when a complete interrupted recovery has messages after its marker", async () => {
    const path = databasePath()
    const threadId = "recover-interrupt-stale-tail"
    const seed = new SqlJsSaver(path)
    await seed.put(
      config(threadId),
      checkpoint("cp-interrupt-tail", 1, [message("u-1")], { interrupt: true }),
      metadata
    )
    await seed.close()
    deleteSnapshot(path, threadId, "cp-interrupt-tail")

    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => ({
        messages: [message("u-1"), message("u-after-checkpoint")],
        complete: true
      })
    })
    await expect(saver.getLatestTupleForDurableTailRecovery(threadId)).rejects.toBeInstanceOf(
      CheckpointMessageSnapshotRecoveryError
    )
    expect(snapshotParent(path, threadId, "cp-interrupt-tail")).toBeUndefined()
    await saver.close()
  })

  it("requires an exact recovery when the checkpoint has pending sends", async () => {
    const path = databasePath()
    const threadId = "recover-pending-sends"
    const seed = new SqlJsSaver(path)
    await seed.put(
      config(threadId),
      checkpoint("cp-pending-sends", 1, [message("u-1")]),
      metadata
    )
    await seed.close()
    await addLegacyPendingSends(path, threadId, "cp-pending-sends", seed.serde)
    deleteSnapshot(path, threadId, "cp-pending-sends")

    let requiresExactRecovery = false
    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async (context) => {
        requiresExactRecovery = context.requiresExactRecovery
        return { messages: [message("u-1")], complete: true }
      }
    })
    const tuple = await saver.getLatestTupleForDurableTailRecovery(threadId)
    expect(requiresExactRecovery).toBe(true)
    expect(
      (tuple?.checkpoint as Checkpoint & { pending_sends?: unknown[] }).pending_sends
    ).toHaveLength(1)
    await saver.close()

    const reopened = new SqlJsSaver(path)
    const restored = await reopened.getTuple(config(threadId))
    expect(
      (restored?.checkpoint as Checkpoint & { pending_sends?: unknown[] }).pending_sends
    ).toHaveLength(1)
    await reopened.close()
  })

  it("requires an exact recovery when the checkpoint has pending writes", async () => {
    const path = databasePath()
    const threadId = "recover-pending-writes"
    const seed = new SqlJsSaver(path)
    const saved = await seed.put(
      config(threadId),
      checkpoint("cp-pending-writes", 1, [message("u-1")]),
      metadata
    )
    await seed.putWrites(
      saved,
      [["messages", { id: "pending-tool-result" }]] as PendingWrite[],
      "pending-tool-task"
    )
    await seed.close()
    deleteSnapshot(path, threadId, "cp-pending-writes")

    let requiresExactRecovery = false
    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async (context) => {
        requiresExactRecovery = context.requiresExactRecovery
        return {
          messages: [message("u-1")],
          complete: false,
          boundedByHistory: true
        }
      }
    })
    await expect(saver.getLatestTupleForDurableTailRecovery(threadId)).rejects.toBeInstanceOf(
      CheckpointMessageSnapshotRecoveryError
    )
    expect(requiresExactRecovery).toBe(true)
    await saver.close()
  })

  it("observes a public pending-write intent queued behind recovery", async () => {
    const path = databasePath()
    const threadId = "recover-late-pending-write"
    const seed = new SqlJsSaver(path)
    const saved = await seed.put(
      config(threadId),
      checkpoint("cp-late-write", 1, [message("u-1")]),
      completedBoundaryMetadata
    )
    await seed.close()
    deleteSnapshot(path, threadId, "cp-late-write")

    const entered = deferred()
    const release = deferred()
    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => {
        entered.resolve()
        await release.promise
        return { messages: [message("u-1")], complete: false, boundedByHistory: true }
      }
    })
    const externalSaver = new SqlJsSaver(path)
    await externalSaver.initialize()
    const recovery = saver.getLatestTupleForDurableTailRecovery(threadId)
    await entered.promise
    const pendingWrite = externalSaver.putWrites(
      saved,
      [["messages", { id: "late-tool-result" }]] as PendingWrite[],
      "late-tool-task"
    )
    release.resolve()

    await expect(recovery).rejects.toBeInstanceOf(CheckpointMessageSnapshotRecoveryError)
    await pendingWrite
    expect(snapshotParent(path, threadId, "cp-late-write")).toBeUndefined()
    await saver.close()
    await externalSaver.close()
  })

  it("rechecks externally committed pending writes inside the final transaction", async () => {
    const path = databasePath()
    const threadId = "recover-external-pending-write"
    const seed = new SqlJsSaver(path)
    const saved = await seed.put(
      config(threadId),
      checkpoint("cp-external-write", 1, [message("u-1")]),
      completedBoundaryMetadata
    )
    await seed.close()
    deleteSnapshot(path, threadId, "cp-external-write")

    const entered = deferred()
    const release = deferred()
    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => {
        entered.resolve()
        await release.promise
        return { messages: [message("u-1")], complete: false, boundedByHistory: true }
      }
    })
    const externalSaver = new SqlJsSaver(path)
    await externalSaver.initialize()
    const recovery = saver.getLatestTupleForDurableTailRecovery(threadId)
    await entered.promise
    await putWritesAsExternalSaver(
      externalSaver,
      saved,
      [["messages", { id: "external-tool-result" }]] as PendingWrite[],
      "external-tool-task"
    )
    release.resolve()

    await expect(recovery).rejects.toBeInstanceOf(CheckpointMessageSnapshotRecoveryError)
    expect(snapshotParent(path, threadId, "cp-external-write")).toBeUndefined()
    await saver.close()
    await externalSaver.close()
  })

  it("never repairs a historical checkpoint from the current durable transcript", async () => {
    const path = databasePath()
    const threadId = "recover-historical"
    const options = { maxRootCheckpoints: 2 }
    const seed = new SqlJsSaver(path, undefined, options)
    await seed.put(config(threadId), checkpoint("cp-old", 1, [message("u-old")]), metadata)
    await seed.put(
      config(threadId, "cp-old"),
      checkpoint("cp-new", 2, [message("u-old"), message("a-new")]),
      metadata
    )
    await seed.close()
    deleteSnapshot(path, threadId, "cp-old")

    let recoveryCalls = 0
    const saver = new SqlJsSaver(path, undefined, {
      ...options,
      recoverMissingCheckpointMessages: async () => {
        recoveryCalls += 1
        return { messages: [message("u-old"), message("a-new")], complete: true }
      }
    })
    await expect(saver.getTuple(config(threadId, "cp-old"))).rejects.toBeInstanceOf(
      CheckpointMessageSnapshotRecoveryError
    )
    expect(recoveryCalls).toBe(0)
    expect(snapshotParent(path, threadId, "cp-old")).toBeUndefined()
    expect((await saver.getTuple(config(threadId)))?.checkpoint.id).toBe("cp-new")
    await saver.close()
  })

  it("does not overwrite a newer checkpoint committed while recovery is reading", async () => {
    const path = databasePath()
    const threadId = "recover-cas-newer"
    const options = { maxRootCheckpoints: 2 }
    const seed = new SqlJsSaver(path, undefined, options)
    await seed.put(config(threadId), checkpoint("cp-repair-target", 1, [message("u-1")]), metadata)
    await seed.close()
    deleteSnapshot(path, threadId, "cp-repair-target")

    const recoveryEntered = deferred()
    const releaseRecovery = deferred()
    const repairingSaver = new SqlJsSaver(path, undefined, {
      ...options,
      recoverMissingCheckpointMessages: async () => {
        recoveryEntered.resolve()
        await releaseRecovery.promise
        return { messages: [message("u-1")], complete: true }
      }
    })
    const externalSaver = new SqlJsSaver(path, undefined, options)
    await externalSaver.initialize()
    const repair = repairingSaver.getTuple(config(threadId))
    await recoveryEntered.promise

    await putAsExternalSaver(
      externalSaver,
      config(threadId, "cp-repair-target"),
      checkpoint("cp-newer-during-repair", 2, [message("u-1"), message("a-new")]),
      metadata
    )
    releaseRecovery.resolve()
    await expect(repair).rejects.toBeInstanceOf(CheckpointMessageSnapshotRecoveryError)
    expect(snapshotParent(path, threadId, "cp-repair-target")).toBeUndefined()
    expect((await externalSaver.getTuple(config(threadId)))?.checkpoint.id).toBe(
      "cp-newer-during-repair"
    )
    await repairingSaver.close()
    await externalSaver.close()
  })

  it("serializes same-namespace puts FIFO while allowing a different namespace to proceed", async () => {
    const path = databasePath()
    const threadId = "fifo"
    const saver = new SqlJsSaver(path)
    const base = message("u-base")
    await saver.put(config(threadId), checkpoint("cp-base", 1, [base]), metadata)

    const blocked = deferred()
    let blockFirstDelta = true
    let otherNamespaceEntered = false
    const delegate = saver.serde
    saver.serde = wrapSerializer(delegate, async (value) => {
      if (Array.isArray(value) && value.some((entry) => entry === "other-ns")) {
        otherNamespaceEntered = true
      }
      if (
        blockFirstDelta &&
        Array.isArray(value) &&
        value.some((entry) => (entry as { id?: string })?.id === "a-delta")
      ) {
        blockFirstDelta = false
        await blocked.promise
      }
    })

    const deltaMessages = [base, message("a-delta")]
    const deltaPut = saver.put(
      config(threadId, "cp-base"),
      checkpoint("cp-delta", 2, deltaMessages),
      metadata
    )
    await Promise.resolve()
    const laterPut = saver.put(
      config(threadId, "cp-delta"),
      checkpoint("cp-later", 3, [base, message("a-later")]),
      metadata
    )
    const otherNamespacePut = saver.put(
      config(threadId, undefined, "other"),
      checkpoint("cp-other", 1, ["other-ns"]),
      metadata
    )
    await otherNamespacePut
    expect(otherNamespaceEntered).toBe(true)
    expect(snapshotParent(path, threadId, "cp-later")).toBeUndefined()

    blocked.resolve()
    await Promise.all([deltaPut, laterPut])
    const tuple = await saver.getTuple(config(threadId))
    expect(tuple?.checkpoint.id).toBe("cp-later")
    await saver.close()
  })

  it("serializes the same namespace across two saver instances for one database", async () => {
    const path = databasePath()
    const threadId = "fifo-two-savers"
    const seed = new SqlJsSaver(path)
    await seed.put(config(threadId), checkpoint("cp-shared-base", 1, [message("u-base")]), metadata)
    await seed.close()

    const firstSaver = new SqlJsSaver(path)
    const secondSaver = new SqlJsSaver(path)
    const firstBase = (
      (await firstSaver.getTuple(config(threadId)))?.checkpoint.channel_values.messages as unknown[]
    )
    await secondSaver.getTuple(config(threadId))

    const firstEntered = deferred()
    const releaseFirst = deferred()
    let blockedFirst = true
    const firstDelegate = firstSaver.serde
    firstSaver.serde = wrapSerializer(firstDelegate, async (value) => {
      if (
        blockedFirst &&
        Array.isArray(value) &&
        value.some((entry) => (entry as { id?: string })?.id === "a-first")
      ) {
        blockedFirst = false
        firstEntered.resolve()
        await releaseFirst.promise
      }
    })

    let secondSerializerEntered = false
    const secondDelegate = secondSaver.serde
    secondSaver.serde = wrapSerializer(secondDelegate, (value) => {
      if (
        Array.isArray(value) &&
        value.some((entry) => (entry as { id?: string })?.id === "a-second")
      ) {
        secondSerializerEntered = true
      }
    })

    const firstPut = firstSaver.put(
      config(threadId, "cp-shared-base"),
      checkpoint("cp-first", 2, [...firstBase, message("a-first")]),
      metadata
    )
    await firstEntered.promise
    const secondPut = secondSaver.put(
      config(threadId, "cp-first"),
      checkpoint("cp-second", 3, [...firstBase, message("a-first"), message("a-second")]),
      metadata
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(secondSerializerEntered).toBe(false)

    releaseFirst.resolve()
    await Promise.all([firstPut, secondPut])
    expect(secondSerializerEntered).toBe(true)
    expect((await secondSaver.getTuple(config(threadId)))?.checkpoint.id).toBe("cp-second")
    await firstSaver.close()
    await secondSaver.close()
  })

  it("rebases under the writer lock when another saver collected its selected parent", async () => {
    const path = databasePath()
    const threadId = "cross-saver-parent"
    const seed = new SqlJsSaver(path)
    await seed.put(config(threadId), checkpoint("cp-parent", 1, [message("u-base")]), metadata)
    await seed.close()

    const delayedSaver = new SqlJsSaver(path)
    const rebasingSaver = new SqlJsSaver(path)
    const delayedBase = (
      (await delayedSaver.getTuple(config(threadId)))?.checkpoint.channel_values.messages as unknown[]
    )[0]
    const rebasingBase = (
      (await rebasingSaver.getTuple(config(threadId)))?.checkpoint.channel_values.messages as unknown[]
    )[0]

    const blocked = deferred()
    let blockFirstDelta = true
    let delayedArraySerializations = 0
    const delegate = delayedSaver.serde
    delayedSaver.serde = wrapSerializer(delegate, async (value) => {
      if (
        Array.isArray(value) &&
        value.some((entry) => (entry as { id?: string })?.id === "a-delayed")
      ) {
        delayedArraySerializations += 1
        if (blockFirstDelta) {
          blockFirstDelta = false
          await blocked.promise
        }
      }
    })

    const delayedMessages = [delayedBase, message("a-delayed")]
    const delayedPut = delayedSaver.put(
      config(threadId, "cp-parent"),
      checkpoint("cp-delayed", 4, delayedMessages),
      metadata
    )
    await Promise.resolve()

    const hugeTail = message("a-huge", "x".repeat(8 * 1024 * 1024 + 4_096))
    await putAsExternalSaver(
      rebasingSaver,
      config(threadId, "cp-parent"),
      checkpoint("cp-rebase", 3, [rebasingBase, hugeTail]),
      metadata
    )
    expect(snapshotParent(path, threadId, "cp-parent")).toBeUndefined()

    blocked.resolve()
    await delayedPut
    expect(delayedArraySerializations).toBe(2)
    expect(snapshotParent(path, threadId, "cp-delayed")).toBeNull()
    await delayedSaver.close()
    await rebasingSaver.close()

    const reopened = new SqlJsSaver(path)
    const tuple = await reopened.getTuple(config(threadId))
    expect(tuple?.checkpoint.id).toBe("cp-delayed")
    expect(tuple?.checkpoint.channel_values.messages).toEqual(delayedMessages)
    await reopened.close()
  }, 30_000)

  it("rebases when another process replaces the parent with a shorter recovery", async () => {
    const path = databasePath()
    const threadId = "cross-saver-parent-count"
    const seedMessages = [message("u-1"), message("a-1"), message("u-2")]
    const seed = new SqlJsSaver(path)
    await seed.put(
      config(threadId),
      checkpoint("cp-parent-count", 1, seedMessages),
      completedBoundaryMetadata
    )
    await seed.close()

    const delayedSaver = new SqlJsSaver(path)
    const recoveringSaver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => ({
        messages: seedMessages.slice(0, 2),
        complete: false,
        boundedByHistory: true
      })
    })
    const cachedMessages = (
      (await delayedSaver.getTuple(config(threadId)))?.checkpoint.channel_values.messages as unknown[]
    )
    await recoveringSaver.initialize()

    const blocked = deferred()
    let blockFirstDelta = true
    let delayedArraySerializations = 0
    const delegate = delayedSaver.serde
    delayedSaver.serde = wrapSerializer(delegate, async (value) => {
      if (
        Array.isArray(value) &&
        value.some((entry) => (entry as { id?: string })?.id === "a-after-recovery")
      ) {
        delayedArraySerializations += 1
        if (blockFirstDelta) {
          blockFirstDelta = false
          await blocked.promise
        }
      }
    })

    const nextMessages = [...cachedMessages, message("a-after-recovery")]
    const delayedPut = delayedSaver.put(
      config(threadId, "cp-parent-count"),
      checkpoint("cp-after-short-parent", 2, nextMessages),
      metadata
    )
    await Promise.resolve()
    deleteSnapshot(path, threadId, "cp-parent-count")
    await getAsExternalSaver(recoveringSaver, config(threadId), true)
    expect(snapshotParent(path, threadId, "cp-parent-count")).toBeNull()

    blocked.resolve()
    await delayedPut
    expect(delayedArraySerializations).toBe(2)
    expect(snapshotParent(path, threadId, "cp-after-short-parent")).toBeNull()
    expect((await delayedSaver.getTuple(config(threadId)))?.checkpoint.channel_values.messages).toEqual(
      nextMessages
    )
    await delayedSaver.close()
    await recoveringSaver.close()
  })

  it("rebases when another process replaces a parent with the same count but new content", async () => {
    const path = databasePath()
    const threadId = "cross-saver-parent-generation"
    const original = [message("u-1", "old"), message("a-1")]
    const replacement = [message("u-1", "changed"), message("a-1")]
    const seed = new SqlJsSaver(path)
    await seed.put(config(threadId), checkpoint("cp-generation", 1, original), metadata)
    await seed.close()

    const delayedSaver = new SqlJsSaver(path)
    const replacingSaver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => ({
        messages: replacement,
        complete: true
      })
    })
    const cached = (
      (await delayedSaver.getTuple(config(threadId)))?.checkpoint.channel_values.messages as unknown[]
    )
    await replacingSaver.initialize()

    const blocked = deferred()
    let blockFirstDelta = true
    let serializations = 0
    const delegate = delayedSaver.serde
    delayedSaver.serde = wrapSerializer(delegate, async (value) => {
      if (
        Array.isArray(value) &&
        value.some((entry) => (entry as { id?: string })?.id === "a-generation-child")
      ) {
        serializations += 1
        if (blockFirstDelta) {
          blockFirstDelta = false
          await blocked.promise
        }
      }
    })

    const childMessages = [...cached, message("a-generation-child")]
    const childPut = delayedSaver.put(
      config(threadId, "cp-generation"),
      checkpoint("cp-generation-child", 2, childMessages),
      metadata
    )
    await Promise.resolve()
    deleteSnapshot(path, threadId, "cp-generation")
    await getAsExternalSaver(replacingSaver, config(threadId))
    blocked.resolve()
    await childPut

    expect(serializations).toBe(2)
    expect(snapshotParent(path, threadId, "cp-generation-child")).toBeNull()
    expect(
      (await delayedSaver.getTuple(config(threadId)))?.checkpoint.channel_values.messages
    ).toEqual(childMessages)
    await delayedSaver.close()
    await replacingSaver.close()
  })

  it("invalidates a hydrated cache when an external writer changes its generation", async () => {
    const path = databasePath()
    const threadId = "cache-generation"
    const original = [message("u-cache", "old")]
    const replacement = [message("u-cache", "changed")]
    const seed = new SqlJsSaver(path)
    await seed.put(config(threadId), checkpoint("cp-cache-generation", 1, original), metadata)
    await seed.close()

    const cachedSaver = new SqlJsSaver(path)
    const replacingSaver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async () => ({ messages: replacement, complete: true })
    })
    expect((await cachedSaver.getTuple(config(threadId)))?.checkpoint.channel_values.messages).toEqual(
      original
    )
    await replacingSaver.initialize()
    deleteSnapshot(path, threadId, "cp-cache-generation")
    await getAsExternalSaver(replacingSaver, config(threadId))

    expect((await cachedSaver.getTuple(config(threadId)))?.checkpoint.channel_values.messages).toEqual(
      replacement
    )
    await cachedSaver.close()
    await replacingSaver.close()
  })

  it("backfills a legacy generation column in SQLite and keeps the first append incremental", async () => {
    const path = databasePath()
    const threadId = "legacy-generation-delta"
    const original = Array.from({ length: 1_501 }, (_, index) =>
      message(index % 2 === 0 ? `u-${index}` : `a-${index}`)
    )
    const seed = new SqlJsSaver(path)
    await seed.put(config(threadId), checkpoint("cp-legacy-generation", 1, original), metadata)
    await seed.close()

    const legacyDatabase = new DatabaseSync(path)
    legacyDatabase.exec("ALTER TABLE checkpoint_message_snapshots DROP COLUMN generation")
    legacyDatabase.close()

    const saver = new SqlJsSaver(path)
    const restored = (await saver.getTuple(config(threadId)))?.checkpoint.channel_values
      .messages as unknown[]
    const serializedMessageArrayLengths: number[] = []
    const delegate = saver.serde
    saver.serde = wrapSerializer(delegate, (value) => {
      if (
        Array.isArray(value) &&
        value.some((entry) => (entry as { id?: string })?.id === "a-after-upgrade")
      ) {
        serializedMessageArrayLengths.push(value.length)
      }
    })
    await saver.put(
      config(threadId, "cp-legacy-generation"),
      checkpoint("cp-after-upgrade", 2, [...restored, message("a-after-upgrade")]),
      metadata
    )

    expect(serializedMessageArrayLengths).toEqual([1])
    expect(snapshotParent(path, threadId, "cp-after-upgrade")).toBe("cp-legacy-generation")
    await saver.close()
  })

  it("releases the list lock before yielding to nested same-namespace work", async () => {
    const path = databasePath()
    const threadId = "list-yield-release"
    const saver = new SqlJsSaver(path)
    await saver.put(config(threadId), checkpoint("cp-list", 1, [message("u-list")]), metadata)

    for await (const tuple of saver.list(config(threadId), { limit: 1 })) {
      expect(tuple.checkpoint.id).toBe("cp-list")
      expect((await saver.getTuple(config(threadId)))?.checkpoint.id).toBe("cp-list")
      break
    }
    await saver.close()
  })

  it("releases a failed namespace queue for the next put", async () => {
    const path = databasePath()
    const threadId = "failed-queue"
    const saver = new SqlJsSaver(path)
    const delegate = saver.serde
    let failOnce = true
    saver.serde = wrapSerializer(delegate, (value) => {
      if (
        failOnce &&
        Array.isArray(value) &&
        value.some((entry) => (entry as { id?: string })?.id === "a-fail")
      ) {
        failOnce = false
        throw new Error("intentional serializer failure")
      }
    })

    await expect(
      saver.put(config(threadId), checkpoint("cp-fail", 1, [message("a-fail")]), metadata)
    ).rejects.toThrow("intentional serializer failure")
    await saver.put(config(threadId), checkpoint("cp-success", 2, [message("a-ok")]), metadata)
    const tuple = await saver.getTuple(config(threadId))
    expect(tuple?.checkpoint.id).toBe("cp-success")
    await saver.close()
  })

  it("holds the root retention scan and delete under one writer transaction", async () => {
    const path = databasePath()
    const threadId = "root-retention-transaction"
    const saver = new SqlJsSaver(path, undefined, { maxRootCheckpoints: 3 })
    await saver.put(config(threadId), checkpoint("cp-root-1", 1, [message("u-1")]), metadata)
    await saver.put(
      config(threadId, "cp-root-1"),
      checkpoint("cp-root-2", 2, [message("u-1"), message("a-1")]),
      metadata
    )

    const internal = saverInternals(saver)
    if (!internal.db) throw new Error("expected initialized checkpoint database")
    internal.maxRootCheckpoints = 1
    const adapter = internal.db
    const competitor = new DatabaseSync(path, { timeout: 1 })
    competitor.exec("PRAGMA busy_timeout = 1")
    const competitorInsert = competitor.prepare(
      `INSERT INTO checkpoints (
         thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type,
         checkpoint, metadata, checkpoint_ts, fork_boundary_marker
       )
       SELECT thread_id, checkpoint_ns, ?, parent_checkpoint_id, type,
              checkpoint, metadata, ?, fork_boundary_marker
       FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
    )
    const originalExec = adapter.exec.bind(adapter)
    let competingWriteBlocked = false
    adapter.exec = ((sql, bindings) => {
      const result = originalExec(sql, bindings)
      if (sql.includes("WITH RECURSIVE message_chain")) {
        try {
          competitorInsert.run(
            "cp-root-competing",
            "2026-08-28T00:00:10.000Z",
            threadId,
            "cp-root-2"
          )
        } catch (error) {
          competingWriteBlocked = /busy|locked/i.test(String(error))
        }
      }
      return result
    }) as NativeSqliteAdapter["exec"]
    try {
      internal.pruneRootCheckpoints(threadId, adapter)
    } finally {
      adapter.exec = originalExec
    }
    expect(competingWriteBlocked).toBe(true)

    competitorInsert.run(
      "cp-root-competing",
      "2026-08-28T00:00:10.000Z",
      threadId,
      "cp-root-2"
    )
    const surviving = competitor
      .prepare(
        `SELECT 1 FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .get(threadId, "cp-root-competing")
    expect(surviving).toBeDefined()
    competitor.close()
    await saver.close()
  })

  it("does not report a committed put as failed when post-commit retention is busy", async () => {
    const path = databasePath()
    const threadId = "retention-busy-after-commit"
    const seed = new SqlJsSaver(path)
    await seed.put(config(threadId), checkpoint("cp-before-busy", 1, [message("u-1")]), metadata)
    await seed.close()

    const saver = new SqlJsSaver(path)
    await saver.initialize()
    const internal = saverInternals(saver)
    if (!internal.db) throw new Error("expected initialized checkpoint database")
    const adapter = internal.db
    const originalRun = adapter.run.bind(adapter)
    let mainCommitObserved = false
    let injectedBusy = false
    adapter.run = ((sql, bindings) => {
      if (mainCommitObserved && !injectedBusy && sql.trim() === "BEGIN IMMEDIATE") {
        injectedBusy = true
        throw new Error("SQLITE_BUSY: simulated post-commit retention contention")
      }
      const result = originalRun(sql, bindings)
      if (sql.trim() === "COMMIT" && !mainCommitObserved) mainCommitObserved = true
      return result
    }) as NativeSqliteAdapter["run"]
    try {
      await expect(
        saver.put(
          config(threadId, "cp-before-busy"),
          checkpoint("cp-after-busy", 2, [message("u-1"), message("a-1")]),
          metadata
        )
      ).resolves.toMatchObject({ configurable: { checkpoint_id: "cp-after-busy" } })
    } finally {
      adapter.run = originalRun
    }
    expect(injectedBusy).toBe(true)
    expect((await saver.getTuple(config(threadId)))?.checkpoint.id).toBe("cp-after-busy")
    await saver.close()
  })
})
