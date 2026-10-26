import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AIMessage } from "@langchain/core/messages"
import type { PluginHookMetadata, PluginMetadata } from "../types"
import type { RuntimePluginSourceBinding } from "../plugins/runtime-source-scope"

const registry = vi.hoisted(() => ({ plugins: [] as PluginMetadata[], skills: [] as PluginHookMetadata[] }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle: () => {} } }))
vi.mock("../storage", async importOriginal => {
  const original = await importOriginal<typeof import("../storage")>()
  const { projectRuntimePluginSources } = await import("../plugins/runtime-source-scope")
  return { ...original,
    getEnabledHooks: () => [], getEnabledSkillHookMetadata: () => registry.skills,
    getEnabledPluginSkillSourceMetadata: () => [],
    getEnabledPluginHookMetadata: () => projectRuntimePluginSources(registry.plugins)
      .filter(plugin => plugin.enabled).flatMap(plugin => original.parsePluginHooks(plugin)),
    getHookLoggingConfig: () => ({ diagnostic: false }), getUserInfo: () => undefined
  }
})
vi.mock("../mods/manager", async original => ({
  ...(await original<typeof import("../mods/manager")>()), getModsManager: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../services/setup-state", () => ({ hasWorkspaceBeenInitialised: () => true,
  markWorkspaceInitialised: vi.fn() }))
vi.mock("../services/subagent-session-capture", () => ({
  withSubagentSessionCapture: (_context: unknown, _label: string, run: () => Promise<unknown>) => run(),
  subagentSessionCallbacks: () => []
}))
import { parsePluginHooks } from "../storage"
import { issueRuntimePluginSourceToken, withRuntimePluginSource } from "../plugins/runtime-source-scope"
import { readRuntimeRequiredHooks } from "../plugins/runtime-required-hooks"
import { createHookScope, filterScopedHooks, resolveEnabledHooksForRun } from "./scope"
import { partitionRequiredBusinessHooks } from "./required-business-checks"
import { runHooks, type HookContext } from "./runner"
import { fireSessionStartOnce, fireSessionEndAll } from "./session-lifecycle"
import { runWorkflowSubagent } from "../agent/workflow/subagent"
import { LocalSandbox } from "../agent/local-sandbox"

let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "required-parent-scope-"))
  registry.plugins = []; registry.skills = []
})
afterEach(async () => {
  await fireSessionEndAll(1000)
  registry.plugins = []; registry.skills = []
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function metadata(path: string, id = "parent"): PluginMetadata {
  return { id, path, name: "same-friendly-name", version: "1.0.0", description: "", author: "",
    enabled: true, hookCount: 3, skillCount: 0, mcpServerCount: 0, createdAt: "", updatedAt: "" }
}
function plugin(id = "parent", marker = "ORIGINAL") {
  const path = join(root, `${id}-${marker}`)
  mkdirSync(join(path, "hooks"), { recursive: true })
  writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: "same-friendly-name", version: "1.0.0" }))
  const hook = (text: string) => ({ type: "command", command: `python -I -B -c "print('${marker}_${text}')"` })
  writeFileSync(join(path, "hooks/hooks.json"), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [hook("SESSION")] }],
    PreSkillUse: [{ hooks: [hook("SKILL")] }],
    PreToolUse: [{ hooks: [hook("TOOL")] }]
  } }))
  return metadata(path, id)
}
function binding(parent: PluginMetadata, extra: Partial<RuntimePluginSourceBinding> = {}): RuntimePluginSourceBinding {
  return { plugin: parent, mode: "legacy", capabilitySources: [], threadId: "native-stage",
    incarnationKey: "native-incarnation", projectId: "composition-legacy:run:warehouse",
    operationId: "native-operation", workspace: root, packageDigest: "a".repeat(64), stageId: "biz.prd",
    requiredHooks: ["PreSkillUse:0:0", "PreToolUse:0:0"], ...extra }
}
const context = (): HookContext => ({ sessionId: "native-stage", workspacePath: root,
  harnessProjectId: "composition-parent", harnessAdapterId: "composition-wrapper",
  featureId: "sample", skillName: "native-prd", toolName: "read_file", toolArgs: {} })

