/**
 * Unit tests for the hook-scope policy: filterScopedHooks() drives the
 * scoping rules without touching storage. Covers all branches of the
 * plugin-id / skill-path / skill-name resolution matrix.
 *
 * Run:
 *   npx tsx tests/hook-scope.spec.ts
 */

import {
  createHookScope,
  createInheritedHookScope,
  extractPluginIdFromProviderKey,
  filterScopedHooks,
  mergeHookScopeSnapshot,
  type ScopedHookCandidates
} from "../src/main/hooks/scope.ts"
import type { HookContext } from "../src/main/hooks/runner.ts"
import type { HookConfig } from "../src/main/hooks/types.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function makeHook(
  partial: Partial<HookConfig> & Pick<HookConfig, "event" | "command"> & { id: string }
): HookConfig {
  return {
    enabled: true,
    type: "command",
    timeout: 8000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial
  } as HookConfig
}

function emptyContext(): HookContext {
  return { toolName: "test_tool" }
}

function emptyCandidates(): ScopedHookCandidates {
  return { baseHooks: [], pluginHooks: [], skillHooks: [] }
}

async function testNoScopeReturnsBaseOnly(): Promise<void> {
  const base = makeHook({ id: "base-1", event: "PreToolUse", command: "echo base" })
  const plugin = makeHook({ id: "p-1", event: "PreToolUse", command: "echo p" }) as HookConfig & {
    pluginId: string
  }
  ;(plugin as { pluginId: string }).pluginId = "plugin-a"
  const result = filterScopedHooks(
    { baseHooks: [base], pluginHooks: [plugin], skillHooks: [] },
    emptyContext(),
    undefined
  )
  assert(result.length === 1, `expected only base hook, got ${result.length}`)
  assert(result[0].id === "base-1", `expected base hook, got ${result[0].id}`)
}

async function testPluginHookRequiresActivation(): Promise<void> {
  const plugin = {
    ...makeHook({ id: "p-1", event: "PreToolUse", command: "echo p" }),
    pluginId: "plugin-a"
  } as HookConfig & { pluginId: string }
  const scope = createHookScope()

  // Not activated → no plugin hooks
  const before = filterScopedHooks(
    { baseHooks: [], pluginHooks: [plugin], skillHooks: [] },
    emptyContext(),
    scope
  )
  assert(before.length === 0, `inactive plugin should yield no hooks, got ${before.length}`)

  // After activation → plugin hook becomes visible
  scope.activatePlugin("plugin-a")
  const after = filterScopedHooks(
    { baseHooks: [], pluginHooks: [plugin], skillHooks: [] },
    emptyContext(),
    scope
  )
  assert(after.length === 1, `activated plugin should yield its hook, got ${after.length}`)
}

async function testPluginScopeFromContextProviderKey(): Promise<void> {
  const plugin = {
    ...makeHook({ id: "p-1", event: "PreToolUse", command: "echo p" }),
    pluginId: "plugin-a"
  } as HookConfig & { pluginId: string }
  const scope = createHookScope()
  // No prior activation, but the context carries the plugin id (the typical
  // path where the current MCP-tool call originates from a plugin).
  const ctx: HookContext = { toolName: "tool", pluginId: "plugin-a" }
  const result = filterScopedHooks(
    { baseHooks: [], pluginHooks: [plugin], skillHooks: [] },
    ctx,
    scope
  )
  assert(result.length === 1, `context.pluginId should pull in matching plugin hooks, got ${result.length}`)
}

