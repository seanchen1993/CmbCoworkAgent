import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import { SqlJsSaver, type SqlJsSaverCommittedCheckpointReceipt } from "./sqljs-saver"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

const metadata: CheckpointMetadata = { source: "loop", step: 1, parents: {} }
const config = (namespace = "", parent?: string): RunnableConfig => ({ configurable: {
  thread_id: "thread", checkpoint_ns: namespace, ...(parent ? { checkpoint_id: parent } : {})
} })

function checkpoint(index: number): Checkpoint {
  return {
    v: 1, id: randomUUID(), ts: new Date(1_700_000_000_000 + index).toISOString(),
    channel_values: {
      messages: [new HumanMessage({ id: `message-${index}`, content: `body-${index}` })],
      cmbFunctionConversation: { version: 1, logicalSessionId: "session", conversationId: "conversation",
        branchId: "branch", frontier: index }
    },
    channel_versions: { messages: index + 1, cmbFunctionConversation: index + 1 },
    versions_seen: {}
  }
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-checkpoint-commit-observer-"))
  const path = join(directory, "checkpoint.sqlite")
  const first = new SqlJsSaver(path)
  // A second native Saver using a path alias must participate in the same existing gate.
  const second = new SqlJsSaver(relative(process.cwd(), path))
  const readers: Array<ReturnType<typeof openNativeSqliteDatabase>["database"]> = []
  cleanups.push(async () => {
    for (const reader of readers) reader.close()
    await first.close()
    await second.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await first.initialize()
  await second.initialize()
  const reader = openNativeSqliteDatabase(path).database
  readers.push(reader)
  const ids = (namespace = "") => reader.exec(
    "SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_ts",
    ["thread", namespace]
  )[0]?.values.map((row) => row[0]) ?? []
  return { first, second, reader, ids }
}

describe("SqlJsSaver native same-gate commit observer", () => {
  it("does not let a captured exact-read lifetime borrow a closed and reopened database", async () => {
    const f = await fixture(), a = checkpoint(1)
    const exact = await f.first.put(config(), a, metadata)
    expect((await f.first.getTuple(exact))?.checkpoint.id).toBe(a.id)
    const lifetime = f.first.captureReadLifetime()
    expect(() => lifetime()).not.toThrow()
    await f.first.close()
    expect(() => lifetime()).toThrow("SQLJS_SAVER_READ_LIFETIME_EXPIRED")
    await f.first.initialize()
    expect(() => lifetime()).toThrow("SQLJS_SAVER_READ_LIFETIME_EXPIRED")
    expect((await f.first.getTuple(exact))?.checkpoint.id).toBe(a.id)
    expect(() => f.first.captureReadLifetime()()).not.toThrow()
  })

  it.each(["same saver", "second saver"])(
    "holds %s writers until the actual observer finally, with native default-one pruning",
    async (kind) => {
      const f = await fixture(), a = checkpoint(1), b = checkpoint(2)
      const entered = deferred<SqlJsSaverCommittedCheckpointReceipt>()
      const release = deferred<void>()
      const first = f.first.putWithCommitObserver(config(), a, metadata, async (receipt) => {
        entered.resolve(receipt)
        await release.promise
        expect(f.first.readCommittedCheckpoint(receipt).checkpoint.id).toBe(a.id)
      })
      const receipt = await entered.promise
      const writer = kind === "same saver" ? f.first : f.second
      let laterEntered = false
      const later = writer.putWithCommitObserver(config("", a.id), b, metadata, () => {
        laterEntered = true
      })
      try {
        expect(f.ids()).toEqual([a.id]) // A is committed on a third actual connection.
        expect(laterEntered).toBe(false)
        const actual = f.first.readCommittedCheckpoint(receipt)
        expect(actual.checkpoint.channel_values.messages).toHaveLength(1)
        expect((actual.checkpoint.channel_values.messages as HumanMessage[])[0].content).toBe("body-1")
        expect(f.first.readCommittedCheckpoint(receipt)).toBe(actual)
        expect(f.ids()).toEqual([a.id])
      } finally { release.resolve() }
      await first
      await later
      expect(laterEntered).toBe(true)
      expect(f.ids()).toEqual([b.id])
      expect(await f.first.getTuple({ configurable: { ...config().configurable, checkpoint_id: a.id } }))
        .toBeUndefined()
      expect(() => f.first.readCommittedCheckpoint(receipt)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
    }
  )

  it("does not block a different namespace while the original observer is held", async () => {
    const f = await fixture(), a = checkpoint(1), b = checkpoint(2)
    const entered = deferred<SqlJsSaverCommittedCheckpointReceipt>(), release = deferred<void>()
    const first = f.first.putWithCommitObserver(config(), a, metadata, async (receipt) => {
      entered.resolve(receipt)
      await release.promise
    })
    const receipt = await entered.promise
    try {
      await f.second.putWithCommitObserver(config("child:actual"), b, metadata, (other) => {
        expect(f.second.readCommittedCheckpoint(other).config.configurable?.checkpoint_ns).toBe("child:actual")
      })
      expect(f.ids()).toEqual([a.id])
      expect(f.ids("child:actual")).toEqual([b.id])
      expect(f.first.readCommittedCheckpoint(receipt).checkpoint.id).toBe(a.id)
    } finally { release.resolve() }
    await first
  })

  it("rejects copied, forged and cross-saver receipts without confusing visible shape with authority", async () => {
    const f = await fixture(), a = checkpoint(1)
    let saved: SqlJsSaverCommittedCheckpointReceipt | undefined
    await f.first.putWithCommitObserver(config(), a, metadata, (receipt) => {
      saved = receipt
      expect(() => f.first.readCommittedCheckpoint({} as SqlJsSaverCommittedCheckpointReceipt))
        .toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
      expect(() => f.first.readCommittedCheckpoint({ ...receipt }))
        .toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
      expect(() => f.second.readCommittedCheckpoint(receipt))
        .toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
      expect(f.first.readCommittedCheckpoint(receipt).checkpoint.id).toBe(a.id)
    })
    expect(saved).toBeDefined()
    expect(() => f.first.readCommittedCheckpoint(saved!)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
    await f.first.putWithCommitObserver(config(), checkpoint(2), metadata, () => {
      expect(() => f.first.readCommittedCheckpoint(saved!)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
    })
  })

  it("preserves an actual COMMIT on observer failure and releases the gate without replay", async () => {
    const f = await fixture(), a = checkpoint(1), failure = Error("observer failed after COMMIT")
    let calls = 0
    let saved: SqlJsSaverCommittedCheckpointReceipt | undefined
    await expect(f.first.putWithCommitObserver(config(), a, metadata, (receipt) => {
      calls += 1
      saved = receipt
      expect(f.ids()).toEqual([a.id])
      throw failure
    })).rejects.toBe(failure)
    expect(calls).toBe(1)
    expect(f.ids()).toEqual([a.id])
    expect(() => f.first.readCommittedCheckpoint(saved!)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
    const b = checkpoint(2)
    await f.second.put(config("", a.id), b, metadata)
    expect(f.ids()).toEqual([b.id])
  })

  it("keeps the namespace occupied through real observer finally after its source is canceled", async () => {
    const f = await fixture(), a = checkpoint(1), b = checkpoint(2)
    const entered = deferred<SqlJsSaverCommittedCheckpointReceipt>(), release = deferred<void>()
    const controller = new AbortController(), reason = Error("original source canceled")
    const first = f.first.putWithCommitObserver(config(), a, metadata, async (receipt) => {
      entered.resolve(receipt)
      await release.promise
      controller.signal.throwIfAborted()
    })
    const outcome = first.then(() => undefined, (error: unknown) => error)
    const receipt = await entered.promise
    controller.abort(reason)
    const later = f.second.put(config("", a.id), b, metadata)
    try {
      expect(f.ids()).toEqual([a.id])
      expect(f.first.readCommittedCheckpoint(receipt).checkpoint.id).toBe(a.id)
    } finally { release.resolve() }
    expect(await outcome).toBe(reason)
    await later
    expect(f.ids()).toEqual([b.id])
    expect(() => f.first.readCommittedCheckpoint(receipt)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
  })

  it.each(["close and reopen", "retire"])("does not revive old receipts after %s", async (kind) => {
    const f = await fixture(), a = checkpoint(1)
    const entered = deferred<SqlJsSaverCommittedCheckpointReceipt>(), release = deferred<void>()
    const first = f.first.putWithCommitObserver(config(), a, metadata, async (receipt) => {
      entered.resolve(receipt)
      await release.promise
    })
    const outcome = first.then(() => undefined, (error: unknown) => error)
    const receipt = await entered.promise
    try {
      if (kind === "retire") await f.first.retire()
      else {
        await f.first.close()
        await f.first.initialize()
      }
      expect(() => f.first.readCommittedCheckpoint(receipt)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED")
      expect(f.ids()).toEqual([a.id])
    } finally { release.resolve() }
    expect(await outcome).toMatchObject({ message: "SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED" })
    expect(() => f.first.readCommittedCheckpoint(receipt)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
    if (kind === "retire") await expect(f.first.put(config(), checkpoint(2), metadata)).rejects.toThrow("retired")
    else await f.first.putWithCommitObserver(config(), checkpoint(2), metadata, (newReceipt) => {
      expect(() => f.first.readCommittedCheckpoint(receipt)).toThrow("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
      expect(f.first.readCommittedCheckpoint(newReceipt).checkpoint.id).not.toBe(a.id)
    })
  })

  it("pins queued config, checkpoint identity, native messages and conversation state before awaiting its gate", async () => {
    const f = await fixture(), a = checkpoint(1), b = checkpoint(2)
    const entered = deferred<void>(), release = deferred<void>()
    const first = f.first.putWithCommitObserver(config(), a, metadata, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const input = config("", a.id), originalId = b.id
    const originalMessage = (b.channel_values.messages as HumanMessage[])[0]
    const originalMessages = b.channel_values.messages as HumanMessage[]
    const state = b.channel_values.cmbFunctionConversation as { frontier: number }
    const later = f.second.putWithCommitObserver(input, b, metadata, (receipt) => {
      const tuple = f.second.readCommittedCheckpoint(receipt)
      expect(tuple.config.configurable).toEqual({ thread_id: "thread", checkpoint_ns: "", checkpoint_id: originalId })
      expect(tuple.parentConfig?.configurable?.checkpoint_id).toBe(a.id)
      expect(tuple.checkpoint.channel_values.cmbFunctionConversation).toMatchObject({ frontier: 2 })
      const messages = tuple.checkpoint.channel_values.messages as HumanMessage[]
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toBe(originalMessage.content)
      expect(messages[0].getType()).toBe("human")
    })
    try {
      input.configurable = { thread_id: "foreign", checkpoint_ns: "wrong", checkpoint_id: "wrong-parent" }
      b.id = randomUUID()
      state.frontier = 999
      originalMessages.push(new HumanMessage("late replacement"))
      expect(f.ids()).toEqual([a.id])
    } finally { release.resolve() }
    await first
    await later
    expect(f.ids()).toEqual([originalId])
    expect(f.reader.exec("SELECT COUNT(*) FROM checkpoints WHERE thread_id = 'foreign'")[0].values)
      .toEqual([[0]])
  })

  it("does not deliver a receipt when precise native read fails after the actual COMMIT", async () => {
    const f = await fixture(), a = checkpoint(1), failure = Error("controlled native decode failure")
    let observerCalls = 0
    const reads = vi.spyOn(f.first.serde, "loadsTyped").mockRejectedValueOnce(failure)
    await expect(f.first.putWithCommitObserver(config(), a, metadata, () => {
      observerCalls += 1
    })).rejects.toBe(failure)
    expect(observerCalls).toBe(0)
    expect(f.ids()).toEqual([a.id])
    reads.mockRestore()
    expect((await f.first.getTuple({ configurable: { ...config().configurable, checkpoint_id: a.id } }))
      ?.checkpoint.id).toBe(a.id)
    await f.second.put(config(), checkpoint(2), metadata)
  })

  it("does not enter an observer when a retired Saver cannot commit", async () => {
    const f = await fixture()
    await f.first.retire()
    let observerCalls = 0
    await expect(f.first.putWithCommitObserver(config(), checkpoint(1), metadata, () => {
      observerCalls += 1
    })).rejects.toThrow("SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED")
    expect(observerCalls).toBe(0)
    expect(f.ids()).toEqual([])
  })

  it("keeps ordinary three-argument put free of observer reads and preserves native pending writes", async () => {
    const f = await fixture(), a = checkpoint(1)
    const loads = vi.spyOn(f.first.serde, "loadsTyped")
    const observed = vi.spyOn(f.first, "putWithCommitObserver")
    const result = await f.first.put(config(), a, metadata)
    expect(loads).not.toHaveBeenCalled()
    expect(observed).not.toHaveBeenCalled()
    await f.first.putWrites(result, [["actual-channel", { retained: true }]], "actual-task")
    const actual = await f.first.getTuple(result)
    expect(actual?.metadata).toEqual(metadata)
    expect(actual?.pendingWrites).toEqual([["actual-task", "actual-channel", { retained: true }]])
    expect((actual?.checkpoint.channel_values.messages as HumanMessage[])[0].content).toBe("body-1")
  })
})
