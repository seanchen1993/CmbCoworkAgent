import { describe, it, expect, vi } from "vitest"
import { AIMessage } from "@langchain/core/messages"
import { createStageUsageMiddleware } from "./stage-usage-middleware"
import { TraceStageUsageCounter } from "./stage-usage"
import { registerTraceStageUsage, unregisterTraceStageUsage } from "./stage-usage-registry"
import type { TraceContext } from "./types"
import { readModelCallStage } from "../../../shared/trace-stage-usage"

const stage = vi.hoisted(() => ({ nodeName: "plan", nodeStatus: "进行中" }))
vi.mock("../../services/harness-stage-attribution", () => ({
  getHarnessStageAttributionForCall: async () => ({ ...stage })
}))

describe("stage usage runtime middleware", () => {
  it("accepts only this trace's stamp and leaves frozen model results usable", async () => {
    expect(
      readModelCallStage({ version: 1, traceId: "old", nodeName: "plan" }, "new")
    ).toBeUndefined()
    expect(readModelCallStage({ version: 1, traceId: "new" }, "new")).toEqual({})
    const counter = new TraceStageUsageCounter()
    registerTraceStageUsage("frozen", counter)
    const middleware = createStageUsageMiddleware({ traceId: "frozen" } as TraceContext)
    const response = Object.freeze(new AIMessage({ id: "m", content: "ok" }))
    await expect(middleware.wrapModelCall!({} as never, async () => response)).resolves.toBe(
      response
    )
    unregisterTraceStageUsage("frozen")
  })
  it("freezes model start across a stage change, isolates child traces and preserves handler results", async () => {
    for (const kind of ["root", "coordinator_worker", "workflow_agent"]) {
      const counter = new TraceStageUsageCounter()
      const context = {
        traceId: kind,
        harnessFeature: { projectId: "p", slug: "f", nodeName: "old" }
      } as TraceContext
      registerTraceStageUsage(kind, counter)
      const middleware = createStageUsageMiddleware(context)
      stage.nodeName = "plan"
      const response = new AIMessage({ id: "shared-id", content: "ok" })
      const actual = await middleware.wrapModelCall!({} as never, async () => {
        stage.nodeName = "dev"
        return response
      })
      expect(actual).toBe(response)
      counter.recordModel("shared-id", { inputTokens: 7, outputTokens: 3 })
      counter.recordTool("call:tool", "read_file")
      await middleware.wrapToolCall!(
        { toolCall: { id: "tool", name: "read_file" } } as never,
        async () => ({ content: "ok" }) as never
      )
      const result = counter.snapshot({
        toolCalls: 1,
        modelCalls: 1,
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10
      })
      expect(result.stageUsageComplete).toBe(true)
      expect(result.stageUsage.find((x) => x.nodeName === "plan")?.totalTokens).toBe(10)
      expect(result.stageUsage.find((x) => x.nodeName === "dev")?.toolCalls).toBe(1)
      unregisterTraceStageUsage(kind)
    }
  })

  it("does not convert model failures into success or count an extra response", async () => {
    const counter = new TraceStageUsageCounter()
    registerTraceStageUsage("fail", counter)
    const middleware = createStageUsageMiddleware({ traceId: "fail" } as TraceContext)
    const error = new Error("provider failure")
    await expect(
      middleware.wrapModelCall!({} as never, async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(
      counter.snapshot({
        toolCalls: 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }).stageUsageComplete
    ).toBe(true)
    unregisterTraceStageUsage("fail")
  })
})
