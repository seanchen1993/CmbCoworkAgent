import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

// The shared cache captures Date.now when the service module is initialized.
vi.hoisted(() => vi.useFakeTimers())

vi.mock("../harness-board/service", () => ({
  resolveHarnessFeatureCurrentStage: vi.fn()
}))

import { resolveHarnessFeatureCurrentStage } from "../harness-board/service"
import {
  getHarnessStageAttributionForCall,
  getHarnessStageAttributionForCodeGeneration,
  markHarnessStageAttributionDirty,
  observeHarnessStage,
  primeHarnessStageAttribution,
  resolveHarnessExecutionStage,
  settleHarnessStageObservations
} from "./harness-stage-attribution"

const resolver = vi.mocked(resolveHarnessFeatureCurrentStage)

beforeEach(() => {
  resolver.mockReset()
  vi.setSystemTime(0)
})
afterAll(() => vi.useRealTimers())

describe("execution-time Harness stage", () => {
  it("reuses a primed snapshot and refreshes node/status changes immediately on invalidation", async () => {
    primeHarnessStageAttribution("p", "changes", { name: "plan", status: "进行中" })
    const previousCall = await getHarnessStageAttributionForCall("p", "changes")
    await expect(resolveHarnessExecutionStage(" p ", " changes ")).resolves.toEqual(previousCall)
    expect(resolver).not.toHaveBeenCalled()

    for (const stage of [
      { name: " dev ", status: " 进行中 " },
      { name: "dev", status: "已完成" },
      { name: "test", status: null }
    ]) {
      resolver.mockResolvedValueOnce(stage)
      markHarnessStageAttributionDirty("p", "changes")
      await expect(resolveHarnessExecutionStage("p", "changes")).resolves.toEqual({
        nodeName: stage.name.trim(),
        nodeStatus: stage.status?.trim() ?? null
      })
    }
    expect(resolver).toHaveBeenCalledTimes(3)
    expect(previousCall).toEqual({ nodeName: "plan", nodeStatus: "进行中" })
  })

  it("shares one lookup across 100 concurrent and 100 sequential executions plus telemetry", async () => {
    resolver.mockResolvedValue({ name: "dev", status: "进行中" })
    const stages = await Promise.all([
      ...Array.from({ length: 100 }, () => resolveHarnessExecutionStage("p", "burst")),
      getHarnessStageAttributionForCall("p", "burst"),
      getHarnessStageAttributionForCodeGeneration("p", "burst")
    ])
    expect(stages.every((stage) => stage?.nodeName === "dev")).toBe(true)
    for (let i = 0; i < 100; i++) await resolveHarnessExecutionStage("p", "burst")
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it("shares a dirty observer lookup with the next execution", async () => {
    resolver.mockResolvedValue({ name: "dev", status: "已完成" })
    primeHarnessStageAttribution("p", "observed", { name: "dev", status: "进行中" })
    const observer = vi.fn()
    const unsubscribe = observeHarnessStage("p", "observed", observer)
    try {
      markHarnessStageAttributionDirty("p", "observed")
      await expect(resolveHarnessExecutionStage("p", "observed")).resolves.toEqual({
        nodeName: "dev",
        nodeStatus: "已完成"
      })
      await vi.advanceTimersByTimeAsync(250)
      await settleHarnessStageObservations("p", "observed", 100)
      expect(observer).toHaveBeenCalledWith(0, "dev")
      expect(resolver).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it("coalesces state-notification bursts instead of inspecting on each notification", async () => {
    resolver.mockResolvedValue({ name: "test", status: "进行中" })
    const stop = observeHarnessStage("p", "burst-notifications", vi.fn())
    try {
      for (let i = 0; i < 50; i++) markHarnessStageAttributionDirty("p", "burst-notifications")
      expect(resolver).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(250)
      expect(resolver).toHaveBeenCalledTimes(1)
      await resolveHarnessExecutionStage("p", "burst-notifications")
      expect(resolver).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it("refreshes unobserved external changes on the first execution after five minutes", async () => {
    primeHarnessStageAttribution("p", "external", { name: "dev", status: "进行中" })
    resolver.mockResolvedValue({ name: "test", status: "已完成" })
    vi.setSystemTime(299_999)
    expect((await resolveHarnessExecutionStage("p", "external"))?.nodeName).toBe("dev")
    expect(resolver).not.toHaveBeenCalled()
    vi.setSystemTime(300_000)
    await expect(resolveHarnessExecutionStage("p", "external")).resolves.toEqual({
      nodeName: "test",
      nodeStatus: "已完成"
    })
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it("distinguishes unbound callers and backs off missing, failed and blank stage lookups", async () => {
    await expect(resolveHarnessExecutionStage(undefined, "f")).resolves.toBeUndefined()
    await expect(resolveHarnessExecutionStage("p", " ")).resolves.toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()

    resolver
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("adapter unavailable"))
      .mockResolvedValueOnce({ name: " ", status: "进行中" })
    for (let attempt = 0; attempt < 3; attempt++) {
      vi.setSystemTime(attempt * 30_000)
      for (let read = 0; read < 20; read++) {
        markHarnessStageAttributionDirty("p", "unavailable")
        await expect(resolveHarnessExecutionStage("p", "unavailable")).resolves.toEqual({
          nodeName: null,
          nodeStatus: null
        })
      }
      expect(resolver).toHaveBeenCalledTimes(attempt + 1)
    }
  })

  it("does not serve an older telemetry snapshot after an execution refresh fails", async () => {
    primeHarnessStageAttribution("p", "failed-refresh", { name: "old", status: "进行中" })
    resolver.mockResolvedValue(null)
    vi.setSystemTime(300_000)
    await expect(resolveHarnessExecutionStage("p", "failed-refresh")).resolves.toEqual({
      nodeName: null,
      nodeStatus: null
    })
    await expect(getHarnessStageAttributionForCall("p", "failed-refresh")).resolves.toEqual({
      nodeName: null,
      nodeStatus: null
    })
    expect(resolver).toHaveBeenCalledTimes(1)
  })
})
