import { describe, expect, it } from "vitest"
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
        successfulReadCount: 4,
        distinctFileCount: 3,
        filesTruncated: false,
        traceOutcome: "success"
      }
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

    const emittedTraceIds: string[] = []
    const emit = (_eventName: string, _category: string, properties = {}): void => {
      const traceId = (properties as Record<string, unknown>).traceId
      if (typeof traceId === "string") emittedTraceIds.push(traceId)
    }

    expect(accumulator.flushTrace("child-trace-a", "success", emit)).toBe(1)
    expect(accumulator.flushTrace("trace-1", "success", emit)).toBe(1)
    expect(accumulator.flushTrace("child-trace-b", "success", emit)).toBe(1)
    expect(emittedTraceIds).toEqual(["child-trace-a", "trace-1", "child-trace-b"])
    expect(accumulator.flushTrace("trace-1", "success", emit)).toBe(0)
  })
})
