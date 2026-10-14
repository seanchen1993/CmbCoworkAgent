import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseProjectCapabilityManifest } from "./project-capability"

describe("project capability author examples", () => {
  it.each(["autobiz-fullstack-mods", "project-capability-minimal"])(
    "parses %s with the production schema",
    (name) => {
      const value = JSON.parse(
        readFileSync(resolve("examples", name, "devclaw.project.json"), "utf8")
      )
      const parsed = parseProjectCapabilityManifest(value)
      expect(parsed).toEqual(value)
      expect(parsed.help.length).toBeGreaterThan(0)
      expect(parsed.stages.length).toBeGreaterThan(0)
    }
  )

  it("documents actual dynamic Autobiz nodes without registering a new execution entry", () => {
    const manifest = parseProjectCapabilityManifest(
      JSON.parse(
        readFileSync(resolve("examples/autobiz-fullstack-mods/devclaw.project.json"), "utf8")
      )
    )
    expect(manifest.stages.map((stage) => stage.nodeId)).toEqual([
      "biz.prd",
      "dev.specs",
      "dev.design",
      "dev.plan",
      "dev.detail_design",
      "dev.code",
      "ops.cicd",
      "ops.archive"
    ])
    expect(manifest.help.some((help) => help.body.includes("不接入固定旧版本"))).toBe(true)
  })
})
