import { describe, it, expect, vi } from "vitest"
import { AIMessage } from "@langchain/core/messages"
import { createStageUsageMiddleware } from "./stage-usage-middleware"
import { TraceStageUsageCounter } from "./stage-usage"
import {
  CALL_STAGE_SETTLE_MS,
  registerTraceStageUsage,
  unregisterTraceStageUsage
} from "./stage-usage-registry"
import type { TraceContext } from "./types"
import { readModelCallStage } from "../../../shared/trace-stage-usage"

const stage = vi.hoisted(() => ({ nodeName: "plan", nodeStatus: "进行中" }))
const lookup = vi.hoisted(() => ({
  next: undefined as undefined | (() => Promise<{ nodeName: string | null; nodeStatus: null }>)
}))
vi.mock("../../services/harness-stage-attribution", () => ({
  getHarnessStageAttributionForCall: async () => {
    const pending = lookup.next
    lookup.next = undefined
    return pending ? pending() : { ...stage }
  }
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
      await counter.settle(CALL_STAGE_SETTLE_MS)
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

  it("never holds a call on a slow stage lookup", async () => {
    vi.useFakeTimers()
    try {
      const counter = new TraceStageUsageCounter()
      const context = {
        traceId: "slow",
        harnessFeature: { projectId: "p", slug: "f", nodeName: "plan" }
      } as TraceContext
      registerTraceStageUsage("slow", counter)
      const middleware = createStageUsageMiddleware(context)

      // The model call starts before its lookup answers and is only unattributed if the
      // lookup is still running once the call is done.
      lookup.next = () => new Promise(() => undefined)
      let modelStarted = false
      const model = middleware.wrapModelCall!({} as never, async () => {
        modelStarted = true
        return new AIMessage({ id: "m", content: "ok" })
      })
      await Promise.resolve()
      expect(modelStarted).toBe(true)
      await vi.advanceTimersByTimeAsync(CALL_STAGE_SETTLE_MS)
      const response = (await model) as AIMessage
      expect(response.response_metadata.cmbTraceStage).toEqual({ version: 1, traceId: "slow" })

      // A tool returns right away; its count moves once the lookup answers.
      let answer!: (value: { nodeName: string; nodeStatus: null }) => void
      lookup.next = () =>
        new Promise((resolve) => {
          answer = resolve
        })
      counter.recordTool("call:t", "read_file")
      await expect(
        middleware.wrapToolCall!(
          { toolCall: { id: "t", name: "read_file" } } as never,
          async () => "done" as never
        )
      ).resolves.toBe("done")
      answer({ nodeName: "review", nodeStatus: null })
      await counter.settle(CALL_STAGE_SETTLE_MS)
      counter.recordModel("m", { inputTokens: 1, outputTokens: 1 })
      const result = counter.snapshot({
        toolCalls: 1,
        modelCalls: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2
      })
      expect(result.stageUsage.find((x) => x.nodeName === "review")?.toolCalls).toBe(1)
      expect(result.stageUsage.find((x) => !x.nodeName)?.modelCalls).toBe(1)
      unregisterTraceStageUsage("slow")
    } finally {
      vi.useRealTimers()
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
