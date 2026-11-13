import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Checkpoint, CheckpointMetadata, SerializerProtocol } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as identities from "./checkpoint-database-identity"
import { runCheckpointDatabaseMaintenance } from "./checkpoint-database-admission"
import { SqlJsSaver, CheckpointMessageSnapshotRecoveryError } from "./sqljs-saver"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function hasIntent(saver: SqlJsSaver, threadId = "thread", namespace = ""): boolean {
  return (saver as unknown as {
    hasPendingWriteIntent(threadId: string, namespace: string): boolean
  }).hasPendingWriteIntent(threadId, namespace)
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "saver-write-intent-"))
  const actual = join(root, "actual")
  mkdirSync(actual)
  const path = join(actual, "thread.sqlite")
  const savers: SqlJsSaver[] = [], releases: Array<() => void> = [], pending: Promise<unknown>[] = []
  const make = (name = path, serde?: SerializerProtocol) => {
    const saver = new SqlJsSaver(name, serde)
    savers.push(saver)
    return saver
  }
  const held = () => {
    const value = deferred()
    releases.push(value.resolve)
    return value
  }
  const observe = <T>(value: Promise<T>): Promise<T> => {
    pending.push(value.then(() => undefined, () => undefined))
    return value
  }
  cleanups.push(async () => {
    for (const release of releases) release()
    await Promise.allSettled(pending)
    vi.restoreAllMocks()
    await Promise.all(savers.map(saver => saver.close()))
    rmSync(root, { recursive: true, force: true })
  })
  const messages = [{ id: "one", role: "user", content: "one" },
    { id: "two", role: "assistant", content: "two" }]
  const checkpoint: Checkpoint = {
    v: 1, id: "checkpoint", ts: "2026-08-28T00:00:00.000Z",
    channel_values: { messages }, channel_versions: { messages: 1 }, versions_seen: {}
  }
  const seed = make()
  const config = await seed.put({ configurable: { thread_id: "thread" } }, checkpoint, {
    source: "loop", step: 1, parents: {},
    cmb_fork_boundary: { source: "agent_run_complete", outcome: "completed",
      markedAt: "2026-08-28T00:00:01.000Z" }
  } as CheckpointMetadata)
  await seed.close()
  const database = new DatabaseSync(path)
  try { database.exec("DELETE FROM checkpoint_message_snapshots") }
  finally { database.close() }
  const recover = (callback: (exact: boolean) => Promise<void> = async () => {}) => {
    const reader = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: async context => {
        await callback(context.requiresExactRecovery)
        return { messages: messages.slice(0, 1), complete: false, boundedByHistory: true }
      }
    })
    savers.push(reader)
    return reader
  }
  return { root, actual, path, make, held, observe, config, recover }
}