async function testPluginSkillHookRequiresBothPluginAndPathMatch(): Promise<void> {
  const skillRoot = "C:/skills/plugin-a/pdf"
  const pluginSkillHook = {
    ...makeHook({ id: "ps-1", event: "PreToolUse", command: "echo ps" }),
    pluginId: "plugin-a",
    skillName: "pdf",
    skillPath: skillRoot
  } as HookConfig & { pluginId: string; skillName: string; skillPath: string }

  const scope = createHookScope()
  scope.activatePlugin("plugin-a")
  // Path NOT activated → plugin-skill hook still rejected.
  const noPath = filterScopedHooks(
    { baseHooks: [], pluginHooks: [], skillHooks: [pluginSkillHook] },
    emptyContext(),
    scope
  )
  assert(noPath.length === 0, `plugin skill hook needs path match, got ${noPath.length}`)

  // Activate path (different plugin) → plugin-skill hook still rejected because plugin id differs.
  const otherScope = createHookScope()
  otherScope.activatePlugin("plugin-b")
  otherScope.activateSkill("pdf", "plugin-b", skillRoot)
  const wrongPlugin = filterScopedHooks(
    { baseHooks: [], pluginHooks: [], skillHooks: [pluginSkillHook] },
    emptyContext(),
    otherScope
  )
  assert(wrongPlugin.length === 0, `plugin skill hook should not fire under another plugin's scope, got ${wrongPlugin.length}`)

  // Both plugin id + path match → fires.
  scope.activateSkill("pdf", "plugin-a", skillRoot)
  const both = filterScopedHooks(
    { baseHooks: [], pluginHooks: [], skillHooks: [pluginSkillHook] },
    emptyContext(),
    scope
  )
  assert(both.length === 1, `plugin+path match should fire the hook, got ${both.length}`)
}

async function testStandaloneSkillHookByPath(): Promise<void> {
  const skillRoot = "C:/skills/local/pdf"
  const standaloneHook = {
    ...makeHook({ id: "s-1", event: "PreToolUse", command: "echo s" }),
    skillName: "pdf",
    skillPath: skillRoot
  } as HookConfig & { skillName: string; skillPath: string }

  const scope = createHookScope()
  scope.activateSkill("pdf", undefined, skillRoot)
  const result = filterScopedHooks(
    { baseHooks: [], pluginHooks: [], skillHooks: [standaloneHook] },
    emptyContext(),
    scope
  )
  assert(result.length === 1, `standalone skill hook with matching path should fire, got ${result.length}`)
}

async function testStandaloneSkillHookNameOnlyFallback(): Promise<void> {
  // A name-only hook (no skillPath) — only allowed when the run has no path scope.
  const nameOnlyHook = {
    ...makeHook({ id: "n-1", event: "PreToolUse", command: "echo n" }),
    skillName: "shared-name"
  } as HookConfig & { skillName: string }

  const scope = createHookScope()
  scope.activateSkill("shared-name") // no path
  const allowed = filterScopedHooks(
    { baseHooks: [], pluginHooks: [], skillHooks: [nameOnlyHook] },
    emptyContext(),
    scope
  )
  assert(allowed.length === 1, `name-only hook should fire when run has no path scope, got ${allowed.length}`)

  // Add a path activation for some other skill → name-only hook now suppressed.
  scope.activateSkill(undefined, undefined, "C:/skills/other")
  const suppressed = filterScopedHooks(
    { baseHooks: [], pluginHooks: [], skillHooks: [nameOnlyHook] },
    emptyContext(),
    scope
  )
  assert(suppressed.length === 0, `name-only hook should be suppressed once a path scope is active, got ${suppressed.length}`)
}

async function testSkillContextActivatesViaContextSkillPath(): Promise<void> {
  const skillRoot = "C:/skills/local/pdf"
  const standaloneHook = {
    ...makeHook({ id: "s-1", event: "PreSkillUse", command: "echo s" }),
    skillName: "pdf",
    skillPath: skillRoot
  } as HookConfig & { skillName: string; skillPath: string }

  const scope = createHookScope() // empty
  // Context carries skillPath (typical PreSkillUse / PostSkillUse case).
  const ctx: HookContext = { toolName: "skill_select", skillName: "pdf", skillPath: skillRoot }
  const result = filterScopedHooks(
    { baseHooks: [], pluginHooks: [], skillHooks: [standaloneHook] },
    ctx,
    scope
  )
  assert(result.length === 1, `context.skillPath should pull in matching skill hooks, got ${result.length}`)
}