it.each(["allow", "content-block", "missing", "crash", "expired", "package-allow", "package-block", "package-edit-block"])(
  "enforces retained required hooks before a real workflow child writes physical bytes (%s)", async scenario => {
    const parent = plugin("native-parent"), workspace = join(root, "workspace")
    mkdirSync(workspace)
    const script = join(parent.path, "hooks", "guard.py")
    writeFileSync(script, [
      "import json, sys",
      "payload = json.load(sys.stdin)",
      scenario === "crash" ? "raise RuntimeError('guard failed')" :
        "print(json.dumps({'decision':'block','reason':'fixture forbidden content'}) if 'FORBIDDEN' in json.dumps(payload.get('tool_input', {})) else '{}')"
    ].join("\n"))
    writeFileSync(join(parent.path, "hooks/hooks.json"), JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: "write_file|edit_file", hooks: [{ type: "command",
        command: `python -I -B "${script}"` }] }]
    } }))
    writeFileSync(join(parent.path, "devclaw.capabilities.json"), JSON.stringify({
      apiVersion: "devclaw.capabilities/v1", capabilities: [{ id: "build", title: "Build",
        kind: "skill", usage: "project", entry: "skills/build/SKILL.md", dependsOn: [],
        requiredHooks: ["PreToolUse:0:0"] }]
    }))
    const actualPackage = scenario.startsWith("package-")
    if (actualPackage) {
      const resources = resolve("resources/native-compositions/autobiz")
      for (const file of ["devclaw.capabilities.json", "hooks/hooks.json", "hooks/check-secrets.py", "hooks/secret_rules.py"])
        writeFileSync(join(parent.path, file), readFileSync(join(resources, file)))
    }
    const requiredHooks = readRuntimeRequiredHooks(parent,
      { entry: actualPackage ? "skills/native-code/SKILL.md" : "skills/build/SKILL.md" })
    expect(requiredHooks).toEqual(["plugin:native-parent/PreToolUse:0:0"])
    expect(readRuntimeRequiredHooks(parent, { entry: "skills/other/SKILL.md" })).toEqual([])
    let live = true
    const token = issueRuntimePluginSourceToken(binding(parent, { mode: "host", workspace, requiredHooks }),
      undefined, () => { if (!live) throw Error("CHILD_SOURCE_EXPIRED") })
    if (scenario === "missing") writeFileSync(join(parent.path, "hooks/hooks.json"), '{"hooks":{}}')
    const target = join(workspace, actualPackage ? "child.properties" : "child.txt")
    if (scenario === "package-edit-block") writeFileSync(target, "password=${APP_PASSWORD}")
    const content = actualPackage
      ? scenario === "package-allow" ? "password=${APP_PASSWORD}" : "password=fixture-forbidden-value"
      : scenario === "content-block" ? "FORBIDDEN" : "approved bytes"
    let result: unknown
    const cleaned = vi.fn(async () => undefined)
    const run = withRuntimePluginSource(token, () => runWorkflowSubagent({
      parentThreadId: "native-stage", isRetryableApiError: () => false, cleanupThread: cleaned,
      createRuntime: async options => {
        expect(options.threadId).not.toBe("native-stage")
        const hookScope = createHookScope()
        const sandbox = new LocalSandbox({ rootDir: workspace, runId: options.threadId,
          agentId: options.agentId, windowsSandbox: "none", hookScope,
          hookResolver: (event, context) => resolveEnabledHooksForRun(workspace, event, context, hookScope) })
        return { stream: async () => (async function* () {
          if (scenario === "expired") live = false
          result = scenario === "package-edit-block"
            ? await sandbox.edit(target, "password=${APP_PASSWORD}", content)
            : await sandbox.write(target, content)
          yield ["values", { messages: [new AIMessage(JSON.stringify(result))] }]
        })() }
      }
    }, {
      prompt: "write through the native file backend", agentIndex: 0, label: "file-writer",
      runId: "required-hook-run", signal: new AbortController().signal, singleAttempt: true
    }))
    if (scenario === "missing" || scenario === "expired") await expect(run).rejects.toThrow()
    else await run
    expect(cleaned).toHaveBeenCalled()
    if (scenario === "allow" || scenario === "package-allow") expect(readFileSync(target, "utf8")).toBe(content)
    else if (scenario === "package-edit-block") expect(readFileSync(target, "utf8")).toBe("password=${APP_PASSWORD}")
    else expect(existsSync(target)).toBe(false)
    if (scenario === "content-block" || scenario === "crash" || scenario.endsWith("-block")) {
      expect(result).toHaveProperty("error")
      expect(JSON.stringify(result)).not.toContain("fixture-forbidden-value")
    }
  }
)

