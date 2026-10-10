import { describe, expect, it } from "vitest"
import { addDevCompute, emptyDevCompute, finishDevCompute } from "./dashboard-efficiency-compute"

import { emptyComputeStages, reconcileComputeStages } from "./dashboard-efficiency-stages"

describe("compute aggregation", () => {
  it("recalculates weighted ratios and preserves partial usage across plugin versions", () => {
    const total = emptyDevCompute()
    addDevCompute(total, {
      ...emptyDevCompute(),
      totalTokens: 100,
      totalInputTokens: 80,
      totalOutputTokens: 20,
      generatedLines: 10,
      pushedAdoptedLines: 5
    })
    addDevCompute(total, {
      ...emptyDevCompute(),
      totalTokens: 900,
      totalInputTokens: 800,
      totalOutputTokens: 100,
      generatedLines: 30,
      pushedAdoptedLines: 10,
      tokenUsageIncomplete: true
    })
    expect(finishDevCompute(total)).toMatchObject({
      totalTokens: 1000,
      tokensPerGeneratedLine: 25,
      tokensPerAdoptedLine: 1000 / 15,
      tokenUsageIncomplete: true
    })
  })
})

describe("stage attribution integrity", () => {
  it("keeps budget-truncated and other unpartitioned totals visible as unattributed", () => {
    const total = {
      ...emptyDevCompute(),
      totalInputTokens: 800,
      totalOutputTokens: 200,
      totalTokens: 1000,
      cacheReadTokens: 400,
      generatedLines: 30,
      pushedAdoptedLines: 20
    }
    const stages = emptyComputeStages()
    Object.assign(stages.dev, {
      totalInputTokens: 240,
      totalOutputTokens: 60,
      totalTokens: 300,
      cacheReadTokens: 150,
      generatedLines: 10,
      pushedAdoptedLines: 5
    })
    reconcileComputeStages(total, stages)
    expect(stages.unattributed).toMatchObject({
      totalInputTokens: 560,
      totalOutputTokens: 140,
      totalTokens: 700,
      cacheReadTokens: 250,
      generatedLines: 20,
      pushedAdoptedLines: 15
    })
  })
  it("never fabricates negative remainders or shares over 100% from inconsistent counters", () => {
    const total = {
      ...emptyDevCompute(),
      totalInputTokens: 80,
      totalOutputTokens: 20,
      totalTokens: 100,
      generatedLines: 5
    }
    const stages = emptyComputeStages()
    Object.assign(stages.dev, {
      totalInputTokens: 120,
      totalOutputTokens: 30,
      totalTokens: 150,
      generatedLines: 10
    })
    reconcileComputeStages(total, stages)
    expect(stages.dev).toMatchObject({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      generatedLines: 0
    })
    expect(stages.unattributed).toMatchObject({
      totalInputTokens: 80,
      totalOutputTokens: 20,
      totalTokens: 100,
      generatedLines: 5
    })
  })
  it("does not erase valid token attribution when old top-level cache totals are absent", () => {
    const total = {
      ...emptyDevCompute(),
      totalInputTokens: 80,
      totalOutputTokens: 20,
      totalTokens: 100
    }
    const stages = emptyComputeStages()
    Object.assign(stages.dev, {
      totalInputTokens: 80,
      totalOutputTokens: 20,
      totalTokens: 100,
      cacheReadTokens: 50
    })
    reconcileComputeStages(total, stages)
    expect(stages.dev).toMatchObject({
      totalInputTokens: 80,
      totalOutputTokens: 20,
      totalTokens: 100,
      cacheReadTokens: 0
    })
    expect(stages.unattributed.totalTokens).toBe(0)
  })
})