async function testBaseHooksAlwaysIncluded(): Promise<void> {
  const base = makeHook({ id: "b-1", event: "PreToolUse", command: "echo b" })
  const scope = createHookScope() // no activations
  const result = filterScopedHooks(
    { baseHooks: [base], pluginHooks: [], skillHooks: [] },
    emptyContext(),
    scope
  )
  assert(result.length === 1, `base hooks should always pass through, got ${result.length}`)
  assert(result[0].id === "b-1", `expected base hook, got ${result[0].id}`)
}

async function testExtractPluginIdFromProviderKey(): Promise<void> {
  assert(
    extractPluginIdFromProviderKey("plugin:my-plugin/server-1") === "my-plugin",
    "plugin id should be extracted up to the first slash"
  )
  assert(
    extractPluginIdFromProviderKey("plugin:my-plugin") === "my-plugin",
    "plugin id without slash should still work"
  )
  assert(
    extractPluginIdFromProviderKey("system:builtin") === undefined,
    "non-plugin provider key should return undefined"
  )
  assert(
    extractPluginIdFromProviderKey(undefined) === undefined,
    "undefined input should return undefined"
  )
  assert(
    extractPluginIdFromProviderKey("plugin:") === undefined,
    "empty plugin id should return undefined"
  )
  assert(
    extractPluginIdFromProviderKey("plugin:  spaced  /server") === "spaced",
    "plugin id should be trimmed"
  )
}

async function testMergeHookScopeSnapshotIsAdditive(): Promise<void> {
  const target = createHookScope()
  target.activatePlugin("plugin-a")
  target.activateSkill("first", undefined, "C:/skills/first")

  mergeHookScopeSnapshot(target, {
    activePluginIds: ["plugin-b"],
    activeSkillNames: ["second"],
    activeSkillPaths: ["C:/skills/second"]
  })

  assert(target.activePluginIds.has("plugin-a"), "merge should keep prior plugin id")
  assert(target.activePluginIds.has("plugin-b"), "merge should add new plugin id")
  assert(target.activeSkillNames.has("first"), "merge should keep prior skill name")
  assert(target.activeSkillNames.has("second"), "merge should add new skill name")
  const expectedFirst =
    process.platform === "win32" ? "c:/skills/first" : "C:/skills/first"
  const expectedSecond =
    process.platform === "win32" ? "c:/skills/second" : "C:/skills/second"
  assert(target.activeSkillPaths.has(expectedFirst), "merge should keep prior path")
  assert(target.activeSkillPaths.has(expectedSecond), "merge should add new path")
}

async function testInheritedHookScopeMirrorsCoordinatorIntoWorker(): Promise<void> {
  // Models the coordinator → worker spawn: the coordinator has activated a
  // plugin, and the worker must see that plugin's hooks (scope inheritance)
  // without being able to mutate the coordinator's scope (isolation).
  const coordinator = createHookScope()
  coordinator.activatePlugin("plugin-a")

  const pluginHook = {
    ...makeHook({
      id: "plugin-a-edit",
      event: "PreToolUse",
      matcher: "edit_file",
      command: "echo plugin-a"
    }),
    pluginId: "plugin-a"
  } as HookConfig & { pluginId: string }

  const worker = createInheritedHookScope(coordinator)

  // Inheritance: the worker scope sees the coordinator's active plugin, so the
  // plugin's edit_file hook passes the scope filter inside the worker.
  const inWorker = filterScopedHooks(
    { baseHooks: [], pluginHooks: [pluginHook], skillHooks: [] },
    { toolName: "edit_file" },
    worker
  )
  assert(
    inWorker.length === 1 && inWorker[0].id === "plugin-a-edit",
    `worker should inherit coordinator's plugin scope, got ${inWorker.map((h) => h.id).join(",") || "none"}`
  )

  // Isolation 1: a worker-side activation must not leak back to the coordinator.
  worker.activatePlugin("plugin-b")
  assert(
    !coordinator.activePluginIds.has("plugin-b"),
    "worker activation must not leak back into coordinator scope"
  )

  // Isolation 2: snapshot is point-in-time — a coordinator activation made
  // after the worker spawned must not retroactively appear in the worker.
  coordinator.activatePlugin("plugin-c")
  assert(
    !worker.activePluginIds.has("plugin-c"),
    "post-spawn coordinator activation must not appear in the worker snapshot"
  )
}

