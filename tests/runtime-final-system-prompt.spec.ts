/**
 * Unit tests for the final system prompt passed into LangChain createAgent.
 *
 * Run:
 *   npx tsx tests/runtime-final-system-prompt.spec.ts
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { loadAgentsPromptForWorkspace } from "../src/main/agent/agents-md.ts"
import { createDeepAgent, getSystemPrompt } from "../src/main/agent/runtime.ts"
import type { HarnessFeatureAgentContext } from "../src/main/harness-board/service.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

const LANGCHAIN_BASE_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools."

const GLOBAL_AGENTS_RULE = "GLOBAL_AGENTS_RULE"
const LOCAL_AGENTS_RULE = "LOCAL_AGENTS_RULE"
const PLUGIN_AGENTS_RULE = "PLUGIN_AGENTS_RULE"
const PLUGIN_AGENTS_PROMPT = [
  "# Plugin session_context_inject",
  "",
  "<INSTRUCTIONS>",
  PLUGIN_AGENTS_RULE,
  "</INSTRUCTIONS>"
].join("\n")
const EXTRA_SYSTEM_PROMPT = "EXTRA_SYSTEM_PROMPT"
const TASK_PLUGIN_RULE = "TASK_PLUGIN_RULE"
const TASK_AGENTS_RULE = "TASK_AGENTS_RULE"
const TASK_AGENTS_CONTEXT = `## AGENTS.md instructions\n\n${TASK_AGENTS_RULE}`
const TASK_PROJECT_CONTEXT = `## Skills Runtime Context\n\n${TASK_PLUGIN_RULE}\n\n${TASK_AGENTS_CONTEXT}`

interface TaskSubagentPromptSnapshot {
  name: string
  systemPrompt: string
}

interface TempWorkspace {
  tempRoot: string
  agentsHome: string
  workspacePath: string
}

interface CliOptions {
  workspace?: string
  projectId?: string
  feature?: string
  extraSystemPrompt?: string
  help?: boolean
}

interface RuntimePromptBuildResult {
  runtimePrompt: string
  workspacePath: string
  agentsLoadedPaths: string[]
  agentsTruncated: boolean
  harnessAgentsPromptLoaded: boolean
  enableAgentsPrompt: boolean
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx tests/runtime-final-system-prompt.spec.ts",
    "  npx tsx tests/runtime-final-system-prompt.spec.ts --workspace <path> --project-id <id> --feature <slug>",
    "",
    "Options:",
    "  --workspace <path>           Session workspace path used by the runtime",
    "  --project-id <id>            Harness project id from harness-board-projects.json",
    "  --feature <slug>             Harness feature slug/name; selected deploy units are read from saved binding",
    "  --extra-system-prompt <text>  Optional prompt appended after AGENTS prompt",
    "  --help                       Print this help"
  ].join("\n")
}

function readOptionValue(argv: string[], index: number, name: string): { value: string; next: number } {
  const current = argv[index]
  const equalsIndex = current.indexOf("=")
  if (equalsIndex >= 0) {
    return { value: current.slice(equalsIndex + 1), next: index + 1 }
  }

  const value = argv[index + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`)
  }
  return { value, next: index + 2 }
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {}
  let index = 0

  while (index < argv.length) {
    const arg = argv[index]

    if (arg === "--help" || arg === "-h") {
      options.help = true
      index += 1
      continue
    }

    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const parsed = readOptionValue(argv, index, "--workspace")
      options.workspace = parsed.value
      index = parsed.next
      continue
    }

    if (arg === "--project-id" || arg.startsWith("--project-id=")) {
      const parsed = readOptionValue(argv, index, "--project-id")
      options.projectId = parsed.value
      index = parsed.next
      continue
    }

    if (arg === "--feature" || arg.startsWith("--feature=")) {
      const parsed = readOptionValue(argv, index, "--feature")
      options.feature = parsed.value
      index = parsed.next
      continue
    }

    if (arg === "--extra-system-prompt" || arg.startsWith("--extra-system-prompt=")) {
      const parsed = readOptionValue(argv, index, "--extra-system-prompt")
      options.extraSystemPrompt = parsed.value
      index = parsed.next
      continue
    }

    throw new Error(`Unknown option: ${arg}`)
  }

  return options
}

function requireCliOption(value: string | undefined, name: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(`Missing required option: ${name}`)
  }
  return trimmed
}

function resolveExistingWorkspace(workspacePath: string): string {
  try {
    return realpathSync(workspacePath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Workspace path does not exist or cannot be resolved: ${workspacePath}\n${detail}`)
  }
}

async function withTempWorkspace<T>(fn: (workspace: TempWorkspace) => Promise<T>): Promise<T> {
  const tempRoot = mkdtempSync(join(tmpdir(), "runtime-final-system-prompt-"))
  const agentsHome = join(tempRoot, "agents-home")
  const workspacePath = join(tempRoot, "repo")
  const previousAgentsHome = process.env.CMB_COWORK_AGENT_HOME

  mkdirSync(agentsHome, { recursive: true })
  mkdirSync(join(workspacePath, ".git"), { recursive: true })
  writeFileSync(join(agentsHome, "AGENTS.md"), `${GLOBAL_AGENTS_RULE}\n`)
  writeFileSync(join(workspacePath, "AGENTS.md"), `${LOCAL_AGENTS_RULE}\n`)

  process.env.CMB_COWORK_AGENT_HOME = agentsHome
  try {
    return await fn({
      tempRoot,
      agentsHome,
      workspacePath: realpathSync(workspacePath)
    })
  } finally {
    if (previousAgentsHome === undefined) {
      delete process.env.CMB_COWORK_AGENT_HOME
    } else {
      process.env.CMB_COWORK_AGENT_HOME = previousAgentsHome
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function buildBaseRuntimePrompt(
  workspacePath: string,
  pluginPromptInject?: string,
  options: { includeBackgroundExec?: boolean; includeSubagents?: boolean } = {}
): string {
  void pluginPromptInject
  return getSystemPrompt(workspacePath, undefined, {
    includeBackgroundExec: options.includeBackgroundExec ?? false,
    includeSubagents: options.includeSubagents ?? false,
    includeMemory: false
  })
}

async function buildFrameworkRuntimePrompt(workspacePath: string): Promise<string> {
  const basePrompt = buildBaseRuntimePrompt(workspacePath)
  const agentsPrompt = await loadAgentsPromptForWorkspace(workspacePath, {
    globalMaxBytes: 1024,
    projectMaxBytes: 1024
  })

  assert(agentsPrompt.prompt, "framework AGENTS prompt should be loaded from temp workspace")

  return [basePrompt, agentsPrompt.prompt, EXTRA_SYSTEM_PROMPT].filter(Boolean).join("\n\n")
}

function buildPluginRuntimePrompt(workspacePath: string): string {
  return [buildBaseRuntimePrompt(workspacePath), PLUGIN_AGENTS_PROMPT, EXTRA_SYSTEM_PROMPT].join(
    "\n\n"
  )
}

async function buildRuntimePromptFromHarnessContext(
  workspacePath: string,
  harnessContext: HarnessFeatureAgentContext,
  extraSystemPrompt?: string
): Promise<RuntimePromptBuildResult> {
  let runtimePrompt = buildBaseRuntimePrompt(workspacePath, harnessContext.systemPromptInject, {
    includeBackgroundExec: true,
    includeSubagents: harnessContext.featureId ? (harnessContext.enableTaskTool ?? true) : true
  })
  const normalizedHarnessAgentsPrompt = harnessContext.harnessAgentsPrompt?.trim()
  const enableAgentsPrompt = harnessContext.enableAgentsPrompt !== false
  const shouldLoadWorkspaceAgentsPrompt = enableAgentsPrompt && !normalizedHarnessAgentsPrompt
  let agentsLoadedPaths: string[] = []
  let agentsTruncated = false

  if (shouldLoadWorkspaceAgentsPrompt) {
    const agentsPrompt = await loadAgentsPromptForWorkspace(workspacePath)
    agentsLoadedPaths = agentsPrompt.loadedPaths
    agentsTruncated = agentsPrompt.truncated
    if (agentsPrompt.prompt) {
      runtimePrompt += "\n\n" + agentsPrompt.prompt
    }
  }

  if (normalizedHarnessAgentsPrompt) {
    runtimePrompt += "\n\n" + normalizedHarnessAgentsPrompt
  }

  const normalizedExtraSystemPrompt = extraSystemPrompt?.trim()
  if (normalizedExtraSystemPrompt) {
    runtimePrompt += "\n\n" + normalizedExtraSystemPrompt
  }

  return {
    runtimePrompt,
    workspacePath,
    agentsLoadedPaths,
    agentsTruncated,
    harnessAgentsPromptLoaded: Boolean(normalizedHarnessAgentsPrompt),
    enableAgentsPrompt
  }
}

function captureFinalSystemPrompt(systemPrompt: string): string {
  let captured = ""
  createDeepAgent({
    model: "test-model",
    tools: [],
    systemPrompt,
    includeGeneralPurposeSubagent: false,
    mainFilesystemEnabled: false,
    mainTodosEnabled: false,
    mainSubagentsEnabled: false,
    onFinalSystemPrompt: (prompt: string) => {
      captured = prompt
    }
  })
  return captured
}

function captureTaskSubagentPrompts(options: {
  projectMode: boolean
  projectContext?: string
  mainSubagentsEnabled?: boolean
}): Map<string, string> {
  let captured: TaskSubagentPromptSnapshot[] = []
  createDeepAgent({
    model: "test-model",
    tools: [],
    systemPrompt: "TASK_SUBAGENT_MAIN_PROMPT",
    mainFilesystemEnabled: false,
    mainTodosEnabled: false,
    mainSubagentsEnabled: options.mainSubagentsEnabled ?? true,
    subagentExtraSystemPrompt: options.projectContext,
    subagentExtraSystemPromptForRestrictedRoles: options.projectMode,
    registrySubagentSpecs: [
      {
        name: "Explore",
        description: "Read-only registry agent",
        systemPrompt: "EXPLORE_BASE_PROMPT",
        disallowedTools: ["write_file", "edit_file"],
        shellAccess: "read_only"
      },
      {
        name: "verification",
        description: "Full-shell verification registry agent",
        systemPrompt: "VERIFICATION_BASE_PROMPT",
        disallowedTools: ["write_file", "edit_file"],
        shellAccess: "full"
      },
      {
        name: "no-shell",
        description: "Registry agent without shell access",
        systemPrompt: "NO_SHELL_BASE_PROMPT",
        disallowedTools: [],
        shellAccess: "none"
      }
    ],
    onTaskSubagentPromptsResolved: (prompts: TaskSubagentPromptSnapshot[]) => {
      captured = prompts
    }
  })
  return new Map(captured.map((snapshot) => [snapshot.name, snapshot.systemPrompt]))
}

function requireTaskSubagentPrompt(prompts: Map<string, string>, name: string): string {
  const prompt = prompts.get(name)
  assert(prompt, `task subagent prompt should be captured for ${name}`)
  return prompt
}

function countOccurrences(content: string, marker: string): number {
  return content.split(marker).length - 1
}

function testTaskSubagentPromptModeMatrix(): void {
  const nonProjectPrompts = captureTaskSubagentPrompts({
    projectMode: false,
    projectContext: TASK_AGENTS_CONTEXT
  })
  for (const name of ["general-purpose", "verification"]) {
    const prompt = requireTaskSubagentPrompt(nonProjectPrompts, name)
    assert(prompt.includes(TASK_AGENTS_RULE), `${name} should inherit AGENTS outside project mode`)
    assert(
      !prompt.includes(TASK_PLUGIN_RULE),
      `${name} should not receive plugin context outside project mode`
    )
  }
  for (const name of ["Explore", "no-shell"]) {
    const prompt = requireTaskSubagentPrompt(nonProjectPrompts, name)
    assert(
      !prompt.includes(TASK_AGENTS_RULE) && !prompt.includes(TASK_PLUGIN_RULE),
      `${name} should omit project context outside project mode`
    )
  }

  const projectPrompts = captureTaskSubagentPrompts({
    projectMode: true,
    projectContext: TASK_PROJECT_CONTEXT
  })
  for (const name of ["general-purpose", "verification", "Explore", "no-shell"]) {
    const prompt = requireTaskSubagentPrompt(projectPrompts, name)
    assert(
      prompt.includes(TASK_PLUGIN_RULE),
      `${name} should inherit plugin context in project mode`
    )
    assert(prompt.includes(TASK_AGENTS_RULE), `${name} should inherit AGENTS in project mode`)
    assert(
      countOccurrences(prompt, TASK_PLUGIN_RULE) === 1 &&
        countOccurrences(prompt, TASK_AGENTS_RULE) === 1,
      `${name} should receive project context exactly once`
    )
  }

  const emptyContextPrompts = captureTaskSubagentPrompts({ projectMode: true })
  for (const prompt of emptyContextPrompts.values()) {
    assert(
      !prompt.includes("## Project Instructions"),
      "empty project context should not append an empty Project Instructions section"
    )
  }

  const disabledPrompts = captureTaskSubagentPrompts({
    projectMode: true,
    projectContext: TASK_PROJECT_CONTEXT,
    mainSubagentsEnabled: false
  })
  assert(disabledPrompts.size === 0, "disabled task middleware should not resolve subagent prompts")
}

function printFinalPrompt(label: string, prompt: string): void {
  console.log(`\n===== ${label} FINAL SYSTEM PROMPT BEGIN =====`)
  console.log(prompt)
  console.log(`===== ${label} FINAL SYSTEM PROMPT END =====\n`)
}

function printRuntimePromptDiagnostics(
  result: RuntimePromptBuildResult,
  harnessContext: HarnessFeatureAgentContext
): void {
  console.log("===== HARNESS PROMPT DIAGNOSTICS BEGIN =====")
  console.log(`workspacePath: ${result.workspacePath}`)
  console.log(`featureId: ${harnessContext.featureId ?? "<none>"}`)
  console.log(`projectCode: ${harnessContext.projectCode ?? "<none>"}`)
  console.log(`projectDir: ${harnessContext.projectDir ?? "<none>"}`)
  console.log(`enableAgentsPrompt: ${result.enableAgentsPrompt}`)
  console.log(`harnessAgentsPromptLoaded: ${result.harnessAgentsPromptLoaded}`)
  console.log(
    `workspaceAgentsLoadedPaths: ${
      result.agentsLoadedPaths.length > 0 ? result.agentsLoadedPaths.join(", ") : "<none>"
    }`
  )
  console.log(`workspaceAgentsTruncated: ${result.agentsTruncated}`)
  console.log(`sessionContextInjectWarning: ${harnessContext.sessionContextInjectWarning ?? "<none>"}`)
  console.log(
    `agentmdLoadStatus: ${
      harnessContext.agentmdLoadStatus ? JSON.stringify(harnessContext.agentmdLoadStatus) : "<none>"
    }`
  )
  console.log(`pluginOutputDir: ${harnessContext.pluginOutputDir ?? "<none>"}`)
  console.log(`pluginRoot: ${harnessContext.pluginRoot ?? "<none>"}`)
  console.log("===== HARNESS PROMPT DIAGNOSTICS END =====")
}

async function testFrameworkAgentsFinalPrompt(workspacePath: string): Promise<string> {
  const runtimePrompt = await buildFrameworkRuntimePrompt(workspacePath)
  const finalPrompt = captureFinalSystemPrompt(runtimePrompt)

  assert(
    finalPrompt === `${runtimePrompt}\n\n${LANGCHAIN_BASE_PROMPT}`,
    "framework AGENTS final prompt should match runtime prompt plus LangChain base prompt"
  )
  assert(finalPrompt.includes(GLOBAL_AGENTS_RULE), "global AGENTS content should be present")
  assert(finalPrompt.includes(LOCAL_AGENTS_RULE), "workspace AGENTS content should be present")
  assert(!finalPrompt.includes("PLUGIN_AGENTS_RULE"), "plugin AGENTS content should be absent")
  return finalPrompt
}

function testPluginAgentsFinalPrompt(workspacePath: string): string {
  const runtimePrompt = buildPluginRuntimePrompt(workspacePath)
  const finalPrompt = captureFinalSystemPrompt(runtimePrompt)

  assert(
    finalPrompt === `${runtimePrompt}\n\n${LANGCHAIN_BASE_PROMPT}`,
    "plugin AGENTS final prompt should match runtime prompt plus LangChain base prompt"
  )
  assert(finalPrompt.includes(PLUGIN_AGENTS_RULE), "plugin AGENTS content should be present")
  assert(!finalPrompt.includes(GLOBAL_AGENTS_RULE), "global AGENTS content should be absent")
  assert(!finalPrompt.includes(LOCAL_AGENTS_RULE), "workspace AGENTS content should be absent")
  return finalPrompt
}

async function run(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv.slice(2))
  if (cliOptions.help) {
    console.log(usage())
    return
  }

  if (process.argv.length > 2) {
    await runHarnessCliMode(cliOptions)
    return
  }

  await withTempWorkspace(async ({ workspacePath }) => {
    const frameworkPrompt = await testFrameworkAgentsFinalPrompt(workspacePath)
    printFinalPrompt("FRAMEWORK AGENTS", frameworkPrompt)
    console.log("PASS framework AGENTS final system prompt")
    const pluginPrompt = testPluginAgentsFinalPrompt(workspacePath)
    printFinalPrompt("PLUGIN AGENTS", pluginPrompt)
    console.log("PASS plugin AGENTS final system prompt")
    testTaskSubagentPromptModeMatrix()
    console.log("PASS task subagent prompt mode matrix")
  })
}

async function runHarnessCliMode(cliOptions: CliOptions): Promise<void> {
  const workspacePath = resolveExistingWorkspace(requireCliOption(cliOptions.workspace, "--workspace"))
  const projectId = requireCliOption(cliOptions.projectId, "--project-id")
  const feature = requireCliOption(cliOptions.feature, "--feature")
  const { buildHarnessFeatureAgentContext } = await import(
    "../src/main/harness-board/service.ts"
  )
  const harnessContext = buildHarnessFeatureAgentContext({
    harnessFeature: {
      projectId,
      slug: feature,
      source: "runtime-final-system-prompt"
    }
  })

  assert(harnessContext, "Harness feature context should be resolved")

  const result = await buildRuntimePromptFromHarnessContext(
    workspacePath,
    harnessContext,
    cliOptions.extraSystemPrompt
  )
  const finalPrompt = captureFinalSystemPrompt(result.runtimePrompt)

  assert(
    finalPrompt === `${result.runtimePrompt}\n\n${LANGCHAIN_BASE_PROMPT}`,
    "Harness CLI final prompt should match runtime prompt plus LangChain base prompt"
  )
  if (result.harnessAgentsPromptLoaded) {
    assert(
      result.agentsLoadedPaths.length === 0,
      "workspace AGENTS.md should not be loaded when Harness plugin AGENTS prompt is loaded"
    )
  }

  printRuntimePromptDiagnostics(result, harnessContext)
  printFinalPrompt("HARNESS CLI", finalPrompt)
  console.log("PASS harness CLI final system prompt")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
