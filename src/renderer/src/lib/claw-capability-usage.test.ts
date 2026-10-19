import { describe, expect, it } from "vitest"
import {
  hasUsableClawComponents,
  newClawCapability,
  usableClawComponents
} from "./claw-capability-usage"
import type { ClawComponentExport } from "../../../shared/mods/claw-components"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"

const entries: ClawComponentExport[] = [
  { id: "base", name: "Base", kind: "module", entry: "base.ts", dependsOn: [], actionIds: [] },
  {
    id: "chat",
    name: "Chat",
    kind: "module",
    entry: "chat.ts",
    dependsOn: ["base"],
    actionIds: [],
    usage: "chat"
  },
  {
    id: "project",
    name: "Project",
    kind: "module",
    entry: "project.ts",
    dependsOn: ["base"],
    actionIds: [],
    usage: "project"
  },
  {
    id: "dependent",
    name: "Dependent",
    kind: "module",
    entry: "dependent.ts",
    dependsOn: ["project"],
    actionIds: []
  }
]
const source = (components?: ClawComponentExport[]): FunctionPluginStatus => ({
  pluginId: "source",
  name: "Source",
  digest: "a".repeat(64),
  state: "ready",
  capabilities: [],
  components
})

describe("component choices in the current scene", () => {
  it("uses an exact, dependency-compatible selection without changing the catalog", () => {
    expect(newClawCapability(source(entries), "chat").components).toEqual({
      mode: "selected",
      ids: ["base", "chat"],
      config: {}
    })
    expect(usableClawComponents(entries, "project").map((entry) => entry.id)).toEqual([
      "base",
      "project",
      "dependent"
    ])
    expect(entries).toHaveLength(4)
  })
  it("keeps legacy packages whole and prevents empty or cyclic choices", () => {
    expect(newClawCapability(source(), "chat")).not.toHaveProperty("components")
    expect(hasUsableClawComponents(source([entries[2]]), "chat")).toBe(false)
    expect(() => newClawCapability(source([entries[2]]), "chat")).toThrow("没有适用")
    expect(usableClawComponents([{ ...entries[0], dependsOn: ["base"] }], "chat")).toEqual([])
  })
})