async function testPruneActivationsDropsUnkeptScope(): Promise<void> {
  const scope = createHookScope()
  scope.activatePlugin("plugin-a")
  scope.activatePlugin("plugin-b")
  scope.activateSkill("keep-name", undefined, "C:/skills/keep")
  scope.activateSkill("drop-name", undefined, "C:/skills/drop")

  scope.pruneActivations({
    keepPluginId: (id) => id === "plugin-a",
    keepSkillPath: (skillPath) => skillPath.endsWith("/keep"),
    keepSkillName: (skillName) => skillName === "keep-name"
  })

  assert(scope.activePluginIds.has("plugin-a"), "kept plugin should remain")
  assert(!scope.activePluginIds.has("plugin-b"), "unkept plugin should be pruned")
  assert(scope.activeSkillPaths.has("c:/skills/keep") || scope.activeSkillPaths.has("C:/skills/keep"), "kept skill path should remain")
  assert(!scope.activeSkillPaths.has("c:/skills/drop") && !scope.activeSkillPaths.has("C:/skills/drop"), "unkept skill path should be pruned")
  assert(scope.activeSkillNames.has("keep-name"), "kept skill name should remain")
  assert(!scope.activeSkillNames.has("drop-name"), "unkept skill name should be pruned")
}

async function testPersistentHookIdFiresWithoutCurrentSkillScope(): Promise<void> {
  const skillRoot = "C:/skills/persistent"
  const persistent = {
    ...makeHook({
      id: "persistent-hook",
      event: "PreToolUse",
      matcher: "write_file",
      command: "echo persistent",
      persistAfterInterrupt: true
    }),
    skillName: "persistent",
    skillPath: skillRoot
  } as HookConfig & { skillName: string; skillPath: string }
  const ephemeral = {
    ...makeHook({
      id: "ephemeral-hook",
      event: "PreToolUse",
      matcher: "write_file",
      command: "echo ephemeral"
    }),
    skillName: "persistent",
    skillPath: skillRoot
  } as HookConfig & { skillName: string; skillPath: string }

  const scope = createHookScope()
  scope.activatePersistentHooks([persistent])

  const result = filterScopedHooks(
    { baseHooks: [], pluginHooks: [], skillHooks: [persistent, ephemeral] },
    emptyContext(),
    scope
  )

  assert(result.length === 1, `expected only persistent hook, got ${result.length}`)
  assert(result[0].id === "persistent-hook", `expected persistent hook, got ${result[0].id}`)
}

async function testPersistentHookKeyDoesNotLeakAcrossSameIdSkills(): Promise<void> {
  const activated = {
    ...makeHook({
      id: "same-id",
      event: "PreToolUse",
      matcher: "write_file",
      command: "echo activated",
      persistAfterInterrupt: true
    }),
    skillName: "shared",
    skillPath: "C:/skills/activated",
    hookSourceType: "skill",
    hookSourceRoot: "C:/skills/activated",
    hookSourcePath: "C:/skills/activated/hooks/hooks.json"
  } as HookConfig & { skillName: string; skillPath: string }
  const other = {
    ...makeHook({
      id: "same-id",
      event: "PreToolUse",
      matcher: "write_file",
      command: "echo other",
      persistAfterInterrupt: true
    }),
    skillName: "shared",
    skillPath: "C:/skills/other",
    hookSourceType: "skill",
    hookSourceRoot: "C:/skills/other",
    hookSourcePath: "C:/skills/other/hooks/hooks.json"
  } as HookConfig & { skillName: string; skillPath: string }

  const scope = createHookScope()
  scope.activatePersistentHooks([activated])
  const result = filterScopedHooks(
    { baseHooks: [], pluginHooks: [], skillHooks: [activated, other] },
    emptyContext(),
    scope
  )

  assert(result.length === 1, `expected only activated hook, got ${result.length}`)
  assert(result[0].hookSourceRoot === "C:/skills/activated", "persistent hook key should include source")
}

