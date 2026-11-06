import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../harness-board/service", () => ({
  resolveHarnessFeatureCurrentStage: vi.fn()
}))

import { resolveHarnessFeatureCurrentStage } from "../harness-board/service"
import {
  getHarnessStageAttributionForCall,
  primeHarnessStageAttribution,
  resolveHarnessExecutionStage
} from "./harness-stage-attribution"

beforeEach(() => {
  vi.mocked(resolveHarnessFeatureCurrentStage).mockReset()
})

describe("execution-time Harness stage", () => {
  it("queries every execution without reusing or overwriting telemetry's snapshot", async () => {
    primeHarnessStageAttribution("p", "f", { name: "plan", status: "进行中" })
    vi.mocked(resolveHarnessFeatureCurrentStage)
      .mockResolvedValueOnce({ name: " dev ", status: " 进行中 " })
      .mockResolvedValueOnce({ name: "dev", status: "已完成" })
      .mockResolvedValueOnce({ name: "test", status: null })

    await expect(resolveHarnessExecutionStage(" p ", " f ")).resolves.toEqual({
      nodeName: "dev",
      nodeStatus: "进行中"
    })
    await expect(resolveHarnessExecutionStage("p", "f")).resolves.toEqual({
      nodeName: "dev",
      nodeStatus: "已完成"
    })
    await expect(resolveHarnessExecutionStage("p", "f")).resolves.toEqual({
      nodeName: "test",
      nodeStatus: null
    })
    expect(resolveHarnessFeatureCurrentStage).toHaveBeenCalledTimes(3)
    expect(resolveHarnessFeatureCurrentStage).toHaveBeenCalledWith("p", "f")
    await expect(getHarnessStageAttributionForCall("p", "f")).resolves.toEqual({
      nodeName: "plan",
      nodeStatus: "进行中"
    })
  })

  it("distinguishes an unbound caller from a missing or failed bound lookup", async () => {
    await expect(resolveHarnessExecutionStage(undefined, "f")).resolves.toBeUndefined()
    await expect(resolveHarnessExecutionStage("p", " ")).resolves.toBeUndefined()
    expect(resolveHarnessFeatureCurrentStage).not.toHaveBeenCalled()

    vi.mocked(resolveHarnessFeatureCurrentStage)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("adapter unavailable"))
      .mockResolvedValueOnce({ name: " ", status: "进行中" })
    for (let i = 0; i < 3; i++) {
      await expect(resolveHarnessExecutionStage("p", "f")).resolves.toEqual({
        nodeName: null,
        nodeStatus: null
      })
    }
  })
})
