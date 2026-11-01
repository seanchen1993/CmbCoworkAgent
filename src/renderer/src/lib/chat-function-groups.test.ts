import { expect, it } from "vitest"
import type { PluginMetadata } from "@/types"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import { chatFunctionGroups } from "./chat-function-groups"

const plugin = (id: string, dependencies?: string[]) =>
  ({
    id,
    name: id,
    ...(dependencies ? { projectDependencyIds: dependencies } : {})
  }) as PluginMetadata
const source = (pluginId: string): FunctionPluginStatus => ({
  pluginId,
  name: pluginId,
  state: "ready",
  capabilities: [],
  digest: "a".repeat(64)
})

it("attributes shared project dependencies without changing eligible sources or requiring execution", () => {
  const sources = [source("delivery"), source("weather")]
  const result = chatFunctionGroups(sources, [
    plugin("project-a", ["delivery"]),
    plugin("project-b", ["delivery"]),
    plugin("delivery"),
    plugin("weather")
  ])
  expect(result.available).toEqual([sources[1]])
  expect(result.dependencies).toEqual([
    { source: sources[0], projects: ["project-a", "project-b"] }
  ])
  expect(result.dependencies[0].source).toBe(sources[0])
  expect(sources).toHaveLength(2)
})

it("keeps independent projects, orphaned components and unknown installations reachable", () => {
  const sources = [source("project-b"), source("orphan"), source("unknown")]
  expect(
    chatFunctionGroups(sources, [
      plugin("project-a", ["project-b", "missing"]),
      plugin("project-b", []),
      plugin("orphan")
    ])
  ).toEqual({ available: sources, dependencies: [] })
})
