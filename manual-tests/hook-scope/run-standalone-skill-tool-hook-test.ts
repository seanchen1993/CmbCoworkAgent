import { readFileSync } from "fs"
import { join } from "path"
import { getSkillsSources } from "../../src/main/storage.ts"
import { LocalSandbox } from "../../src/main/agent/local-sandbox.ts"
import { SkillLifecycleRegistry } from "../../src/main/agent/skill-lifecycle/registry.ts"
import { runHooksEnriched } from "../../src/main/hooks/required-skill.ts"
import type { HookContext } from "../../src/main/hooks/runner.ts"
import type { HookEvent } from "../../src/main/hooks/types.ts"
import {
  createHookScope,
  resolveEnabledHooksForRun,
} from "../../src/main/hooks/scope.ts"

const workspacePath = "C:\\ai\\CmbCoworkAgent"
const threadId = `standalone-skill-tool-hook-${Date.now()}`

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

function printEvents(title: string, before: number): void {
  console.log(`\n## ${title}`)
  const events = readHookEvents().slice(before)
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

async function runScopedHooks(
  event: HookEvent,
  context: HookContext,
  scope: ReturnType<typeof createHookScope>,
): Promise<void> {
  await runHooksEnriched(
    resolveEnabledHooksForRun(workspacePath, event, context, scope),
    event,
    context,
  )
}

async function main(): Promise<void> {
  console.log(`threadId=${threadId}`)
  const scope = createHookScope()

  const beforeNoSkill = readHookEvents().length
  await runScopedHooks("PreToolUse", {
    toolName: "execute",
    toolArgs: { command: "cmd /c echo before-skill" },
    workspacePath,
    sessionId: `${threadId}-before`,
  }, scope)
  await runScopedHooks("PostToolUse", {
    toolName: "execute",
    toolArgs: { command: "cmd /c echo before-skill" },
    toolResult: "before-skill",
    workspacePath,
    sessionId: `${threadId}-before`,
  }, scope)
  printEvents("before using scope-plain-skill", beforeNoSkill)
  assert(readHookEvents().length === beforeNoSkill, "skill PreToolUse/PostToolUse hooks fired before skill use")

  const sandbox = new LocalSandbox({
    rootDir: workspacePath,
    virtualMode: false,
    hooks: [],
    hookScope: scope,
    hookResolver: (event, context) => resolveEnabledHooksForRun(workspacePath, event, context, scope),
    runId: `${threadId}-sandbox`,
  })
  sandbox.setSkillLifecycleRegistry(new SkillLifecycleRegistry(getSkillsSources()))

  const beforeReadSkill = readHookEvents().length
  const skillPath = "C:\\Users\\87624\\.cmbcoworkagent\\skills\\scope-plain-skill\\SKILL.md"
  const content = await sandbox.read(skillPath, 0, 80)
  assert(content.includes("scope-plain-skill"), "expected skill content")
  printEvents("read SKILL.md to activate skill", beforeReadSkill)
  assert(readHookEvents().length === beforeReadSkill, "PreToolUse/PostToolUse hooks should not fire while only reading SKILL.md")

  const beforeAfterSkill = readHookEvents().length
  await sandbox.execute("cmd /c echo after-skill")
  printEvents("after using scope-plain-skill, execute tool", beforeAfterSkill)

  const events = readHookEvents().slice(beforeAfterSkill)
  const labels = events.map((event) => String(event.label || ""))
  assert(labels.includes("plain-skill-tool-pre"), "plain-skill-tool-pre did not fire after skill use")
  assert(labels.includes("plain-skill-tool-post"), "plain-skill-tool-post did not fire after skill use")
  assert(
    events.every((event) => event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUse"),
    "expected only PreToolUse/PostToolUse events",
  )
  console.log("\nPASS standalone skill PreToolUse/PostToolUse scope behavior")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