describe("public pending-write intent before database admission", () => {
  it("makes a warm write queued behind exclusive admission visible to held recovery", async () => {
    const f = await fixture(), entered = f.held(), releaseRecovery = f.held(), releaseGate = f.held()
    const reader = f.recover(async () => { entered.resolve(); await releaseRecovery.promise })
    const writer = f.make()
    await writer.initialize()
    const recovery = f.observe(reader.getLatestTupleForDurableTailRecovery("thread"))
    await entered.promise
    const identity = await identities.resolveCheckpointDatabaseIdentity(f.path)
    const gateEntered = f.held()
    const maintenance = f.observe(runCheckpointDatabaseMaintenance(identity.key, async () => {
      gateEntered.resolve(); await releaseGate.promise
    }))
    let writeFinished = false
    const write = f.observe(writer.putWrites(f.config, [["messages", "late"]], "task"))
    void write.then(() => { writeFinished = true }, () => { writeFinished = true })
    releaseRecovery.resolve()
    await expect(recovery).rejects.toBeInstanceOf(CheckpointMessageSnapshotRecoveryError)
    await gateEntered.promise
    expect(writeFinished).toBe(false)
    releaseGate.resolve()
    await maintenance
    await write
  })

  it("keeps the intent visible while the real final file check is held", async () => {
    const f = await fixture(), entered = f.held(), releaseRecovery = f.held(), releaseStat = f.held()
    const reader = f.recover(async () => { entered.resolve(); await releaseRecovery.promise })
    const writer = f.make()
    await writer.initialize()
    const recovery = f.observe(reader.getLatestTupleForDurableTailRecovery("thread"))
    await entered.promise
    const original = identities.assertCheckpointDatabaseFileIdentity
    const statEntered = f.held()
    const stat = vi.spyOn(identities, "assertCheckpointDatabaseFileIdentity").mockImplementation(async (path, file) => {
      await original(path, file)
      statEntered.resolve()
      await releaseStat.promise
    })
    const write = f.observe(writer.putWrites(f.config, [["messages", "late"]], "task"))
    await statEntered.promise
    releaseRecovery.resolve()
    await expect(recovery).rejects.toBeInstanceOf(CheckpointMessageSnapshotRecoveryError)
    releaseStat.resolve()
    await write
    stat.mockRestore()
  })

  it.each(["gate", "stat"] as const)(
    "writes only the captured address when the caller replaces its config during %s admission", async phase => {
      const f = await fixture(), writer = f.make(), entered = f.held(), release = f.held()
      await writer.initialize()
      let maintenance: Promise<unknown> | undefined
      if (phase === "gate") {
        const identity = await identities.resolveCheckpointDatabaseIdentity(f.path)
        maintenance = f.observe(runCheckpointDatabaseMaintenance(identity.key, async () => {
          entered.resolve(); await release.promise
        }))
        await entered.promise
      } else {
        const original = identities.assertCheckpointDatabaseFileIdentity
        vi.spyOn(identities, "assertCheckpointDatabaseFileIdentity").mockImplementation(async (path, file) => {
          await original(path, file)
          entered.resolve()
          await release.promise
        })
      }
      const address = { thread_id: "thread", checkpoint_ns: "", checkpoint_id: "checkpoint" }
      const mutable: RunnableConfig = { configurable: address }
      const write = f.observe(writer.putWrites(mutable, [["messages", "captured write"]], "fixed-task"))
      if (phase === "stat") await entered.promise
      expect(hasIntent(writer)).toBe(true)
      address.thread_id = "changed-old-object"
      address.checkpoint_ns = "changed-old-namespace"
      address.checkpoint_id = "changed-old-checkpoint"
      mutable.configurable = { thread_id: "replacement-object", checkpoint_ns: "replacement-namespace",
        checkpoint_id: "replacement-checkpoint" }
      release.resolve()
      await maintenance
      await write
      expect(hasIntent(writer)).toBe(false)
      expect(hasIntent(writer, "changed-old-object", "changed-old-namespace")).toBe(false)
      expect(hasIntent(writer, "replacement-object", "replacement-namespace")).toBe(false)
      const database = new DatabaseSync(f.path, { readOnly: true })
      try {
        expect(database.prepare("SELECT thread_id,checkpoint_ns,checkpoint_id,task_id,channel FROM writes").all())
          .toEqual([{ thread_id: "thread", checkpoint_ns: "", checkpoint_id: "checkpoint",
            task_id: "fixed-task", channel: "messages" }])
      } finally { database.close() }
    }
  )

  it.each(["initialize", "stat", "serialize"] as const)(
    "releases its own count after a %s failure so a later bounded recovery can succeed", async phase => {
      const f = await fixture(), writer = f.make(), failure = Error(`FAILED_${phase}`)
      await writer.initialize()
      const serde = writer.serde
      if (phase === "initialize") vi.spyOn(writer, "initialize").mockRejectedValueOnce(failure)
      else if (phase === "stat") vi.spyOn(identities, "assertCheckpointDatabaseFileIdentity").mockRejectedValueOnce(failure)
      else writer.serde = { loadsTyped: serde.loadsTyped.bind(serde), dumpsTyped: async () => { throw failure } }
      await expect(f.observe(writer.putWrites(f.config, [["messages", "never committed"]], "task")))
        .rejects.toBe(failure)
      vi.restoreAllMocks()
      writer.serde = serde
      expect(hasIntent(writer)).toBe(false)
      let exact: boolean | undefined
      const reader = f.recover(async value => { exact = value })
      const tuple = await reader.getLatestTupleForDurableTailRecovery("thread")
      expect(exact).toBe(false)
      expect(tuple?.checkpoint.channel_values.messages).toHaveLength(1)
    }
  )

  it("moves a cold alias count to its actual physical domain without losing another writer", async () => {
    const f = await fixture(), alias = join(f.root, "alias")
    symlinkSync(f.actual, alias, process.platform === "win32" ? "junction" : "dir")
    const canonical = f.make(), aliasWriter = f.make(join(alias, "thread.sqlite"))
    const unresolvedAlias = f.make(join(alias, "thread.sqlite"))
    await canonical.initialize()
    const aliasEntered = f.held(), releaseAlias = f.held(), canonicalEntered = f.held(), releaseCanonical = f.held()
    const aliasSerde = aliasWriter.serde, canonicalSerde = canonical.serde, failure = Error("ALIAS_SERIALIZATION_FAILED")
    aliasWriter.serde = { loadsTyped: aliasSerde.loadsTyped.bind(aliasSerde), dumpsTyped: async () => {
      aliasEntered.resolve(); await releaseAlias.promise; throw failure
    } }
    canonical.serde = { loadsTyped: canonicalSerde.loadsTyped.bind(canonicalSerde), dumpsTyped: async value => {
      canonicalEntered.resolve(); await releaseCanonical.promise; return canonicalSerde.dumpsTyped(value)
    } }
    const first = f.observe(aliasWriter.putWrites(f.config, [["messages", "failed"]], "alias-task"))
    await aliasEntered.promise
    expect(hasIntent(unresolvedAlias)).toBe(false)
    expect(hasIntent(canonical)).toBe(true)
    const second = f.observe(canonical.putWrites(f.config, [["messages", "committed"]], "canonical-task"))
    releaseAlias.resolve()
    await expect(first).rejects.toBe(failure)
    await canonicalEntered.promise
    expect(hasIntent(canonical)).toBe(true)
    releaseCanonical.resolve()
    await second
    expect(hasIntent(canonical)).toBe(false)
    expect(hasIntent(unresolvedAlias)).toBe(false)
  })
})
