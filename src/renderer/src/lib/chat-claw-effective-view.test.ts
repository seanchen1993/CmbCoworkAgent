import { expect, it } from "vitest"
import type { ClawProfile, ClawView } from "../../../shared/mods/claw"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import { chatClawEffectiveView } from "./chat-claw-effective-view"

const weather: FunctionPluginStatus = {
  pluginId: "weather",
  name: "weather",
  digest: "a".repeat(64),
  state: "ready",
  capabilities: [],
  userConfigFieldCount: 1
}
const replay: FunctionPluginStatus = {
  ...weather,
  pluginId: "replay",
  name: "replay",
  digest: "b".repeat(64)
}
const profile = (source: FunctionPluginStatus): ClawProfile => ({
  id: source.pluginId,
  name: source.name,
  capabilities: [{ pluginId: source.pluginId, name: source.name, digest: source.digest! }]
})
const view = (active: ClawProfile | null): ClawView => ({
  revision: 1,
  profiles: [],
  active,
  bindingRevision: 1,
  workspace: "project",
  enabled: true,
  applicable: true,
  usageContext: "chat",
  capabilities: [weather, replay],
  issues: []
})

it("isolates two session selections from the common authorized catalog", () => {
  expect(chatClawEffectiveView(view(profile(weather))).plugins.map((item) => item.name)).toEqual([
    "weather"
  ])
  expect(chatClawEffectiveView(view(profile(replay))).plugins.map((item) => item.name)).toEqual([
    "replay"
  ])
})
it("preserves default inheritance and distinguishes an explicit empty profile", () => {
  const inherited = chatClawEffectiveView(view(null))
  expect(inherited.state).toBe("inherited")
  expect(inherited.plugins).toEqual([weather, replay])
  const empty = chatClawEffectiveView(view({ id: "empty", name: "Empty", capabilities: [] }))
  expect(empty.state).toBe("selected")
  expect(empty.plugins).toEqual([])
})
it.each(["pluginId", "name", "digest", "state"] as const)(
  "rejects stale %s without falling back to other sources",
  (field) => {
    const input = view(profile(weather))
    input.capabilities = [
      { ...weather, [field]: field === "state" ? "disabled" : "changed" },
      replay
    ]
    const result = chatClawEffectiveView(input)
    expect(result.state).toBe("invalid")
    expect(result.selected).toBe(input.active)
    expect(result.plugins).toEqual([])
  }
)
it("honors main-owned issues even when the directory still appears ready", () => {
  const input = view(profile(weather))
  input.issues = ["mandatory policy changed"]
  expect(chatClawEffectiveView(input)).toMatchObject({
    state: "invalid",
    plugins: [],
    issues: input.issues
  })
})
it.each(["enabled", "applicable"] as const)(
  "shows no effective sources when %s is false",
  (field) => {
    const input = view(profile(weather))
    input[field] = false
    expect(chatClawEffectiveView(input)).toMatchObject({
      state: field === "enabled" ? "disabled" : "inapplicable",
      selected: input.active,
      plugins: []
    })
  }
)
it("uses component context for inheritance and validates explicit selections", () => {
  const input = view(null)
  const component = (id: string, usage: "chat" | "project") => ({
    id,
    name: id,
    kind: "module" as const,
    entry: `${id}.ts`,
    usage,
    dependsOn: [],
    actionIds: []
  })
  input.capabilities = [
    { ...weather, components: [component("chat", "chat"), component("stage", "project")] }
  ]
  expect(chatClawEffectiveView(input).plugins[0].components?.map((item) => item.id)).toEqual([
    "chat"
  ])
  input.active = profile(weather)
  expect(chatClawEffectiveView(input).state).toBe("invalid")
  input.active.capabilities[0].components = { mode: "selected", ids: ["chat"], config: {} }
  expect(chatClawEffectiveView(input).plugins[0].components?.map((item) => item.id)).toEqual([
    "chat"
  ])
  input.capabilities[0].components![0].dependsOn = ["stage"]
  expect(chatClawEffectiveView(input)).toMatchObject({ state: "invalid", plugins: [] })
})