it("observes authority once for the synchronous initial scope projection and again on the next call", () => {
  const parent = plugin()
  let current = true
  const authority = vi.fn(() => { if (!current) throw Error("ORIGINAL_SOURCE_EXPIRED") })
  const token = issueRuntimePluginSourceToken(binding(parent), undefined, authority)
  withRuntimePluginSource(token, () => {
    authority.mockClear()
    const candidates = { baseHooks: [], pluginHooks: [], skillHooks: [] }
    expect(filterScopedHooks(candidates, context(), createHookScope())).toEqual([])
    expect(authority).toHaveBeenCalledTimes(1)
    current = false
    expect(() => filterScopedHooks(candidates, context(), createHookScope()))
      .toThrow("ORIGINAL_SOURCE_EXPIRED")
    expect(authority).toHaveBeenCalledTimes(2)
  })
})

it("does not reuse the initial authority observation across a skipped-Hook callback", () => {
  const parent = plugin(), foreign = plugin("foreign")
  let current = true
  const token = issueRuntimePluginSourceToken(binding(parent), undefined,
    () => { if (!current) throw Error("ORIGINAL_SOURCE_EXPIRED") })
  withRuntimePluginSource(token, () => {
    const candidates = { baseHooks: [], pluginHooks: [
      parsePluginHooks(foreign)[0], parsePluginHooks(parent)[0]
    ], skillHooks: [] }
    const onSkipped = vi.fn(() => { current = false })
    expect(() => filterScopedHooks(candidates, context(), createHookScope(), onSkipped))
      .toThrow("ORIGINAL_SOURCE_EXPIRED")
    expect(onSkipped).toHaveBeenCalledTimes(1)
  })
})

it.each(["legacy", "host"] as const)(
  "keeps the admitted %s parent in initial SessionStart/PreSkill scope before any Skill activation", async mode => {
    const parent = plugin(), replaced = plugin("parent", "MUTABLE_REPLACEMENT"), other = plugin("other")
    registry.plugins = [replaced, other]
    const token = issueRuntimePluginSourceToken(binding(parent, { mode }))
    const observed: Array<{ id: string; stdout: string; exitCode: number | null }> = []
    const collect = (id: string, _event: unknown, result: { stdout: string; exitCode: number | null }) => {
      observed.push({ id, stdout: result.stdout, exitCode: result.exitCode })
    }
    await withRuntimePluginSource(token, async () => {
      const scope = createHookScope()
      expect(scope.activePluginIds.size).toBe(0)
      const resolved = resolveEnabledHooksForRun(root, "SessionStart", context(), scope)
      expect(resolved).toHaveLength(3)
      expect(resolved.every(hook => hook.hookSourceRoot === parent.path)).toBe(true)
      expect(partitionRequiredBusinessHooks(resolved).required.map(hook => hook.id)).toEqual([
        "plugin:parent/PreSkillUse:0:0", "plugin:parent/PreToolUse:0:0"
      ])
      await fireSessionStartOnce(`initial-${mode}`, root, collect, scope)
      await vi.waitFor(() => expect(observed.some(row => row.stdout.includes("ORIGINAL_SESSION"))).toBe(true),
        { timeout: 5000 })
      await runHooks(resolveEnabledHooksForRun(root, "PreSkillUse", context(), scope),
        "PreSkillUse", context(), collect)
      expect(observed.some(row => row.stdout.includes("ORIGINAL_SKILL") && row.exitCode === 0)).toBe(true)
      expect(observed.some(row => row.stdout.includes("MUTABLE_REPLACEMENT"))).toBe(false)
      expect(scope.activePluginIds.size).toBe(0)
    })
  }
)

it("uses the same admitted parent with an absent optional HookScope and does not activate its Skill Hooks", () => {
  const parent = plugin()
  registry.plugins = [parent]
  registry.skills = [{ ...parsePluginHooks(parent)[0], id: "skill:unactivated", skillName: "hidden",
    skillPath: join(parent.path, "skills/hidden/SKILL.md") } as PluginHookMetadata]
  withRuntimePluginSource(issueRuntimePluginSourceToken(binding(parent)), () => {
    const resolved = resolveEnabledHooksForRun(root, "SessionStart", context())
    expect(resolved).toHaveLength(3)
    expect(partitionRequiredBusinessHooks(resolved).required).toHaveLength(2)
    expect(resolved.some(hook => hook.id === "skill:unactivated")).toBe(false)
  })
  expect(resolveEnabledHooksForRun(root, "SessionStart", context())).toEqual([])
  expect(resolveEnabledHooksForRun(root, "SessionStart", context(), createHookScope())).toEqual([])
})

