/**
 * adoption-index `harness_node_name` column round-trip.
 *
 * Locks down the stage (workflow node) attribution column added to gen_events:
 * a row inserted with harness_node_name must come back with it via both
 * getGenRowByEventId and findPendingGensForFile, and null must round-trip for
 * non-project rows.
 *
 * storage.getOpenworkDir is mocked to a throwaway temp dir so the test never
 * touches the real ~/.cmbcoworkagent/adoption-index.sqlite.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("os")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("path")
  return { tempDir: mkdtempSync(join(tmpdir(), "adoption-index-test-")) as string }
})

vi.mock("../storage", () => ({ getOpenworkDir: () => h.tempDir }))

import {
  closeAdoptionIndex,
  enqueueEventOutbox,
  finalizeGenMeasurement,
  findPendingGensForFile,
  flushAdoptionIndex,
  getAdoptLineDetails,
  getGenRowByEventId,
  getOutboxEvent,
  initializeAdoptionIndex,
  insertGenEvent,
  insertGenEventWithOutbox,
  markOutboxDeferred,
  markOutboxDelivered,
  markOutboxFailed,
  markOutboxSending,
  resetInterruptedOutboxEvents,
  setAdoptionIndexSnapshotFsyncForTest,
  setAdoptionIndexSnapshotReplaceForTest,
  trimGeneratedSourceTextToByteCap,
  type GenIndexRow
} from "./adoption-index"

function makeRow(overrides: Partial<GenIndexRow> = {}): GenIndexRow {
  return {
    event_id: "g_test",
    file_path: "/repo/src/foo.ts",
    tool: "write_file",
    content_fingerprint: "abcd1234",
    shard_file: "/shards/current.jsonl",
    shard_offset: 0,
    line_hashes: new Uint8Array([1, 2, 3, 4]),
    old_line_hashes: null,
    generated_lines_blob: null,
    created_at: Date.now(),
    measured: 0,
    used_skills: null,
    skill_source: null,
    thread_id: "thread-1",
    trace_id: "trace-1",
    model_id: "m1",
    model_name: "Model One",
    harness_project_id: "proj-1",
    harness_feature_slug: "feature-x",
    harness_node_name: "Dev-代码实现",
    harness_node_status: "进行中",
    harness_adapter_name: "claude-code",
    harness_adapter_version: "1.0.0",
    observability_schema_version: 1,
    trace_kind: "root",
    execution_mode: "normal",
    root_trace_id: "trace-1",
    root_thread_id: "thread-1",
    parent_trace_id: null,
    parent_thread_id: null,
    parent_span_id: null,
    link_type: null,
    subagent_kind: null,
    subagent_run_id: null,
    subagent_thread_id: null,
    handoff_action: null,
    handoff_source_agent: null,
    handoff_target_agent: null,
    coordinator_worker_id: null,
    coordinator_worker_turn: null,
    coordinator_worker_role: null,
    coordinator_worker_workload: null,
    workflow_run_id: null,
    workflow_agent_index: null,
    workflow_phase: null,
    workflow_agent_label: null,
    new_ratio: null,
    change_kind: null,
    ...overrides
  }
}

describe("adoption-index unavailable state", () => {
  it("reports insertion failure before initialization", () => {
    expect(insertGenEvent(makeRow({ event_id: "g_unavailable" }))).toBe(false)
  })
})

describe("adoption-index harness_node_name column", () => {
  beforeAll(async () => {
    await initializeAdoptionIndex()
  })

  afterAll(() => {
    closeAdoptionIndex()
    try {
      rmSync(h.tempDir, { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  })

  it("round-trips harness_node_name via getGenRowByEventId", () => {
    expect(insertGenEvent(makeRow({ event_id: "g_node_1" }))).toBe(true)
    const fetched = getGenRowByEventId("g_node_1")
    expect(fetched).not.toBeNull()
    expect(fetched?.harness_node_name).toBe("Dev-代码实现")
    expect(fetched?.harness_node_status).toBe("进行中")
    // Existing sibling column must remain intact alongside the new one.
    expect(fetched?.harness_feature_slug).toBe("feature-x")
  })

  it("round-trips new_ratio / change_kind via getGenRowByEventId", () => {
    expect(
      insertGenEvent(makeRow({ event_id: "g_kind_1", new_ratio: 0.25, change_kind: "legacy" }))
    ).toBe(true)
    const fetched = getGenRowByEventId("g_kind_1")
    expect(fetched?.new_ratio).toBeCloseTo(0.25)
    expect(fetched?.change_kind).toBe("legacy")
  })

  it("keeps new_ratio / change_kind null for rows that never set them", () => {
    expect(insertGenEvent(makeRow({ event_id: "g_kind_2" }))).toBe(true)
    const fetched = getGenRowByEventId("g_kind_2")
    expect(fetched?.new_ratio ?? null).toBeNull()
    expect(fetched?.change_kind ?? null).toBeNull()
  })

  it("surfaces new_ratio / change_kind through findPendingGensForFile", () => {
    expect(
      insertGenEvent(
        makeRow({
          event_id: "g_kind_3",
          file_path: "/repo/src/kind.ts",
          new_ratio: 1,
          change_kind: "new"
        })
      )
    ).toBe(true)
    const pending = findPendingGensForFile("/repo/src/kind.ts", 0)
    expect(pending).toHaveLength(1)
    expect(pending[0].new_ratio).toBe(1)
    expect(pending[0].change_kind).toBe("new")
  })

  it("reports insertion failure when sqlite rejects the row", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(
        insertGenEvent(
          makeRow({
            event_id: "g_rejected",
            file_path: null as unknown as string
          })
        )
      ).toBe(false)
    } finally {
      warn.mockRestore()
    }
    expect(getGenRowByEventId("g_rejected")).toBeNull()
  })

  it("rolls back the generation when its outbox envelope conflicts", () => {
    const eventId = "code-gen-envelope-conflict"
    const originalPayload = JSON.stringify({ eventId, eventName: "code_gen", version: 1 })
    expect(
      enqueueEventOutbox({
        eventId,
        eventName: "code_gen",
        payloadJson: originalPayload,
        createdAt: 1
      })
    ).toBe(true)

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(
        insertGenEventWithOutbox(makeRow({ event_id: "g_atomic_conflict" }), {
          eventId,
          eventName: "code_gen",
          payloadJson: JSON.stringify({ eventId, eventName: "code_gen", version: 2 }),
          createdAt: 2
        })
      ).toBe(false)
    } finally {
      warn.mockRestore()
    }

    expect(getGenRowByEventId("g_atomic_conflict")).toBeNull()
    expect(getOutboxEvent(eventId)?.payload_json).toBe(originalPayload)
  })

  it("counts only completed reporter attempts across claim, deferral, and restart", async () => {
    const eventId = "outbox-attempt-state-machine"
    expect(
      enqueueEventOutbox({
        eventId,
        eventName: "code_adopt",
        payloadJson: JSON.stringify({ eventId, eventName: "code_adopt" }),
        createdAt: Date.now()
      })
    ).toBe(true)

    expect(markOutboxSending(eventId)).toBe(true)
    expect(getOutboxEvent(eventId)).toMatchObject({ status: "sending", attempts: 0 })
    expect(flushAdoptionIndex()).toBe(true)
    closeAdoptionIndex()
    await initializeAdoptionIndex()

    expect(getOutboxEvent(eventId)).toMatchObject({ status: "sending", attempts: 0 })
    resetInterruptedOutboxEvents(Date.now())
    expect(getOutboxEvent(eventId)).toMatchObject({ status: "retry", attempts: 0 })

    expect(markOutboxSending(eventId)).toBe(true)
    expect(markOutboxDeferred(eventId, "admission deferred", Date.now() + 60_000)).toBe(true)
    expect(getOutboxEvent(eventId)).toMatchObject({ status: "retry", attempts: 0 })

    expect(markOutboxSending(eventId)).toBe(true)
    expect(
      markOutboxFailed(eventId, "network failure", Date.now() + 60_000, false, {
        consumeAttempt: true,
        requireSending: true
      })
    ).toBe(true)
    expect(getOutboxEvent(eventId)).toMatchObject({ status: "retry", attempts: 1 })

    expect(markOutboxSending(eventId)).toBe(true)
    expect(markOutboxDelivered(eventId)).toBe(true)
    expect(getOutboxEvent(eventId)).toMatchObject({ status: "delivered", attempts: 2 })
    expect(flushAdoptionIndex()).toBe(true)
    closeAdoptionIndex()
    await initializeAdoptionIndex()
    expect(getOutboxEvent(eventId)).toMatchObject({ status: "delivered", attempts: 2 })
  })

  it("returns harness_node_name from findPendingGensForFile", () => {
    insertGenEvent(
      makeRow({
        event_id: "g_node_2",
        file_path: "/repo/src/bar.ts",
        harness_node_name: "Dev-单元测试"
      })
    )
    const pending = findPendingGensForFile("/repo/src/bar.ts", 0)
    expect(pending.length).toBeGreaterThan(0)
    expect(pending[0].harness_node_name).toBe("Dev-单元测试")
  })

  it("stores null harness_node_name for non-project rows", () => {
    insertGenEvent(
      makeRow({
        event_id: "g_node_3",
        file_path: "/repo/src/baz.ts",
        harness_project_id: null,
        harness_feature_slug: null,
        harness_node_name: null
      })
    )
    const fetched = getGenRowByEventId("g_node_3")
    expect(fetched).not.toBeNull()
    expect(fetched?.harness_node_name ?? null).toBeNull()
  })

  it("atomically stores line details, marks measured, and clears temporary source", () => {
    const details = new Uint8Array([10, 20, 30])
    insertGenEvent(
      makeRow({
        event_id: "g_detail",
        file_path: "/repo/src/detail.ts",
        generated_lines_blob: new Uint8Array([1, 2, 3])
      })
    )
    expect(
      finalizeGenMeasurement("g_detail", {
        commit_sha: "abc123",
        file_path: "/repo/src/detail.ts",
        rel_path: "src/detail.ts",
        details_blob: details,
        measured_at: 123456
      })
    ).toBe(true)

    const fetched = getAdoptLineDetails("abc123", "g_detail")
    expect(fetched).not.toBeNull()
    expect(fetched?.rel_path).toBe("src/detail.ts")
    expect(Array.from(fetched?.details_blob ?? [])).toEqual([10, 20, 30])
    expect(getGenRowByEventId("g_detail")?.measured).toBe(1)
    expect(getGenRowByEventId("g_detail")?.generated_lines_blob ?? null).toBeNull()
  })

  it("drops oldest pending source payloads without deleting attribution rows", () => {
    insertGenEvent(
      makeRow({
        event_id: "g_source_old",
        created_at: 10,
        generated_lines_blob: new Uint8Array([1, 2, 3, 4])
      })
    )
    insertGenEvent(
      makeRow({
        event_id: "g_source_new",
        created_at: 20,
        generated_lines_blob: new Uint8Array([5, 6, 7, 8])
      })
    )

    trimGeneratedSourceTextToByteCap(4)

    expect(getGenRowByEventId("g_source_old")).not.toBeNull()
    expect(getGenRowByEventId("g_source_old")?.generated_lines_blob ?? null).toBeNull()
    expect(Array.from(getGenRowByEventId("g_source_new")?.generated_lines_blob ?? [])).toEqual([
      5, 6, 7, 8
    ])
  })

  it("bounds completed details by compressed bytes and row count", () => {
    for (const [index, measuredAt] of [10, 20, 30].entries()) {
      const eventId = `g_cap_${index}`
      insertGenEvent(makeRow({ event_id: eventId, created_at: measuredAt }))
      expect(
        finalizeGenMeasurement(
          eventId,
          {
            commit_sha: `cap-${index}`,
            file_path: `/repo/src/cap-${index}.ts`,
            rel_path: `src/cap-${index}.ts`,
            details_blob: new Uint8Array([index, index, index, index]),
            measured_at: measuredAt
          },
          { maxRows: 100, maxBytes: 8 }
        )
      ).toBe(true)
    }

    expect(getAdoptLineDetails("cap-0", "g_cap_0")).toBeNull()
    expect(getAdoptLineDetails("cap-1", "g_cap_1")).toBeNull()
    expect(getAdoptLineDetails("cap-2", "g_cap_2")).not.toBeNull()

    for (const [suffix, measuredAt] of [
      ["newer-1", 200000],
      ["newer-2", 300000]
    ] as const) {
      const eventId = `g_${suffix}`
      insertGenEvent(makeRow({ event_id: eventId, created_at: measuredAt }))
      expect(
        finalizeGenMeasurement(
          eventId,
          {
            commit_sha: suffix,
            file_path: `/repo/src/${suffix}.ts`,
            rel_path: `src/${suffix}.ts`,
            details_blob: new Uint8Array([1]),
            measured_at: measuredAt
          },
          suffix === "newer-2" ? { maxRows: 2, maxBytes: 100 } : undefined
        )
      ).toBe(true)
    }
    expect(getAdoptLineDetails("cap-2", "g_cap_2")).toBeNull()
    expect(getAdoptLineDetails("newer-1", "g_newer-1")).not.toBeNull()
    expect(getAdoptLineDetails("newer-2", "g_newer-2")).not.toBeNull()
  })
})

describe.sequential("adoption-index atomic snapshot persistence", () => {
  const primaryPath = join(h.tempDir, "adoption-index.sqlite")
  const primaryTempPath = `${primaryPath}.tmp`

  beforeEach(() => {
    setAdoptionIndexSnapshotFsyncForTest(null)
    setAdoptionIndexSnapshotReplaceForTest(null)
    closeAdoptionIndex()
    rmSync(h.tempDir, { recursive: true, force: true })
    mkdirSync(h.tempDir, { recursive: true })
  })

  afterEach(() => {
    setAdoptionIndexSnapshotFsyncForTest(null)
    setAdoptionIndexSnapshotReplaceForTest(null)
    closeAdoptionIndex()
  })

  afterAll(() => {
    rmSync(h.tempDir, { recursive: true, force: true })
  })

  it("atomically creates a durable primary without leftover temp files", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(insertGenEvent(makeRow({ event_id: "g_snapshot_first" }))).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)
    expect(existsSync(primaryPath)).toBe(true)
    expect(readFileSync(primaryPath).subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0")
    expect(existsSync(primaryTempPath)).toBe(false)
  })

  it("defers fsync for debounced saves until an explicit flush", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)

    vi.useFakeTimers()
    let fsyncCalls = 0
    setAdoptionIndexSnapshotFsyncForTest(() => {
      fsyncCalls += 1
    })
    try {
      expect(insertGenEvent(makeRow({ event_id: "g_debounced_no_fsync" }))).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      expect(existsSync(primaryPath)).toBe(true)
      expect(fsyncCalls).toBe(0)

      expect(flushAdoptionIndex()).toBe(true)
      expect(fsyncCalls).toBeGreaterThan(0)

      // Exercise the real Node fsync path as well as the probe above. On
      // Windows, fsyncSync rejects a read-only descriptor with EPERM; the
      // production flush must reopen a debounced snapshot read/write.
      setAdoptionIndexSnapshotFsyncForTest(null)
      expect(insertGenEvent(makeRow({ event_id: "g_windows_real_fsync" }))).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      expect(flushAdoptionIndex()).toBe(true)
    } finally {
      setAdoptionIndexSnapshotFsyncForTest(null)
      vi.useRealTimers()
    }
  })

  it("re-exports the in-memory database if the primary is externally replaced", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(insertGenEvent(makeRow({ event_id: "g_identity_replace" }))).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)
    writeFileSync(primaryPath, "externally-replaced-primary", "utf8")
    expect(flushAdoptionIndex()).toBe(true)
    expect(readFileSync(primaryPath).subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0")

    closeAdoptionIndex()
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(getGenRowByEventId("g_identity_replace")).not.toBeNull()
  })

  it("re-exports the in-memory database if the primary is externally deleted", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(insertGenEvent(makeRow({ event_id: "g_identity_delete" }))).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)
    rmSync(primaryPath, { force: true })
    expect(flushAdoptionIndex()).toBe(true)
    expect(existsSync(primaryPath)).toBe(true)
    closeAdoptionIndex()
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(getGenRowByEventId("g_identity_delete")).not.toBeNull()
  })

  it("retries failed debounced saves with bounded backoff and throttled logging", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)
    let replaceAttempts = 0
    setAdoptionIndexSnapshotReplaceForTest((source, destination) => {
      replaceAttempts += 1
      if (replaceAttempts <= 2) throw new Error("simulated debounce replace failure")
      renameSync(source, destination)
    })
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(insertGenEvent(makeRow({ event_id: "g_debounce_retry" }))).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      expect(replaceAttempts).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(replaceAttempts).toBe(2)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(replaceAttempts).toBe(3)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      setAdoptionIndexSnapshotReplaceForTest(null)
      vi.useRealTimers()
    }

    expect(flushAdoptionIndex()).toBe(true)
    closeAdoptionIndex()
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(getGenRowByEventId("g_debounce_retry")).not.toBeNull()
  })

  it("restores the retry timer when an explicit flush interrupts backoff and also fails", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)
    let replaceAttempts = 0
    setAdoptionIndexSnapshotReplaceForTest((source, destination) => {
      replaceAttempts += 1
      if (replaceAttempts <= 2) throw new Error("simulated retry and flush failure")
      renameSync(source, destination)
    })
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(insertGenEvent(makeRow({ event_id: "g_flush_restores_retry" }))).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      expect(replaceAttempts).toBe(1)

      // This clears the already-scheduled 1s retry, then fails synchronously.
      // The dirty snapshot must still be retried automatically with backoff.
      expect(flushAdoptionIndex()).toBe(false)
      expect(replaceAttempts).toBe(2)
      expect(warn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(replaceAttempts).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(replaceAttempts).toBe(3)
    } finally {
      warn.mockRestore()
      setAdoptionIndexSnapshotReplaceForTest(null)
      vi.useRealTimers()
    }

    expect(flushAdoptionIndex()).toBe(true)
    closeAdoptionIndex()
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(getGenRowByEventId("g_flush_restores_retry")).not.toBeNull()
  })

  it("retries a durable repair after debounce succeeded but fsync and replacement failed", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    let fsyncAttempts = 0
    let replaceAttempts = 0
    try {
      expect(insertGenEvent(makeRow({ event_id: "g_durability_repair" }))).toBe(true)
      await vi.advanceTimersByTimeAsync(500)

      setAdoptionIndexSnapshotFsyncForTest(() => {
        fsyncAttempts += 1
        if (fsyncAttempts === 1) {
          const error = new Error("simulated Windows file lock") as NodeJS.ErrnoException
          error.code = "EPERM"
          throw error
        }
      })
      setAdoptionIndexSnapshotReplaceForTest((source, destination) => {
        replaceAttempts += 1
        if (replaceAttempts === 1) throw new Error("simulated durable replace failure")
        renameSync(source, destination)
      })

      expect(flushAdoptionIndex()).toBe(false)
      expect(replaceAttempts).toBe(1)
      setAdoptionIndexSnapshotFsyncForTest(null)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(replaceAttempts).toBe(2)
    } finally {
      warn.mockRestore()
      setAdoptionIndexSnapshotFsyncForTest(null)
      setAdoptionIndexSnapshotReplaceForTest(null)
      vi.useRealTimers()
    }

    expect(flushAdoptionIndex()).toBe(true)
    closeAdoptionIndex()
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(getGenRowByEventId("g_durability_repair")).not.toBeNull()
  })

  it("retries durable repair when an externally missing primary cannot be replaced", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(insertGenEvent(makeRow({ event_id: "g_missing_repair" }))).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)
    rmSync(primaryPath, { force: true })

    let replaceAttempts = 0
    setAdoptionIndexSnapshotReplaceForTest((source, destination) => {
      replaceAttempts += 1
      if (replaceAttempts === 1) throw new Error("simulated missing-primary replace failure")
      renameSync(source, destination)
    })
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(flushAdoptionIndex()).toBe(false)
      expect(existsSync(primaryPath)).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(replaceAttempts).toBe(2)
      expect(existsSync(primaryPath)).toBe(true)
    } finally {
      warn.mockRestore()
      setAdoptionIndexSnapshotReplaceForTest(null)
      vi.useRealTimers()
    }

    closeAdoptionIndex()
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(getGenRowByEventId("g_missing_repair")).not.toBeNull()
  })

  it("fails closed when the existing primary is corrupt", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)
    closeAdoptionIndex()
    writeFileSync(primaryPath, "corrupted-primary", "utf8")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(await initializeAdoptionIndex()).toBe(false)
    } finally {
      warn.mockRestore()
    }
    expect(insertGenEvent(makeRow({ event_id: "g_must_not_overwrite" }))).toBe(false)
    expect(readFileSync(primaryPath, "utf8")).toBe("corrupted-primary")
  })

  it("keeps the old primary and dirty state retryable when atomic replace fails", async () => {
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(insertGenEvent(makeRow({ event_id: "g_replace_old" }))).toBe(true)
    expect(flushAdoptionIndex()).toBe(true)
    const oldPrimary = readFileSync(primaryPath)

    expect(insertGenEvent(makeRow({ event_id: "g_replace_retry" }))).toBe(true)
    setAdoptionIndexSnapshotReplaceForTest((source, destination) => {
      if (destination === primaryPath) throw new Error("simulated primary replace failure")
      renameSync(source, destination)
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(flushAdoptionIndex()).toBe(false)
    } finally {
      warn.mockRestore()
    }

    expect(readFileSync(primaryPath)).toEqual(oldPrimary)
    expect(existsSync(primaryTempPath)).toBe(false)
    setAdoptionIndexSnapshotReplaceForTest(null)
    expect(flushAdoptionIndex()).toBe(true)

    closeAdoptionIndex()
    expect(await initializeAdoptionIndex()).toBe(true)
    expect(getGenRowByEventId("g_replace_old")).not.toBeNull()
    expect(getGenRowByEventId("g_replace_retry")).not.toBeNull()
  })
})
