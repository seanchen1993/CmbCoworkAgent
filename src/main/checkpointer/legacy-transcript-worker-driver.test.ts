import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it, vi } from "vitest"
import { SqlJsSaver } from "./sqljs-saver"
import { LegacyTranscriptWorkerDriver } from "./legacy-transcript-worker-driver"
import {
  LEGACY_TRANSCRIPT_WRITE_PROTOCOL,
  type LegacyTranscriptMarker,
  type LegacyTranscriptWriteMessage,
  type LegacyTranscriptWriteError,
  type LegacyTranscriptWriteResult
} from "./legacy-transcript-write-protocol"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(contents = ["original one", "original two"]) {
  const root = mkdtempSync(join(tmpdir(), "legacy-driver-"))
  const databasePath = join(root, "checkpoint.sqlite")
  const saver = new SqlJsSaver(databasePath)
  cleanup.push(async () => {
    await saver.close()
    rmSync(root, { recursive: true, force: true })
  })
  await saver.put(
    { configurable: { thread_id: "original", checkpoint_ns: "" } },
    {
      id: "original-point",
      ts: "2026-11-09T00:00:00.000Z",
      v: 1,
      channel_values: {
        messages: contents.map((content, index) => ({ type: "ai", id: `m${index}`, content })),
        todos: [{ id: "original-todo", content: "keep runtime", status: "pending" }]
      },
      channel_versions: {},
      versions_seen: {}
    } as Checkpoint,
    { source: "loop", step: 0, writes: {}, parents: {} } as CheckpointMetadata
  )
  await saver.close()
  return databasePath
}
function request(databasePath: string, id = 1) {
  return {
    requestId: id,
    databasePath,
    threadId: "original",
    checkpointNs: "",
    cancellationBuffer: new SharedArrayBuffer(4),
    legacyWriter: {
      protocol: LEGACY_TRANSCRIPT_WRITE_PROTOCOL,
      nonce: `actual-${id}`,
      workerGeneration: 1,
      requestId: id
    }
  }
}
function harness(
  options: {
    hold?: boolean
    rejectKind?: string
    rejectCode?: LegacyTranscriptWriteError
    timing?: string
    duplicateFragment?: boolean
  } = {}
) {
  const wires: LegacyTranscriptWriteMessage[] = []
  let state: LegacyTranscriptMarker | null = null
  const answer = (wire: LegacyTranscriptWriteMessage) => {
    const command = wire.command
    if (command.kind === options.rejectKind)
      return driver.acceptAcknowledgement({
        ...wire,
        type: "legacy-transcript-write-ack",
        ok: false,
        error: { code: options.rejectCode ?? "LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED" }
      })
    let result: LegacyTranscriptWriteResult
    if (command.kind === "read-state") result = { marker: state, ordinary: true }
    else if (command.kind === "reserve") {
      state ??= {
        checkpointId: command.checkpointId,
        totalMessages: command.totalMessages,
        nextIndex: 0,
        fragmentIndex: 0,
        status: "migrating"
      }
      result = { marker: { ...state }, inserted: 0 }
    } else if (command.kind === "copy") {
      if (!state) throw Error("FIXTURE_STATE_MISSING")
      const inserted =
        command.mode === "rows"
          ? command.rows.length
          : options.duplicateFragment
            ? 0
            : command.fragmentIndex === 0
              ? 1
              : 0
      state = {
        ...state,
        nextIndex:
          command.mode === "rows"
            ? command.index + command.rows.length
            : command.complete || options.duplicateFragment
              ? command.index + 1
              : command.index,
        fragmentIndex:
          command.mode === "rows" || command.complete || options.duplicateFragment
            ? 0
            : command.nextFragmentIndex
      }
      result = {
        marker: state,
        inserted,
        ...(command.mode === "fragments" ? { fragmentOwned: !options.duplicateFragment } : {})
      }
    } else if (command.kind === "finish") {
      if (!state) throw Error("FIXTURE_STATE_MISSING")
      state = { ...state, status: "complete" }
      result = { marker: state, inserted: 0 }
    } else if (command.kind === "timing-source")
      result = {
        timing: options.timing ? { timingToken: "original-times", source: options.timing } : null
      }
    else result = { nextIndex: command.index + command.entries.length, complete: command.complete }
    return driver.acceptAcknowledgement({
      ...wire,
      type: "legacy-transcript-write-ack",
      ok: true,
      result
    })
  }
  const driver = new LegacyTranscriptWorkerDriver((wire) => {
    wires.push(wire)
    if (!options.hold) queueMicrotask(() => answer(wire))
  })
  cleanup.push(async () => {
    const closing = driver.shutdown()
    for (const wire of wires)
      driver.acceptAcknowledgement({
        ...wire,
        type: "legacy-transcript-write-ack",
        ok: false,
        error: { code: "LEGACY_TRANSCRIPT_WRITE_CANCELLED" }
      })
    await closing
  })
  return { driver, wires, answer }
}

