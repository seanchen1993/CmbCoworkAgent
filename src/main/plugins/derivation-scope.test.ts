import { afterEach, expect, it, vi } from "vitest"
vi.mock("../storage", () => ({
  getEnabledPluginHookMetadata: () => [],
  getEnabledSkillHookMetadata: () => [],
  getEnabledHooks: () => [],
  getEnabledPluginSkillSourceMetadata: () => []
}))
vi.mock("../hooks/runner", () => ({ hookMatchesRunCriteria: () => true }))
import { setDerivationFamilies, derivationVisibility } from "./derivation-scope"
import { isSkillVisibleForProjectMode } from "../../shared/skill-visibility"
import { createHookScope, createInheritedHookScope, filterScopedHooks } from "../hooks/scope"
import type { HookConfig } from "../hooks/types"
import type { HookContext } from "../hooks/runner"

afterEach(() => setDerivationFamilies([]))
const family = () =>
  setDerivationFamilies([
    { familyId: "family", originalId: "original", members: ["original", "derived", "sibling"] }
  ])
it("requires explicit binding for descendants while preserving original unbound behavior", () => {
  family()
  const visible = (id: string, bound?: string) =>
    isSkillVisibleForProjectMode(
      {
        pluginId: id,
        ...derivationVisibility(id)
      },
      { projectMode: !!bound, boundPluginId: bound }
    )
  expect(visible("derived")).toBe(false)
  expect(visible("original")).toBe(true)
  expect(visible("original", "derived")).toBe(false)
  expect(visible("sibling", "derived")).toBe(false)
  expect(visible("derived", "derived")).toBe(true)
  expect(visible("unrelated", "derived")).toBe(true)
})
it("filters all family plugin and skill hooks before persistence and freezes inherited binding", () => {
  family()
  const hooks = ["original", "derived", "sibling"].map(
    (pluginId) =>
      ({
        id: pluginId,
        pluginId,
        event: "SessionEnd",
        type: "command",
        command: "echo test",
        enabled: true,
        persistAfterInterrupt: true,
        createdAt: "",
        updatedAt: ""
      }) as HookConfig & { pluginId: string }
  )
  const scope = createHookScope()
  hooks.forEach((hook) => scope.activatePlugin(hook.pluginId))
  scope.activatePersistentHooks(hooks)
  const context = { harnessProjectId: "project", harnessAdapterId: "derived" } as HookContext
  const candidates = { baseHooks: [], pluginHooks: hooks, skillHooks: [] }
  expect(filterScopedHooks(candidates, context, scope).map((hook) => hook.id)).toEqual(["derived"])
  const child = createInheritedHookScope(scope)
  expect(
    filterScopedHooks(candidates, { ...context, harnessAdapterId: "original" }, child).map(
      (hook) => hook.id
    )
  ).toEqual(["derived"])
})
