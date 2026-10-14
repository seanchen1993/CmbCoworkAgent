import { expect, it } from "vitest"
import { ClawStore } from "./claw-store"
import { resolveClawThread } from "./claw-scope"
import { parseClawProfile } from "../../shared/mods/claw"
import { flowDigest } from "./flows/store"
import type { ClawProfile } from "../../shared/mods/claw"
import type { FlowDefinition } from "../../shared/mods/flows/types"

const definition: FlowDefinition = {
  schemaVersion: 1,
  id: "pipeline",
  name: "Pipeline",
  plugin: "a",
  goal: "Do work",
  timeoutMs: 1000,
  maxExecutions: 3,
  steps: [{ id: "verify", kind: "approval", name: "Verify", enabled: true, prompt: "Confirm" }]
}
const profile: ClawProfile = {
  id: "p",
  name: "My Claw",
  capabilities: [],
  models: { default: "provider::main", roles: { review: "provider::review" } },
  flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 }
}
function fixture() {
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    setSetting: (key: string, value: string) => {
      values.set(key, value)
    }
  }
  return { settings, store: new ClawStore(settings) }
}
it("binds whole snapshots per thread incarnation without mutating the legacy project selection", () => {
  const { store, settings } = fixture()
  store.write("ws", { revision: 0, profiles: [profile], active: null }, 0)
  const first = JSON.stringify(["thread-a", "generation-1"])
  const second = JSON.stringify(["thread-b", "generation-1"])
  store.apply("ws", first, profile, 1)
  store.apply("ws", second, { ...profile, models: { default: "other", roles: {} } }, 2)
  const template = store.read("ws")
  template.profiles[0].models!.default = "edited-template"
  template.profiles[0].flow!.definition.name = "edited-flow"
  store.write("ws", template, 3)
  const reloaded = new ClawStore(settings)
  expect(reloaded.selection("ws", first).profile?.models?.default).toBe("provider::main")
  expect(reloaded.selection("ws", first).profile?.flow?.definition.name).toBe("Pipeline")
  expect(reloaded.selection("ws", second).profile?.models?.default).toBe("other")
  expect(reloaded.read("ws").active).toBeNull()
  expect(reloaded.selection("ws", JSON.stringify(["thread-a", "generation-2"])).profile).toBeNull()
  expect(() => reloaded.apply("ws", first, null, 3)).toThrow("已变化")
})
it("resolves internal flow children to the exact parent identity and rejects foreign roots", () => {
  const rows: Record<string, { metadata: object }> = {
    parent: { metadata: { workspacePath: "a", cmb_thread_incarnation: "inc-1" } },
    child: {
      metadata: { workspacePath: "a", parentThreadId: "parent", isInternalFlowRuntime: true }
    },
    harness: { metadata: { workspacePath: "a", harnessProjectId: "project" } }
  }
  const read = (id: string) => rows[id] ?? null
  expect(resolveClawThread("child", read)).toEqual({
    threadId: "parent",
    identity: '["parent","inc-1"]'
  })
  expect(resolveClawThread("harness", read)).toBeNull()
  rows.parent.metadata = { workspacePath: "other", cmb_thread_incarnation: "inc-1" }
  expect(() => resolveClawThread("child", read)).toThrow("CLAW_PARENT_SCOPE_INVALID")
})
it("preserves structured bindings but rejects malformed roles and flow versions", () => {
  expect(parseClawProfile(profile)).toEqual(profile)
  for (const models of [
    null,
    { roles: [] },
    { roles: { constructor: "x" } },
    { roles: { review: "" } },
    { default: "", roles: {} }
  ])
    expect(() => parseClawProfile({ ...profile, models })).toThrow()
  expect(() => parseClawProfile({ ...profile, flow: { ...profile.flow, digest: "bad" } })).toThrow()
})
