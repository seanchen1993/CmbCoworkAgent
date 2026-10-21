import { beforeEach, describe, expect, it, vi } from "vitest"
import { generateTitle } from "./title-generator"

const resolveStage = vi.hoisted(() => vi.fn())
vi.mock("../harness-board/service", () => ({
  resolveHarnessFeatureCurrentStage: resolveStage
}))

import { generateProjectThreadTitle } from "./project-thread-title"

describe("project thread title", () => {
  const binding = { projectId: "project", slug: "feature" }
  const message = "请继续完成当前阶段的任务"

  beforeEach(() => {
    resolveStage.mockReset()
  })

  it("uses the explicitly selected skill and requests only the current node label", async () => {
    resolveStage.mockResolvedValue({ name: "技术设计", status: "进行中" })
    expect(await generateProjectThreadTitle(message, " 方案设计 ", binding)).toBe(
      "[技术设计]方案设计"
    )
    expect(resolveStage).toHaveBeenCalledWith("project", "feature", { labelOnly: true })
  })

  it("keeps ordinary threads on the existing title rules", async () => {
    expect(await generateProjectThreadTitle(message, "方案设计", undefined)).toBe(
      generateTitle(message)
    )
    expect(resolveStage).not.toHaveBeenCalled()
  })

  it.each([undefined, "", " "])(
    "prefixes the message title with the current label when the skill is absent: %j",
    async (skillName) => {
      resolveStage.mockResolvedValue({ name: "技术设计", status: "进行中" })
      const text = "使用方案设计技能完成设计。" + "详细说明".repeat(20)
      expect(await generateProjectThreadTitle(text, skillName, binding)).toBe(
        `[技术设计]${generateTitle(text)}`
      )
      expect(resolveStage).toHaveBeenCalledWith("project", "feature", { labelOnly: true })
    }
  )

  it("keeps the message title when both skill and stage are absent", async () => {
    resolveStage.mockResolvedValue(null)
    expect(await generateProjectThreadTitle(message, undefined, binding)).toBe(
      generateTitle(message)
    )
  })

  it.each([null, { name: " ", status: null }])(
    "falls back when the node label is missing: %j",
    async (stage) => {
      resolveStage.mockResolvedValue(stage)
      expect(await generateProjectThreadTitle(message, "方案设计", binding)).toBe(
        generateTitle(message)
      )
    }
  )

  it("falls back when resolving the stage fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      resolveStage.mockRejectedValue(new Error("adapter unavailable"))
      expect(await generateProjectThreadTitle(message, "方案设计", binding)).toBe(
        generateTitle(message)
      )
    } finally {
      warn.mockRestore()
    }
  })
})
