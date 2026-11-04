import { expect, it } from "vitest"
import type { PluginMetadata } from "@/types"
import { chatPluginCandidates } from "./chat-plugin-candidates"

it("offers enabled and disabled chat plugins while excluding both project formats and dependencies", () => {
  const plugins = [
    { id: "chat", enabled: true },
    { id: "disabled", enabled: false },
    { id: "legacy", hasProjectMode: true },
    { id: "host", projectDependencyIds: ["child"] },
    { id: "empty-host", projectDependencyIds: [] },
    { id: "child" },
    { id: "orphan", dependencyOnly: true }
  ] as PluginMetadata[]
  expect(chatPluginCandidates(plugins).map((plugin) => plugin.id)).toEqual(["chat", "disabled"])
})

it("excludes a project-only component provider even without a project template", () => {
  const plugins = [{ id: "project-only" }, { id: "mixed" }] as PluginMetadata[]
  const component = {
    id: "project",
    name: "Stage",
    kind: "module" as const,
    entry: "stage.ts",
    dependsOn: [],
    actionIds: [],
    usage: "project" as const
  }
  expect(
    chatPluginCandidates(plugins, [
      {
        pluginId: "project-only",
        name: "only",
        state: "ready",
        capabilities: [],
        components: [component]
      },
      {
        pluginId: "mixed",
        name: "mixed",
        state: "ready",
        capabilities: [],
        components: [component, { ...component, id: "chat", usage: "chat" }]
      }
    ]).map((plugin) => plugin.id)
  ).toEqual(["mixed"])
})
