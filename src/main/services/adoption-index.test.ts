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
  findPendingGensForFile,
  getGenRowByEventId,
  initializeAdoptionIndex,
  insertGenEvent,
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
    created_at: Date.now(),
    measured: 0,
    used_skills: null,
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
    ...overrides
  }
}

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
    insertGenEvent(makeRow({ event_id: "g_node_1" }))
    const fetched = getGenRowByEventId("g_node_1")
    expect(fetched).not.toBeNull()
    expect(fetched?.harness_node_name).toBe("Dev-代码实现")
    expect(fetched?.harness_node_status).toBe("进行中")
    // Existing sibling column must remain intact alongside the new one.
    expect(fetched?.harness_feature_slug).toBe("feature-x")
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
})
