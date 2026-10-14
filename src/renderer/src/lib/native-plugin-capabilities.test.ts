import { describe, expect, it } from "vitest"
import { nativePluginCapabilities } from "./native-plugin-capabilities"
import type { PluginMetadata, SkillMetadata } from "@/types"

const plugin = (id: string, extra: Partial<PluginMetadata> = {}): PluginMetadata => ({
  id,
  name: id,
  version: "1.0",
  description: "installed",
  enabled: true,
  skillCount: 7,
  mcpServerCount: 0,
  path: "fixture",
  author: "test",
  createdAt: "",
  updatedAt: "",
  ...extra
})
const skill = (pluginId: string, extra: Partial<SkillMetadata> = {}): SkillMetadata => ({
  pluginId,
  name: "build",
  description: "",
  path: "fixture/skill",
  source: "user",
  version: "1",
  ...extra
})

describe("native plugin inventory", () => {
  it("keeps original and derived native versions visible but excludes function capabilities by ID", () => {
    const rows = nativePluginCapabilities(
      [
        plugin("original", { hasProjectMode: true }),
        plugin("derived", { hasProjectMode: true }),
        plugin("function", { skillCount: 0 }),
        plugin("another", { name: "function" })
      ],
      [skill("original"), skill("derived")],
      ["function"]
    )
    expect(rows.map((row) => row.pluginId)).toEqual(["original", "derived", "another"])
    expect(rows.every((row) => row.kind === "native-plugin")).toBe(true)
    expect(rows[1].skills.map((item) => item.name)).toEqual(["build"])
  })
  it("keeps a mixed function package's native project entry without duplicating function selections", () => {
    const rows = nativePluginCapabilities(
      [plugin("mixed", { hasProjectMode: true })],
      [],
      ["mixed"]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "native-plugin",
      projectMode: true,
      hasFunctionCapabilities: true
    })
  })
  it("does not claim disabled cached skills are currently usable and respects project metadata", () => {
    const rows = nativePluginCapabilities(
      [plugin("off", { enabled: false }), plugin("project"), plugin("plain")],
      [skill("off"), skill("project", { isProjectModePlugin: true })],
      []
    )
    expect(rows[0].skills).toEqual([])
    expect(rows[0].installedSkillCount).toBe(7)
    expect(rows[1].projectMode).toBe(true)
    expect(rows[2].projectMode).toBe(false)
  })
})