it("prepares one real source and preserves all original ordered rows within the old batch budget", async () => {
  const databasePath = await fixture(Array.from({ length: 140 }, (_, index) => `original ${index}`))
  const h = harness()
  const result = await h.driver.enqueue(request(databasePath))
  expect(result.stats).toMatchObject({
    checkpointId: "original-point",
    totalMessages: 140,
    migratedMessages: 140,
    batches: 3
  })
  const copies = h.wires.map((wire) => wire.command).filter((command) => command.kind === "copy")
  expect(copies.map((command) => (command.mode === "rows" ? command.rows.length : -1))).toEqual([
    64, 64, 12
  ])
  expect(
    copies.flatMap((command) =>
      command.mode === "rows" ? command.rows.map((row) => row.messageId) : []
    )
  ).toEqual(Array.from({ length: 140 }, (_, index) => `m${index}`))
  expect(result.runtimeTuple).toMatchObject({ checkpoint: { channel_values: { messages: [] } } })
})

it("snapshots the original target before the first ACK and ignores foreign/late ACK identities", async () => {
  const original = await fixture(),
    h = harness({ hold: true }),
    input = request(original)
  const result = h.driver.enqueue(input)
  // Cleanup may cancel this held request even when an earlier assertion fails.
  void Promise.allSettled([result])
  expect(h.wires).toHaveLength(1)
  const first = h.wires[0]
  input.databasePath = "must-not-open.sqlite"
  input.threadId = "replacement"
  input.legacyWriter.nonce = "replacement-nonce"
  let settled = false
  void result.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  expect(
    h.driver.acceptAcknowledgement({
      ...first,
      type: "legacy-transcript-write-ack",
      nonce: "wrong",
      ok: true,
      result: { marker: null, ordinary: true }
    })
  ).toBe(false)
  await Promise.resolve()
  expect(settled).toBe(false)
  h.answer(first)
  for (let index = 1; !settled; index++) {
    await vi.waitFor(() => expect(h.wires.length).toBeGreaterThan(index))
    h.answer(h.wires[index])
    if (h.wires[index].command.kind === "timing-source") break
  }
  expect((await result).stats.migratedMessages).toBe(2)
  expect(
    h.driver.acceptAcknowledgement({
      ...first,
      type: "legacy-transcript-write-ack",
      ok: true,
      result: { marker: null, ordinary: true }
    })
  ).toBe(false)
})

it("keeps queued requests before full preparation and shutdown waits for the active original ACK", async () => {
  const databasePath = await fixture(),
    h = harness({ hold: true })
  const first = h.driver.enqueue(request(databasePath, 1))
  const second = h.driver.enqueue(request("queued-source-must-not-open.sqlite", 2))
  const settled = Promise.allSettled([first, second])
  expect(h.wires).toHaveLength(1)
  let drained = false
  const closing = h.driver.shutdown().then(() => {
    drained = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(drained).toBe(false)
  expect(h.wires).toHaveLength(1)
  h.answer(h.wires[0])
  expect(await settled).toEqual([
    expect.objectContaining({
      status: "rejected",
      reason: expect.objectContaining({
        name: "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED"
      })
    }),
    expect.objectContaining({
      status: "rejected",
      reason: expect.objectContaining({
        name: "CHECKPOINT_RUNTIME_PROJECTION_CANCELLED"
      })
    })
  ])
  await closing
  expect(h.wires).toHaveLength(1)
})

it("preserves duplicate-live fragment ownership instead of attaching the old remaining fragments", async () => {
  const databasePath = await fixture(["x".repeat(1_100_000)])
  const h = harness({ duplicateFragment: true })
  const result = await h.driver.enqueue(request(databasePath))
  const copies = h.wires.map((wire) => wire.command).filter((command) => command.kind === "copy")
  expect(copies).toHaveLength(1)
  expect(copies[0]).toMatchObject({ mode: "fragments", complete: false })
  expect(result.stats).toMatchObject({ totalMessages: 1, migratedMessages: 0 })
})

it.each(["timing-source", "timing-page"])(
  "keeps an exact complete transcript readable when native enrollment refuses only %s",
  async (rejectKind) => {
    const databasePath = await fixture()
    const h = harness({
      rejectKind,
      rejectCode: "MODS_CONVERSATION_MIGRATION_REQUIRED",
      timing: JSON.stringify([{ m0: { start_at: 10, end_at: 20 } }, [], null, null])
    })
    expect((await h.driver.enqueue(request(databasePath))).stats.migratedMessages).toBe(2)
  }
)

it.each([
  ["copy", "MODS_CONVERSATION_MIGRATION_REQUIRED"],
  ["timing-source", "LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED"],
  ["timing-source", "LEGACY_TRANSCRIPT_WRITE_FAILED"]
] as const)("preserves the failure of %s / %s", async (rejectKind, rejectCode) => {
  const databasePath = await fixture(),
    h = harness({ rejectKind, rejectCode })
  await expect(h.driver.enqueue(request(databasePath))).rejects.toThrow(rejectCode)
})

it("sends every timing cursor entry, including unmatched messages with null timestamps", async () => {
  const databasePath = await fixture(),
    h = harness({
      timing: JSON.stringify([{ m0: { start_at: 10, end_at: 20 } }, [], null, null])
    })
  await h.driver.enqueue(request(databasePath))
  const page = h.wires.map((wire) => wire.command).find((command) => command.kind === "timing-page")
  expect(page).toMatchObject({
    index: 0,
    complete: true,
    entries: [
      { messageId: "m0", startAt: 10, endAt: 20 },
      { messageId: "m1", startAt: null, endAt: null }
    ]
  })
})
