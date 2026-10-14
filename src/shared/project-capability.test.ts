import { describe, expect, it } from "vitest"
import { parseProjectCapabilityManifest, PROJECT_CAPABILITY_MAX_BYTES } from "./project-capability"

const manifest = () => ({
  apiVersion: "devclaw.project/v1",
  name: "最小项目能力",
  description: "阶段指导，不代替原门禁。",
  help: [{ title: "使用", body: "进入原阶段会话。\n检查真实证据。" }],
  stages: [{ nodeId: "plan", guidance: "制定计划", before: ["明确需求"], after: ["审阅计划"] }]
})

describe("project capability manifest", () => {
  it("accepts a bounded static declaration and preserves Chinese multiline help", () => {
    expect(parseProjectCapabilityManifest(manifest())).toEqual(manifest())
    expect(parseProjectCapabilityManifest({ ...manifest(), help: [], stages: [] }).stages).toEqual(
      []
    )
  })

  it.each([
    null,
    [],
    { ...manifest(), apiVersion: "devclaw.project/v2" },
    { ...manifest(), name: " " },
    { ...manifest(), stages: new Array(1) },
    { ...manifest(), command: "run" },
    { ...manifest(), help: [{ title: "使用", body: "说明", approved: true }] },
    { ...manifest(), stages: [{ ...manifest().stages[0], command: "run" }] },
    { ...manifest(), stages: [{ ...manifest().stages[0], before: [42] }] },
    { ...manifest(), help: [{ title: "缺少正文" }] },
    { ...manifest(), stages: [{ ...manifest().stages[0], nodeId: "bad node" }] },
    {
      ...manifest(),
      stages: [manifest().stages[0], { ...manifest().stages[0], nodeId: " plan " }]
    },
    { ...manifest(), name: "a".repeat(129) },
    { ...manifest(), help: Array.from({ length: 17 }, () => manifest().help[0]) },
    { ...manifest(), stages: [{ ...manifest().stages[0], after: Array(17).fill("规则") }] },
    {
      ...manifest(),
      stages: Array.from({ length: 65 }, (_, i) => ({
        ...manifest().stages[0],
        nodeId: `node-${i}`
      }))
    },
    { ...manifest(), help: [{ title: "说明", body: "a".repeat(8193) }] }
  ])("rejects malformed, executable, unknown or oversized declarations (%#)", (value) => {
    expect(() => parseProjectCapabilityManifest(value)).toThrow()
  })

  it.each(["\u0000", "\u001b", "\u0085", "\u202e", "\u2066"])(
    "rejects hidden control characters in text (%#)",
    (control) => {
      expect(() =>
        parseProjectCapabilityManifest({
          ...manifest(),
          help: [{ title: "说明", body: `before${control}after` }]
        })
      ).toThrow()
    }
  )

  it("enforces the aggregate UTF-8 budget, not just per-field character limits", () => {
    const value = {
      ...manifest(),
      help: Array.from({ length: 8 }, () => ({
        title: "规则",
        body: "中".repeat(4096)
      }))
    }
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(
      PROJECT_CAPABILITY_MAX_BYTES
    )
    expect(() => parseProjectCapabilityManifest(value)).toThrow()
  })
})
