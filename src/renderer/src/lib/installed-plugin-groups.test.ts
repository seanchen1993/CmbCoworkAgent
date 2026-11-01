import { describe, expect, it } from "vitest"
import type { PluginMetadata } from "@/types"
import { groupInstalledPlugins } from "./installed-plugin-groups"
const plugin = (id: string, dependencies?: string[], enabled = true): PluginMetadata => ({
  id,
  name: id,
  version: "1.0.0",
  description: "",
  author: "",
  path: id,
  enabled,
  skillCount: 0,
  mcpServerCount: 0,
  createdAt: "",
  updatedAt: "",
  ...(dependencies === undefined ? {} : { projectDependencyIds: dependencies })
})
describe("installed project dependency presentation", () => {
  it("groups declared dependencies without matching names or hiding unrelated plugins", () => {
    const rows = [plugin("component"), plugin("project", ["component"]), plugin("unrelated")]
    const grouped = groupInstalledPlugins(rows)
    expect(grouped.roots.map((p) => p.id)).toEqual(["project", "unrelated"])
    expect(grouped.dependencies.get("project")?.map((p) => p.id)).toEqual(["component"])
    expect(rows).toHaveLength(3)
  })
  it("retains shared components under both projects and restores orphans after removal", () => {
    const child = plugin("shared")
    const first = plugin("first", ["shared"], false)
    const second = plugin("second", ["shared"])
    expect(groupInstalledPlugins([child, first, second]).owners.get("shared")).toEqual([
      "first",
      "second"
    ])
    expect(groupInstalledPlugins([child, first]).roots.map((p) => p.id)).toEqual(["first"])
    expect(groupInstalledPlugins([child]).roots.map((p) => p.id)).toEqual(["shared"])
  })
  it("keeps runnable projects visible even when projects reference each other", () => {
    expect(
      groupInstalledPlugins([plugin("a", ["b"]), plugin("b", ["a"])]).roots.map((p) => p.id)
    ).toEqual(["a", "b"])
  })
  it("ignores duplicates, self and missing entries and keeps incomplete projects visible", () => {
    const grouped = groupInstalledPlugins([plugin("a", ["a", "b", "b", "missing"]), plugin("b")])
    expect(grouped.dependencies.get("a")?.map((p) => p.id)).toEqual(["b"])
    expect(groupInstalledPlugins([plugin("broken")]).roots.map((p) => p.id)).toEqual(["broken"])
  })
})
