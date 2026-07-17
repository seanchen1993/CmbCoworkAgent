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

import { rmSync } from "fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

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
  finalizeGenMeasurement,
  findPendingGensForFile,
  getAdoptLineDetails,
  getGenRowByEventId,
  initializeAdoptionIndex,
  insertGenEvent,
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
