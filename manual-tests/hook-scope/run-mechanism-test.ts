import { readFileSync } from "fs"
import { join } from "path"
import {
  getPlugins,
  getEnabledPluginSkillSourceMetadata,
  getSkillsSources,
} from "../../src/main/storage.ts"
import { LocalSandbox } from "../../src/main/agent/local-sandbox.ts"
import { SkillLifecycleRegistry } from "../../src/main/agent/skill-lifecycle/registry.ts"
import { runHooksEnriched } from "../../src/main/hooks/required-skill.ts"
import type { HookContext } from "../../src/main/hooks/runner.ts"
import type { HookEvent } from "../../src/main/hooks/types.ts"
import {
  createHookScope,
  extractPluginIdFromProviderKey,
  resolveEnabledHooksForRun,
} from "../../src/main/hooks/scope.ts"
import {
  closeGlobalMcpCapabilityService,
  getGlobalMcpCapabilityService,
} from "../../src/main/mcp/capability-service.ts"

const workspacePath = "C:\\ai\\CmbCoworkAgent"
const threadId = `hook-mechanism-${Date.now()}`

type JsonRecord = Record<string, unknown>

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function readHookEvents(): JsonRecord[] {
  const logPath = join(workspacePath, ".hook-scope-log", "events.jsonl")
  try {
    return readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord)
  } catch {
    return []
  }
}

function labels(): string[] {
  return readHookEvents().map((event) => String(event.label || ""))
}

function countLabel(label: string): number {
  return labels().filter((item) => item === label).length
}

function printDelta(title: string, before: number): void {
  const events = readHookEvents().slice(before)
  console.log(`\n## ${title}`)
  if (events.length === 0) {
    console.log("(no hook events)")
    return
  }
  for (const event of events) {
    console.log(JSON.stringify({
      label: event.label,
      hook_event_name: event.hook_event_name,
      tool_name: event.tool_name,
      skill_name: event.skill_name,
      plugin_id: event.plugin_id,
      plugin_name: event.plugin_name,
    }))
  }
}

function getPluginName(pluginId: string): string | undefined {
  return getPlugins().find((plugin) => plugin.id === pluginId)?.name
}

async function runScopedHooks(
  event: HookEvent,
  context: HookContext,
  scope: ReturnType<typeof createHookScope>,
): Promise<void> {
  const hooks = resolveEnabledHooksForRun(workspacePath, event, context, scope)
  await runHooksEnriched(hooks, event, context)
}

async function testNoPluginNoPluginHooks(): Promise<void> {
  const before = readHookEvents().length
  const scope = createHookScope()
  await runScopedHooks("PreToolUse", {
    toolName: "read_file",
    toolArgs: { file_path: "package.json" },
    workspacePath,
    sessionId: `${threadId}-baseline`,
  }, scope)
  await runScopedHooks("PostToolUse", {
    toolName: "read_file",
    toolArgs: { file_path: "package.json" },
    toolResult: "package.json preview",
    workspacePath,
    sessionId: `${threadId}-baseline`,
  }, scope)
  printDelta("baseline: ordinary tool before plugin use", before)
  assert(readHookEvents().length === before, "plugin hooks should not fire before plugin use")
}

async function testPluginMcpFirstCall(): Promise<void> {
  const before = readHookEvents().length
  const scope = createHookScope()
  const service = getGlobalMcpCapabilityService()
  const tool = await service.getTool("mcp__scopeDemoMcp__scope_echo")
  assert(tool, "expected mcp__scopeDemoMcp__scope_echo to be loaded")
  const pluginId = extractPluginIdFromProviderKey(tool!.providerKey)
  assert(pluginId, `expected plugin providerKey, got ${tool!.providerKey}`)
  const pluginName = getPluginName(pluginId!)

  const context: HookContext = {
    toolName: tool!.toolId,
    toolArgs: { message: "mcp first call from mechanism test" },
    workspacePath,
    sessionId: `${threadId}-mcp`,
    pluginId,
    pluginName,
  }
  await runScopedHooks("PreToolUse", context, scope)
  scope.activatePlugin(pluginId)
  const result = await service.invoke(tool!.capabilityId, { message: "mcp first call from mechanism test" })
  await runScopedHooks("PostToolUse", {
    ...context,
    toolResult: result.text,
  }, scope)
  printDelta("plugin MCP first call", before)
  assert(countLabel("plugin-pre-any-tool") >= 1, "plugin MCP first call should fire plugin-pre-any-tool")
  assert(countLabel("plugin-post-any-tool") >= 1, "plugin MCP first call should fire plugin-post-any-tool")
}

async function testPluginScopeAfterMcpUse(): Promise<void> {
  const before = readHookEvents().length
  const scope = createHookScope()
  const service = getGlobalMcpCapabilityService()
  const tool = await service.getTool("mcp__scopeDemoMcp__scope_echo")
  assert(tool, "expected mcp__scopeDemoMcp__scope_echo to be loaded")
  const pluginId = extractPluginIdFromProviderKey(tool!.providerKey)
  assert(pluginId, `expected plugin providerKey, got ${tool!.providerKey}`)
  scope.activatePlugin(pluginId!)

  await runScopedHooks("PreToolUse", {
    toolName: "read_file",
    toolArgs: { file_path: "package.json" },
    workspacePath,
    sessionId: `${threadId}-after-mcp`,
  }, scope)
  await runScopedHooks("PostToolUse", {
    toolName: "read_file",
    toolArgs: { file_path: "package.json" },
    toolResult: "package.json preview",
    workspacePath,
    sessionId: `${threadId}-after-mcp`,
  }, scope)
  printDelta("ordinary tool after plugin scope is active", before)
  assert(countLabel("plugin-pre-any-tool") >= 2, "active plugin scope should fire plugin pre hook for later tools")
  assert(countLabel("plugin-post-any-tool") >= 2, "active plugin scope should fire plugin post hook for later tools")
  const newEvents = readHookEvents().slice(before)
  assert(
    newEvents.every((event) => event.plugin_id && event.plugin_name),
    "plugin hooks fired from active scope should receive plugin_id/plugin_name"
  )
}

