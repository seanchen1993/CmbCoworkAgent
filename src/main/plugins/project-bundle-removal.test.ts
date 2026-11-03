import { expect, it } from "vitest"
import type { PluginMetadata } from "../types"
import { projectBundleRemovalIds } from "./project-bundle-removal"

const plugin = (id: string, dependencyOnly?: boolean) => ({ id, dependencyOnly }) as PluginMetadata

it("removes exclusive source-set components, including legacy unmarked bundle components", () => {
  expect(
    projectBundleRemovalIds(
      "project",
      [plugin("project"), plugin("rules", true), plugin("old")],
      new Map([["project", ["rules", "old", "rules", "project"]]])
    )
  ).toEqual(["project", "rules", "old"])
})

it("preserves independently installed, shared and project packages", () => {
  const installed = [
    plugin("project"),
    plugin("direct", false),
    plugin("shared", true),
    plugin("other")
  ]
  const references = new Map([
    ["project", ["direct", "shared", "other"]],
    ["other", ["shared"]]
  ])
  expect(projectBundleRemovalIds("project", installed, references)).toEqual(["project"])
  expect(() => projectBundleRemovalIds("shared", installed, references)).toThrow("其他项目插件")
})

it("does not discover or delete unrelated packages by name", () => {
  expect(
    projectBundleRemovalIds("project", [plugin("project"), plugin("similar-name", true)], new Map())
  ).toEqual(["project"])
})
