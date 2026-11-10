import { describe, it, expect } from "vitest"
import { TraceStageUsageCounter } from "./stage-usage"

const totals = { toolCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
describe("call-stage counters", () => {
  it("partitions tokens by model start and moves a previously observed intent to tool start exactly once", () => {
    const c = new TraceStageUsageCounter()
    c.bindModel("m1", { nodeName: "plan" })
    c.recordTool("call:t1", "request_user_input")
    c.bindTool("call:t1", { nodeName: "dev" })
    c.bindTool("call:t1", { nodeName: "review" }) // repeated snapshot/retry cannot reattribute
    c.recordTool("call:t1", "request_user_input")
    c.recordModel("m1", { inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    const snapshot = c.snapshot({
      toolCalls: 1,
      modelCalls: 1,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12
    })
    expect(snapshot.stageUsageComplete).toBe(true)
    expect(snapshot.stageUsage).toHaveLength(2)
    expect(snapshot.stageUsage.find((x) => x.nodeName === "plan")).toMatchObject({
      modelCalls: 1,
      totalTokens: 12,
      toolCalls: 0,
      tokenUsageReportedCalls: 1
    })
    expect(snapshot.stageUsage.find((x) => x.nodeName === "dev")).toMatchObject({
      toolCalls: 1,
      userInputRequests: 1,
      modelCalls: 0
    })
  })

  it("moves a tool once its call-start lookup lands, and ignores a repeated start", async () => {
    const c = new TraceStageUsageCounter()
    let answer!: (stage: { nodeName: string }) => void
    c.recordTool("call:t1", "request_user_input")
    c.bindToolLater(
      "call:t1",
      new Promise((resolve) => {
        answer = resolve
      })
    )
    c.bindToolLater("call:t1", Promise.resolve({ nodeName: "retry" }))
    const counted = { ...totals, toolCalls: 1 }
    // Until the lookup answers, the call stays in the unattributed bucket.
    expect(c.snapshot(counted).stageUsage).toEqual([
      expect.objectContaining({ toolCalls: 1, userInputRequests: 1 })
    ])
    expect(c.snapshot(counted).stageUsage[0].nodeName).toBeUndefined()
    answer({ nodeName: "dev" })
    await c.settle(1000)
    const snapshot = c.snapshot(counted)
    expect(snapshot.stageUsageComplete).toBe(true)
    expect(snapshot.stageUsage).toEqual([
      expect.objectContaining({ nodeName: "dev", toolCalls: 1, userInputRequests: 1 })
    ])
  })

  it("keeps unknown stages and missing token usage visible without inventing the turn-start stage", () => {
    const c = new TraceStageUsageCounter()
    c.recordModel("no-start")
    c.recordTool("t", "read_file")
    const result = c.snapshot({ ...totals, modelCalls: 1, toolCalls: 1 })
    expect(result.stageUsageComplete).toBe(true)
    expect(result.stageUsage[0]).toEqual({
      toolCalls: 1,
      modelCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      userInputRequests: 0,
      tokenUsageReportedCalls: 0
    })
  })

  it("supports both event orders, parallel calls and returning to an earlier stage", () => {
    const c = new TraceStageUsageCounter()
    for (const [id, stage] of [
      ["a", "plan"],
      ["b", "dev"],
      ["c", "plan"]
    ])
      c.bindModel(id, { nodeName: stage })
    for (const id of ["b", "c", "a"]) c.recordModel(id, { inputTokens: 1, outputTokens: 1 })
    c.bindTool("t", { nodeName: "review" })
    c.recordTool("t", "read_file")
    expect(
      c.snapshot({
        ...totals,
        toolCalls: 1,
        modelCalls: 3,
        inputTokens: 3,
        outputTokens: 3,
        totalTokens: 6
      })
    ).toMatchObject({
      stageUsageComplete: true,
      stageUsage: expect.arrayContaining([
        expect.objectContaining({ nodeName: "plan", modelCalls: 2, totalTokens: 4 })
      ])
    })
  })

  it("does not claim completeness after a missing event or capacity overflow", () => {
    const c = new TraceStageUsageCounter()
    expect(c.snapshot({ ...totals, toolCalls: 1 }).stageUsageComplete).toBe(false)
    for (let i = 0; i < 65; i++) c.recordTool(String(i), "read_file", { nodeName: `stage${i}` })
    const snapshot = c.snapshot({ ...totals, toolCalls: 65 })
    expect(snapshot.stageUsageComplete).toBe(false)
    expect(snapshot.stageUsage).toHaveLength(64)
  })

  it("supports complete zero and counters beyond retained detail limits", () => {
    const c = new TraceStageUsageCounter()
    expect(c.snapshot(totals)).toEqual({
      stageUsageSchemaVersion: 1,
      stageUsageComplete: true,
      stageUsage: []
    })
    for (let i = 0; i < 1500; i++) {
      c.recordModel(String(i), { inputTokens: 10, outputTokens: 2 }, { nodeName: "dev" })
      c.recordTool(String(i), "read_file", { nodeName: "dev" })
    }
    expect(
      c.snapshot({
        toolCalls: 1500,
        modelCalls: 1500,
        inputTokens: 15000,
        outputTokens: 3000,
        totalTokens: 18000
      }).stageUsageComplete
    ).toBe(true)
  })

  it("counts cache at model-start stages beyond 512 calls without adding it to total tokens", () => {
    const c = new TraceStageUsageCounter()
    for (let i = 0; i < 1000; i++) {
      c.bindModel(String(i), { nodeName: i < 512 ? "Biz-需求" : "Dev-实现" })
      c.recordModel(String(i), {
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        cacheReadTokens: i < 512 ? 60 : 80
      })
    }
    const result = c.snapshot({
      ...totals,
      modelCalls: 1000,
      inputTokens: 100000,
      outputTokens: 5000,
      totalTokens: 105000
    })
    expect(result.stageUsageComplete).toBe(true)
    expect(result.stageUsage.find((row) => row.nodeName === "Biz-需求")).toMatchObject({
      cacheReadTokens: 30720,
      cacheUsageReportedCalls: 512
    })
    expect(result.stageUsage.find((row) => row.nodeName === "Dev-实现")).toMatchObject({
      totalTokens: 488 * 105,
      cacheReadTokens: 488 * 80,
      cacheUsageReportedCalls: 488
    })
  })

  it("distinguishes a reported cache zero from missing or invalid cache usage", () => {
    const c = new TraceStageUsageCounter()
    for (const cacheReadTokens of [0, undefined, -1, Number.NaN, Infinity])
      c.recordModel(
        undefined,
        { inputTokens: 10, outputTokens: 2, cacheReadTokens },
        { nodeName: "Dev-实现" }
      )
    const result = c.snapshot({
      ...totals,
      modelCalls: 5,
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60
    })
    expect(result.stageUsageComplete).toBe(true)
    expect(result.stageUsage[0]).toMatchObject({
      cacheReadTokens: 0,
      cacheUsageReportedCalls: 1,
      tokenUsageReportedCalls: 5
    })
  })
})