async function testPluginSkillHooks(): Promise<void> {
  const before = readHookEvents().length
  const scope = createHookScope()
  const pluginSkillSources = getEnabledPluginSkillSourceMetadata()
  const sandbox = new LocalSandbox({
    rootDir: workspacePath,
    virtualMode: false,
    hooks: [],
    hookScope: scope,
    hookResolver: (event, context) => resolveEnabledHooksForRun(workspacePath, event, context, scope),
    runId: `${threadId}-skill`,
  })
  sandbox.setSkillLifecycleRegistry(new SkillLifecycleRegistry(pluginSkillSources))

  const skillPath = "C:\\Users\\87624\\.cmbcoworkagent\\plugins\\Hook-Scope-Demo\\skills\\scope-plugin-skill\\SKILL.md"
  const content = await sandbox.read(skillPath, 0, 80)
  assert(content.includes("scope-plugin-skill"), "expected to read scope-plugin-skill content")
  printDelta("plugin skill lifecycle", before)

  const afterLabels = labels()
  for (const expected of [
    "plugin-pre-skill",
    "plugin-post-skill",
    "plugin-skill-pre",
    "plugin-skill-post",
  ]) {
    assert(afterLabels.includes(expected), `expected ${expected} to fire`)
  }
}

async function testStandaloneSkillHooks(): Promise<void> {
  const before = readHookEvents().length
  const scope = createHookScope()
  await runScopedHooks("PreToolUse", {
    toolName: "execute",
    toolArgs: { command: "echo before-plain-skill" },
    workspacePath,
    sessionId: `${threadId}-plain-skill-before-use`,
  }, scope)
  await runScopedHooks("PostToolUse", {
    toolName: "execute",
    toolArgs: { command: "echo before-plain-skill" },
    toolResult: "before-plain-skill",
    workspacePath,
    sessionId: `${threadId}-plain-skill-before-use`,
  }, scope)
  printDelta("standalone skill PreToolUse/PostToolUse before skill use", before)
  assert(readHookEvents().length === before, "standalone skill tool hooks should not fire before the skill is used")

  const afterNoUse = readHookEvents().length
  const sandbox = new LocalSandbox({
    rootDir: workspacePath,
    virtualMode: false,
    hooks: [],
    hookScope: scope,
    hookResolver: (event, context) => resolveEnabledHooksForRun(workspacePath, event, context, scope),
    runId: `${threadId}-plain-skill`,
  })
  sandbox.setSkillLifecycleRegistry(new SkillLifecycleRegistry(getSkillsSources()))

  const skillPath = "C:\\Users\\87624\\.cmbcoworkagent\\skills\\scope-plain-skill\\SKILL.md"
  const content = await sandbox.read(skillPath, 0, 80)
  assert(content.includes("scope-plain-skill"), "expected to read scope-plain-skill content")
  const skillUseEvents = readHookEvents().slice(afterNoUse)
  const skillUseLabels = skillUseEvents.map((event) => String(event.label || ""))
  assert(skillUseLabels.includes("plain-skill-pre"), "expected plain-skill-pre to fire while reading SKILL.md")
  assert(skillUseLabels.includes("plain-skill-post"), "expected plain-skill-post to fire while reading SKILL.md")
  assert(
    skillUseEvents.every((event) => event.hook_event_name === "PreSkillUse" || event.hook_event_name === "PostSkillUse"),
    "expected only PreSkillUse/PostSkillUse events while reading SKILL.md"
  )

  const beforeExecute = readHookEvents().length
  await sandbox.execute("cmd /c echo after-plain-skill")
  printDelta("standalone skill PreToolUse/PostToolUse after skill use", beforeExecute)

  const newEvents = readHookEvents().slice(beforeExecute)
  const newLabels = newEvents.map((event) => String(event.label || ""))
  assert(newLabels.includes("plain-skill-tool-pre"), "expected plain-skill-tool-pre to fire")
  assert(newLabels.includes("plain-skill-tool-post"), "expected plain-skill-tool-post to fire")
  assert(
    newEvents.every((event) => !event.plugin_id && !event.plugin_name),
    "standalone skill hooks should not receive plugin_id/plugin_name"
  )
}

async function main(): Promise<void> {
  console.log(`threadId=${threadId}`)
  await testNoPluginNoPluginHooks()
  await testPluginMcpFirstCall()
  await testPluginScopeAfterMcpUse()
  await testPluginSkillHooks()
  await testStandaloneSkillHooks()

  const allEvents = readHookEvents()
  console.log("\n## summary")
  console.log(JSON.stringify({
    total_events: allEvents.length,
    labels: labels(),
  }, null, 2))
  await closeGlobalMcpCapabilityService()
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch(async (error) => {
    await closeGlobalMcpCapabilityService().catch(() => undefined)
    console.error(error)
    process.exit(1)
  })
