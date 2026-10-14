import { afterEach, expect, it, vi } from "vitest"
import type { HookConfig } from "./types"
const state = vi.hoisted(() => ({ run: vi.fn(async () => []), hooks: [] as HookConfig[] }))
vi.mock("./runner", () => ({
  runHooks: state.run,
  clearOnceStateForSession: vi.fn(),
  hookMatchesRunCriteria: () => true
}))
vi.mock("../storage", () => ({
  getEnabledPluginHookMetadata: () => state.hooks,
  getEnabledSkillHookMetadata: () => [],
  getEnabledHooks: () => [],
  getEnabledPluginSkillSourceMetadata: () => []
}))
vi.mock("../services/setup-state", () => ({
  hasWorkspaceBeenInitialised: () => true,
  markWorkspaceInitialised: vi.fn()
}))
import { fireSessionStartOnce, fireSessionEnd, fireSessionEndAll } from "./session-lifecycle"
import { createHookScope } from "./scope"
import { setDerivationFamilies } from "../plugins/derivation-scope"
import { currentRuntimePluginSource } from "../plugins/runtime-source-scope"

afterEach(async () => {
  await fireSessionEndAll(50)
  setDerivationFamilies([])
  state.hooks = []
  vi.clearAllMocks()
})
function fixture() {
  setDerivationFamilies([{ familyId: "f", originalId: "original", members: ["original", "copy"] }])
  state.hooks = ["original", "copy"].map((pluginId) => ({
    id: pluginId,
    pluginId,
    event: "SessionEnd",
    enabled: true,
    type: "command",
    command: "fixture",
    persistAfterInterrupt: true,
    createdAt: "",
    updatedAt: ""
  }))
  const scope = createHookScope()
  scope.activatePlugin("original")
  scope.activatePlugin("copy")
  scope.activatePersistentHooks(state.hooks)
  const context = {
    harnessAdapterId: "copy",
    harnessProjectId: "new-project",
    featureId: "feature",
    pluginWorkspace: "C:/new-parent",
    projectDir: "new-project",
    projectCode: "new-code"
  }
  const start = (overrides = {}) =>
    fireSessionStartOnce(
      "native",
      "C:/new-workspace",
      undefined,
      scope,
      undefined,
      undefined,
      "C:/new-output",
      "system",
      { ...context, ...overrides }
    )
  return { start, scope }
}
it("native SessionEnd keeps original paths and only bound Hooks despite delete-time UI overrides", async () => {
  const f = fixture()
  expect(currentRuntimePluginSource()).toBeUndefined()
  await f.start()
  await fireSessionEnd("native", "C:/wrong-workspace", undefined, "C:/wrong-output")
  const end = state.run.mock.calls.find(
    (call) => (call as unknown[])[1] === "SessionEnd"
  ) as unknown[]
  expect((end[0] as HookConfig[]).map((hook) => hook.id)).toEqual(["copy"])
  expect(end[2]).toMatchObject({
    workspacePath: "C:/new-workspace",
    pluginOutputDir: "C:/new-output",
    pluginWorkspace: "C:/new-parent",
    projectDir: "new-project",
    harnessAdapterId: "copy"
  })
})
it("native subsequent starts reject a changed project environment, and shutdown retains the original", async () => {
  const f = fixture()
  await f.start()
  await expect(f.start({ pluginWorkspace: "C:/other-parent" })).rejects.toThrow("绑定或目录")
  await expect(f.start({ projectDir: "other-project" })).rejects.toThrow("绑定或目录")
  await fireSessionEndAll(50)
  const end = state.run.mock.calls.find(
    (call) => (call as unknown[])[1] === "SessionEnd"
  ) as unknown[]
  expect((end[0] as HookConfig[]).map((hook) => hook.id)).toEqual(["copy"])
  expect(end[2]).toMatchObject({ pluginWorkspace: "C:/new-parent", projectDir: "new-project" })
})
