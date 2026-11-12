import { afterEach, describe, expect, it, vi } from "vitest"
import { nowIsoLocal } from "../util/local-time"
import {
  SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT,
  SystemConstraintReadAccumulator,
  type SystemConstraintReadRecord
} from "./system-constraint-read-reporter"

const baseRecord: SystemConstraintReadRecord = {
  traceId: "trace-1",
  rootTraceId: "root-trace-1",
  rootThreadId: "root-thread-1",
  threadId: "thread-1",
  agentId: "agent-1",
  harnessProjectId: "project-1",
  harnessFeatureSlug: "feature-1",
  harnessNodeName: "Dev-代码实现",
  harnessNodeStatus: "进行中",
  pluginId: "plugin-1",
  pluginName: "Plugin One",
  harnessAdapterName: "adapter-1",
  harnessAdapterVersion: "1.0.0",
  constraintFile: "sys/project.md"
}

describe("SystemConstraintReadAccumulator", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("emits one summary per trace and stage while preserving read/file counts", () => {
    const accumulator = new SystemConstraintReadAccumulator()
    accumulator.record(baseRecord)
    accumulator.record(baseRecord)
    accumulator.record({ ...baseRecord, constraintFile: "sys/stages/code.md" })
    accumulator.record({
      ...baseRecord,
      harnessNodeStatus: "已完成",
      constraintFile: "sys/stages/review.md"
    })
    accumulator.record({
      ...baseRecord,
      harnessNodeName: "Dev-单元测试",
      harnessNodeStatus: "已完成",
      constraintFile: "sys/stages/test.md"
    })

    const emitted: Array<{
      eventName: string
      category: string
      properties: Record<string, unknown>
    }> = []
    expect(
      accumulator.flushTrace("trace-1", "success", (eventName, category, properties = {}) => {
        emitted.push({ eventName, category, properties })
      })
    ).toBe(2)

    const codeStage = emitted.find((event) => event.properties.harnessNodeName === "Dev-代码实现")
    expect(codeStage).toMatchObject({
      eventName: SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT,
      category: "harness",
      properties: {
        traceId: "trace-1",
        harnessProjectId: "project-1",
        harnessFeatureSlug: "feature-1",
        harnessNodeStatus: "进行中",
        constraintFiles: ["sys/project.md", "sys/stages/code.md", "sys/stages/review.md"],
        files: [
          expect.objectContaining({ filePath: "sys/project.md", readCount: 2 }),
          expect.objectContaining({ filePath: "sys/stages/code.md", readCount: 1 }),
          expect.objectContaining({ filePath: "sys/stages/review.md", readCount: 1 })
        ],
        successfulReadCount: 4,
        distinctFileCount: 3,
        filesTruncated: false,
        traceOutcome: "success"
      }
    })
    expect(
      emitted.find((event) => event.properties.harnessNodeName === "Dev-单元测试")
    ).toMatchObject({
      properties: {
        successfulReadCount: 1,
        distinctFileCount: 1,
        constraintFiles: ["sys/stages/test.md"],
        files: [expect.objectContaining({ filePath: "sys/stages/test.md", readCount: 1 })]
      }
    })
  })

  it("preserves the legacy wire fields while reporting each file's own counts and times", () => {
    vi.useFakeTimers()
    const accumulator = new SystemConstraintReadAccumulator()
    const start = Date.parse("2026-11-12T01:00:00.000Z")
    const at = (minute: number): Date => new Date(start + minute * 60_000)
    const time = (minute: number): string => nowIsoLocal(at(minute))

    // Interleave repeated reads: B's final read must not inherit A's later time.
    for (const [minute, constraintFile] of [
      [0, "sys/A.md"],
      [1, "sys/B.md"],
      [2, "sys/A.md"],
      [3, "sys/B.md"],
      [4, "sys/A.md"]
    ] as const) {
      vi.setSystemTime(at(minute))
      accumulator.record({ ...baseRecord, constraintFile })
    }
    vi.setSystemTime(at(5))
    const emit = vi.fn()
    expect(accumulator.flushTrace("trace-1", "success", emit)).toBe(1)
    expect(emit).toHaveBeenCalledTimes(1)
    const [eventName, category, properties] = emit.mock.calls[0]
    expect([eventName, category]).toEqual([SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT, "harness"])

    // Check the serialized payload that the existing event endpoint receives.
    const { files, ...legacy } = JSON.parse(JSON.stringify(properties))
    expect(files).toEqual([
      { filePath: "sys/A.md", readCount: 3, firstReadAt: time(0), lastReadAt: time(4) },
      { filePath: "sys/B.md", readCount: 2, firstReadAt: time(1), lastReadAt: time(3) }
    ])
    const context = Object.fromEntries(
      Object.entries(baseRecord).filter(([field]) => field !== "constraintFile")
    )
    expect(legacy).toEqual({
      ...context,
      constraintFiles: ["sys/A.md", "sys/B.md"],
      successfulReadCount: 5,
      distinctFileCount: 2,
      filesTruncated: false,
      firstReadAt: time(0),
      lastReadAt: time(4),
      traceOutcome: "success"
    })
  })

  it("removes a trace after flushing so finish retries cannot double-report", () => {
    const accumulator = new SystemConstraintReadAccumulator()
    accumulator.record(baseRecord)
    const emit = (): void => undefined

    expect(accumulator.flushTrace("trace-1", undefined, emit)).toBe(1)
    expect(accumulator.flushTrace("trace-1", undefined, emit)).toBe(0)
  })

  it("reports every distinct constraint file without truncating the detail list", () => {
    const accumulator = new SystemConstraintReadAccumulator()
    for (let index = 0; index < 80; index++) {
      accumulator.record({
        ...baseRecord,
        constraintFile: `sys/rules/${String(index).padStart(2, "0")}.md`
      })
    }

    const emitted: Array<Record<string, unknown>> = []
    accumulator.flushTrace("trace-1", "success", (_eventName, _category, properties = {}) => {
      emitted.push(properties)
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      distinctFileCount: 80,
      filesTruncated: false
    })
    expect(emitted[0].constraintFiles).toHaveLength(80)
    expect(emitted[0].files).toHaveLength(80)
    expect(emitted[0]).toMatchObject({
      successfulReadCount: 80,
      files: Array.from({ length: 80 }, (_, index) =>
        expect.objectContaining({
          filePath: `sys/rules/${String(index).padStart(2, "0")}.md`,
          readCount: 1
        })
      )
    })
  })

  it("flushes parent and concurrent child traces independently", () => {
    const accumulator = new SystemConstraintReadAccumulator()
    accumulator.record(baseRecord)
    accumulator.record({
      ...baseRecord,
      traceId: "child-trace-a",
      threadId: "thread-1__task_owner-a",
      agentId: "owner-a",
      constraintFile: "sys/child-a.md"
    })
    accumulator.record({
      ...baseRecord,
      traceId: "child-trace-b",
      threadId: "thread-1__task_owner-b",
      agentId: "owner-b",
      constraintFile: "sys/child-b.md"
    })

    const emitted: Record<string, unknown>[] = []
    const emit = (_eventName: string, _category: string, properties = {}): void => {
      emitted.push(properties)
    }

    expect(accumulator.flushTrace("child-trace-a", "success", emit)).toBe(1)
    expect(accumulator.flushTrace("trace-1", "success", emit)).toBe(1)
    expect(accumulator.flushTrace("child-trace-b", "success", emit)).toBe(1)
    expect(emitted).toMatchObject([
      {
        traceId: "child-trace-a",
        files: [{ filePath: "sys/child-a.md", readCount: 1 }]
      },
      {
        traceId: "trace-1",
        files: [{ filePath: "sys/project.md", readCount: 1 }]
      },
      {
        traceId: "child-trace-b",
        files: [{ filePath: "sys/child-b.md", readCount: 1 }]
      }
    ])
    expect(accumulator.flushTrace("trace-1", "success", emit)).toBe(0)
  })
})
