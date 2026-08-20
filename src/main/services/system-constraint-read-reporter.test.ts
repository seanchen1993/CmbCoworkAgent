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
  constraintFile: "sys/project.md",
  partial: false
}

describe("SystemConstraintReadAccumulator", () => {
  it("emits one summary per trace and stage while preserving read/file counts", () => {
    const accumulator = new SystemConstraintReadAccumulator()
    accumulator.record(baseRecord)
    accumulator.record({ ...baseRecord, partial: true })
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
        partialReadCount: 1,
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
})
