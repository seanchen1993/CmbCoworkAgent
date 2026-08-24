import { describe, expect, it } from "vitest"
import {
  buildProjectModeOperationalAggs,
  parseProjectModeOperationalStats
} from "./project-mode-operational-metrics"

describe("parseProjectModeOperationalStats", () => {
  it("uses exact document counts for a single workflow stage", () => {
    expect(
      parseProjectModeOperationalStats({
        system_constraint_reads: {
          doc_count: 2,
          successful_reads: { value: 5 },
          distinct_files: { value: 2 },
          truncated_summaries: { doc_count: 0 },
          files: {
            buckets: [
              { key: "sys/project.md", doc_count: 2 },
              { key: "sys/stages/code.md", doc_count: 1 }
            ]
          }
        },
        hook_executions: {
          doc_count: 4,
          blocked: { doc_count: 1 },
          by_event: { buckets: [{ key: "PreToolUse", doc_count: 4 }] }
        }
      })
    ).toEqual({
      systemConstraintReads: {
        traceCount: 2,
        successfulReadCount: 5,
        distinctFileCount: 2,
        filesTruncated: false,
        files: [
          { path: "sys/project.md", traceCount: 2 },
          { path: "sys/stages/code.md", traceCount: 1 }
        ]
      },
      hookExecutions: {
        executionCount: 4,
        blockedCount: 1,
        byEvent: [{ event: "PreToolUse", count: 4 }]
      }
    })
  })

  it("uses cardinality values when rolling summaries up across stages", () => {
    const parsed = parseProjectModeOperationalStats({
      system_constraint_reads: {
        // The same two traces each emitted summaries in two stages.
        doc_count: 4,
        trace_count: { value: 2 },
        successful_reads: { value: 9 },
        distinct_files: { value: 1 },
        truncated_summaries: { doc_count: 1 },
        files: {
          buckets: [
            {
              key: "sys/project.md",
              doc_count: 4,
              trace_count: { value: 2 }
            }
          ]
        }
      },
      hook_executions: { doc_count: 0 }
    })

    expect(parsed.systemConstraintReads).toMatchObject({
      traceCount: 2,
      successfulReadCount: 9,
      filesTruncated: true,
      files: [{ path: "sys/project.md", traceCount: 2 }]
    })
    expect(parsed.hookExecutions).toBeNull()
  })
})

describe("buildProjectModeOperationalAggs", () => {
  it("adds trace cardinality only for feature/project rollups", () => {
    const filters = [{ term: { eventName: "test" } }]
    const stageAggs = buildProjectModeOperationalAggs(filters, filters)
    const rollupAggs = buildProjectModeOperationalAggs(filters, filters, {
      dedupeConstraintTraces: true
    })

    expect(stageAggs.system_constraint_reads).not.toHaveProperty("aggs.trace_count")
    expect(stageAggs.system_constraint_reads).not.toHaveProperty("aggs.files.aggs.trace_count")
    expect(rollupAggs.system_constraint_reads).toHaveProperty("aggs.trace_count.cardinality")
    expect(rollupAggs.system_constraint_reads).toHaveProperty(
      "aggs.files.aggs.trace_count.cardinality"
    )
  })
})
