import { gzipSync } from "zlib"
import { rmSync } from "fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { LocalGeneratedLineDetail } from "../../shared/adoption-trace-types"

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("os")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("path")
  return { tempDir: mkdtempSync(join(tmpdir(), "adoption-local-lines-test-")) as string }
})

vi.mock("../storage", () => ({
  getOpenworkDir: () => h.tempDir,
  getUserInfo: () => null
}))

import {
  closeAdoptionIndex,
  finalizeGenMeasurement,
  initializeAdoptionIndex,
  insertGenEvent,
  type GenIndexRow
} from "./adoption-index"
import { readLocalCommitAdoptionLines } from "./adoption-tracker"

describe("stored local adoption details", () => {
  beforeAll(async () => {
    await initializeAdoptionIndex()
  })

  afterAll(() => {
    closeAdoptionIndex()
    rmSync(h.tempDir, { recursive: true, force: true })
  })

  it("summarizes the full payload before truncating returned source lines", async () => {
    const details: LocalGeneratedLineDetail[] = Array.from({ length: 4002 }, (_, index) => ({
      lineNumber: index + 1,
      text: `generated line ${index + 1}`,
      status:
        index === 0
          ? "adopted"
          : index === 1
            ? "superseded_by_agent"
            : index === 2
              ? "unknown"
              : "not_adopted"
    }))
    const genRow: GenIndexRow = {
      event_id: "g_large_details",
      file_path: "/repo/src/large.ts",
      tool: "write_file",
      content_fingerprint: null,
      shard_file: "/shards/current.jsonl",
      shard_offset: 0,
      line_hashes: new Uint8Array([1, 2, 3, 4]),
      old_line_hashes: null,
      generated_lines_blob: null,
      created_at: 123000,
      measured: 0,
      used_skills: null,
      skill_source: null,
      thread_id: null,
      trace_id: null,
      model_id: null,
      model_name: null,
      harness_project_id: null,
      harness_feature_slug: null,
      harness_node_name: null,
      harness_node_status: null,
      harness_adapter_name: null,
      harness_adapter_version: null
    }
    insertGenEvent(genRow)
    expect(
      finalizeGenMeasurement("g_large_details", {
        commit_sha: "commit-large",
        file_path: "/repo/src/large.ts",
        rel_path: "src/large.ts",
        details_blob: gzipSync(Buffer.from(JSON.stringify(details), "utf-8")),
        measured_at: 123456
      })
    ).toBe(true)

    const [result] = await readLocalCommitAdoptionLines("commit-large", ["g_large_details"])
    expect(result.available).toBe(true)
    expect(result.source).toBe("stored_gen")
    expect(result.generatedLineCount).toBe(4002)
    expect(result.effectiveLineCount).toBe(4001)
    expect(result.matchedLineCount).toBe(1)
    expect(result.notAdoptedLineCount).toBe(3999)
    expect(result.supersededLineCount).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.generatedLines).toHaveLength(4000)
    expect(result.generatedLines?.at(-1)?.lineNumber).toBe(4000)
  })
})