it("does not admit another UUID or a nonpreserved capabilities parent through activation state", () => {
  const parent = plugin(), selected = plugin("selected"), unselected = plugin("other")
  registry.plugins = [parent, selected, unselected]
  const source = { plugin: selected, packageDigest: "b".repeat(64),
    capability: { id: "selected-project", title: "Selected", kind: "flow" as const,
      usage: "project" as const, entry: "devclaw.project-runtime.json", dependsOn: [] } }
  for (const preserveParentContext of [false, true]) {
    const token = issueRuntimePluginSourceToken(binding(parent, { mode: "capabilities",
      preserveParentContext, requiredHooks: [], capabilitySources: [source] }))
    withRuntimePluginSource(token, () => {
      const scope = createHookScope()
      scope.activatePlugin(parent.id)
      scope.activatePlugin(unselected.id)
      const resolved = resolveEnabledHooksForRun(root, "SessionStart", context(), scope)
      expect(new Set(resolved.map(hook => (hook as PluginHookMetadata).pluginId)))
        .toEqual(new Set(preserveParentContext ? [parent.id, selected.id] : [selected.id]))
    })
  }
})

it("still rejects disabled/missing/wrong-root mandatory Hooks and an expired source", async () => {
  const parent = plugin()
  registry.plugins = [parent]
  const token = issueRuntimePluginSourceToken(binding(parent))
  withRuntimePluginSource(token, () => {
    const hooks = resolveEnabledHooksForRun(root, "PreSkillUse", context(), createHookScope())
    expect(() => partitionRequiredBusinessHooks(hooks.filter(hook => hook.event !== "PreToolUse")))
      .toThrow("REQUIRED_BUSINESS_CHECK_MISSING")
    expect(() => partitionRequiredBusinessHooks(hooks.map(hook => ({ ...hook,
      enabled: hook.event !== "PreToolUse" })))).toThrow("REQUIRED_BUSINESS_CHECK_MISSING")
    expect(() => partitionRequiredBusinessHooks(hooks.map(hook => ({ ...hook,
      hookSourceRoot: join(root, "wrong-root") })))).toThrow("REQUIRED_BUSINESS_CHECK_MISSING")
  })
  let current = true
  const expired = issueRuntimePluginSourceToken(binding(parent), undefined,
    () => { if (!current) throw Error("ORIGINAL_SOURCE_EXPIRED") })
  await withRuntimePluginSource(expired, async () => {
    const hooks = resolveEnabledHooksForRun(root, "PreSkillUse", context(), createHookScope())
    current = false
    expect(() => resolveEnabledHooksForRun(root, "PreSkillUse", context(), createHookScope()))
      .toThrow("ORIGINAL_SOURCE_EXPIRED")
    await expect(runHooks(hooks, "PreSkillUse", context())).rejects.toThrow("ORIGINAL_SOURCE_EXPIRED")
  })
})

const archive = resolve(process.env.AUTOBIZ_REQUIRED_HOOK_ARCHIVE ??
  "output/deliveries/mods-verified-artifacts-20261017-v5/12-数仓可验证产物导出版.zip")
it.skipIf(!existsSync(archive))("projects every original mandatory Hook from the actual assembled producer12", () => {
  const zip = new AdmZip(archive), entries = zip.getEntries().filter(entry => !entry.isDirectory)
  const manifest = entries.find(entry => /(?:^|\/)plugin\.json$/.test(entry.entryName))!
  const prefix = manifest.entryName.slice(0, -"plugin.json".length)
  const path = join(root, "retained-producer12")
  for (const entry of entries) {
    const relative = entry.entryName.slice(prefix.length)
    if (!entry.entryName.startsWith(prefix) || relative.split(/[\\/]/).includes("..")) throw Error("fixture archive path")
    const target = join(path, relative)
    mkdirSync(resolve(target, ".."), { recursive: true })
    writeFileSync(target, entry.getData())
  }
  const parent = metadata(path, "producer12-installed-uuid")
  const requiredHooks = readRuntimeRequiredHooks(parent, { legacy: true })
  expect(requiredHooks).toHaveLength(12)
  registry.plugins = [plugin("same-friendly-name-other-uuid")]
  const token = issueRuntimePluginSourceToken(binding(parent, { requiredHooks }))
  withRuntimePluginSource(token, () => {
    for (const event of ["Setup", "SessionStart", "PreSkillUse", "UserPromptSubmit"] as const) {
      const hooks = resolveEnabledHooksForRun(root, event, context(), createHookScope())
      expect(partitionRequiredBusinessHooks(hooks).required.map(hook => hook.id))
        .toEqual(requiredHooks)
      expect(hooks.every(hook => hook.hookSourceRoot === path)).toBe(true)
    }
  })
  expect(JSON.parse(readFileSync(join(path, "devclaw.project-runtime.json"), "utf8")).apiVersion)
    .toBe("devclaw.project-runtime/v2")
})