async function testSkippedDiagnosticsOnlyReportRunnableHooks(): Promise<void> {
  const runnable = {
    ...makeHook({
      id: "runnable",
      event: "PreToolUse",
      matcher: "test_tool",
      command: "echo runnable"
    }),
    pluginId: "plugin-a"
  } as HookConfig & { pluginId: string }
  const wrongEvent = {
    ...makeHook({
      id: "wrong-event",
      event: "PostToolUse",
      matcher: "test_tool",
      command: "echo wrong-event"
    }),
    pluginId: "plugin-a"
  } as HookConfig & { pluginId: string }
  const wrongMatcher = {
    ...makeHook({
      id: "wrong-matcher",
      event: "PreToolUse",
      matcher: "other_tool",
      command: "echo wrong-matcher"
    }),
    pluginId: "plugin-a"
  } as HookConfig & { pluginId: string }
  const disabled = {
    ...makeHook({
      id: "disabled",
      event: "PreToolUse",
      matcher: "test_tool",
      command: "echo disabled",
      enabled: false
    }),
    pluginId: "plugin-a"
  } as HookConfig & { pluginId: string }

  const skippedIds: string[] = []
  const result = filterScopedHooks(
    { baseHooks: [], pluginHooks: [runnable, wrongEvent, wrongMatcher, disabled], skillHooks: [] },
    emptyContext(),
    createHookScope(),
    (hook) => skippedIds.push(hook.id),
    "PreToolUse"
  )

  assert(result.length === 0, `inactive plugin hooks should not pass scope, got ${result.length}`)
  assert(
    skippedIds.join(",") === "runnable",
    `expected only runnable hook to be reported skipped, got ${skippedIds.join(",")}`
  )
}

async function testEmptyCandidatesProduceEmptyResult(): Promise<void> {
  const scope = createHookScope()
  scope.activatePlugin("plugin-a")
  scope.activateSkill("pdf", "plugin-a", "C:/skills/pdf")
  const result = filterScopedHooks(emptyCandidates(), emptyContext(), scope)
  assert(result.length === 0, `no candidates → empty result, got ${result.length}`)
}

async function run(): Promise<void> {
  await testNoScopeReturnsBaseOnly()
  console.log("PASS S1 no scope returns base hooks only")
  await testPluginHookRequiresActivation()
  console.log("PASS S2 plugin hook requires activation")
  await testPluginScopeFromContextProviderKey()
  console.log("PASS S3 plugin id flows from context.pluginId")
  await testPluginSkillHookRequiresBothPluginAndPathMatch()
  console.log("PASS S4 plugin-owned skill hook needs plugin id AND path")
  await testStandaloneSkillHookByPath()
  console.log("PASS S5 standalone skill hook fires on path match")
  await testStandaloneSkillHookNameOnlyFallback()
  console.log("PASS S6 name-only fallback only when no path scope is active")
  await testSkillContextActivatesViaContextSkillPath()
  console.log("PASS S7 context.skillPath activates the matching hook for this call")
  await testBaseHooksAlwaysIncluded()
  console.log("PASS S8 base hooks always pass scope filter")
  await testExtractPluginIdFromProviderKey()
  console.log("PASS S9 extractPluginIdFromProviderKey edge cases")
  await testMergeHookScopeSnapshotIsAdditive()
  console.log("PASS S10 mergeHookScopeSnapshot adds without dropping prior state")
  await testInheritedHookScopeMirrorsCoordinatorIntoWorker()
  console.log("PASS S10a createInheritedHookScope inherits coordinator scope, isolates worker")
  await testPruneActivationsDropsUnkeptScope()
  console.log("PASS S10b pruneActivations drops unkept plugin / skill scope")
  await testPersistentHookIdFiresWithoutCurrentSkillScope()
  console.log("PASS S10c persistent hook id fires without current skill scope")
  await testPersistentHookKeyDoesNotLeakAcrossSameIdSkills()
  console.log("PASS S10d persistent hook key does not leak across same-id skills")
  await testSkippedDiagnosticsOnlyReportRunnableHooks()
  console.log("PASS S10e skipped diagnostics only report runnable hooks")
  await testEmptyCandidatesProduceEmptyResult()
  console.log("PASS S11 empty candidates yield empty result regardless of scope")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
