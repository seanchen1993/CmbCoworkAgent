/**
 * Unit tests for the final system prompt passed into LangChain createAgent.
 *
 * Run:
 *   npx tsx tests/runtime-final-system-prompt.spec.ts
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { convertToOpenAITool } from "@langchain/core/utils/function_calling"
import { createMiddleware } from "langchain"
import { convertMessagesToCompletionsMessageParams } from "@langchain/openai"

import { loadAgentsPromptForWorkspace } from "../src/main/agent/agents-md.ts"
import { buildCoordinatorSystemPrompt } from "../src/main/agent/coordinator-mode.ts"
import { WORKFLOW_MODE_SYSTEM_PROMPT } from "../src/main/agent/workflow/prompts.ts"
import {
  createConciseOutputStyleTurnReminderMiddleware,
  createDeepAgent,
  createOutputStyleTurnReminderMiddleware,
  createToolStrategyTurnReminderMiddleware,
  getSystemPrompt
} from "../src/main/agent/runtime.ts"
import {
  CONCISE_OUTPUT_STYLE_PROMPT,
  CONCISE_OUTPUT_STYLE_TURN_REMINDER,
  EXPLANATORY_OUTPUT_STYLE_PROMPT,
  EXPLANATORY_OUTPUT_STYLE_TURN_REMINDER,
  LEARNING_OUTPUT_STYLE_PROMPT,
  LEARNING_OUTPUT_STYLE_TURN_REMINDER,
  OUTPUT_STYLE_IDENTITY_PROMPT,
  TASK_COMPLETION_AND_REPETITION_PROMPT
} from "../src/main/agent/system-prompt.ts"
import type { HarnessFeatureAgentContext } from "../src/main/harness-board/service.ts"
import type { AgentOutputStyle } from "../src/shared/agent-output-style.ts"
import type { CoordinatorWorkerFilesystemAccess } from "../src/main/agent/coordinator-worker-access.ts"
import {
  getToolStrategyReminder,
  resolveWorkflowToolStrategy
} from "../src/main/agent/tool-strategy.ts"
import {
  configureAgentToolStrategy,
  type AgentToolStrategy
} from "../src/shared/agent-runtime-limits.ts"

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

function readOptionValue(
  argv: string[],
  index: number,
  name: string
): { value: string; next: number } {
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
    throw new Error(
      `Workspace path does not exist or cannot be resolved: ${workspacePath}\n${detail}`
    )
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
    includeSubagents: true
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

function captureFinalSystemPrompt(
  systemPrompt: string,
  conciseModeEnabled = false,
  outputStyle?: AgentOutputStyle
): string {
  let captured = ""
  createDeepAgent({
    model: "test-model",
    tools: [],
    systemPrompt,
    includeGeneralPurposeSubagent: false,
    mainFilesystemEnabled: false,
    mainTodosEnabled: false,
    mainSubagentsEnabled: false,
    conciseModeEnabled,
    outputStyle,
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
  conciseModeEnabled?: boolean
}): Map<string, string> {
  let captured: TaskSubagentPromptSnapshot[] = []
  createDeepAgent({
    model: "test-model",
    tools: [],
    systemPrompt: "TASK_SUBAGENT_MAIN_PROMPT",
    mainFilesystemEnabled: false,
    mainTodosEnabled: false,
    mainSubagentsEnabled: options.mainSubagentsEnabled ?? true,
    conciseModeEnabled: options.conciseModeEnabled ?? false,
    subagentExtraSystemPrompt: options.projectContext,
    subagentExtraSystemPromptForRestrictedRoles: options.projectMode,
    subagents: [
      {
        name: "custom",
        description: "Custom task subagent",
        systemPrompt: "CUSTOM_BASE_PROMPT"
      }
    ],
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

  const concisePrompts = captureTaskSubagentPrompts({
    projectMode: true,
    projectContext: TASK_PROJECT_CONTEXT,
    conciseModeEnabled: true
  })
  for (const [name, prompt] of concisePrompts) {
    assert(
      !prompt.includes(CONCISE_OUTPUT_STYLE_PROMPT),
      `${name} should not inherit the main agent concise output style`
    )
    assert(
      !prompt.includes(CONCISE_OUTPUT_STYLE_TURN_REMINDER),
      `${name} should not inherit the main agent concise turn reminder`
    )
  }
}

async function testConciseOutputStyleContract(): Promise<void> {
  const runtimePrompt = "CONCISE_STYLE_RUNTIME_PROMPT"
  const defaultPrompt = captureFinalSystemPrompt(runtimePrompt)
  assert(
    defaultPrompt === `${runtimePrompt}\n\n${LANGCHAIN_BASE_PROMPT}`,
    "disabled concise mode must preserve the existing final system prompt byte-for-byte"
  )
  assert(
    !defaultPrompt.includes(CONCISE_OUTPUT_STYLE_PROMPT),
    "disabled concise mode must not inject the output style"
  )
  assert(
    !defaultPrompt.includes(OUTPUT_STYLE_IDENTITY_PROMPT),
    "default mode must preserve the original identity framing"
  )

  const concisePrompt = captureFinalSystemPrompt(runtimePrompt, true)
  assert(
    concisePrompt ===
      `${OUTPUT_STYLE_IDENTITY_PROMPT}\n\n${defaultPrompt}\n\n${CONCISE_OUTPUT_STYLE_PROMPT}`,
    "enabled concise mode should use Claude Code's output-style identity framing"
  )
  assert(
    countOccurrences(concisePrompt, CONCISE_OUTPUT_STYLE_PROMPT) === 1,
    "enabled concise mode should inject the full style exactly once"
  )

  const middleware = createConciseOutputStyleTurnReminderMiddleware()
  assert(middleware.wrapModelCall, "concise reminder middleware should expose wrapModelCall")

  const originalSystemMessage = new SystemMessage("ORIGINAL_SYSTEM_PROMPT")
  const originalUserMessage = new HumanMessage("ORIGINAL_USER_PROMPT")
  let forwardedRequest: { systemMessage?: SystemMessage; messages?: HumanMessage[] } | undefined
  await middleware.wrapModelCall!(
    { systemMessage: originalSystemMessage, messages: [originalUserMessage] } as never,
    async (request: unknown) => {
      forwardedRequest = request as { systemMessage?: SystemMessage; messages?: HumanMessage[] }
      return {} as never
    }
  )
  const forwardedContent = JSON.stringify(forwardedRequest?.messages?.[0]?.content)
  assert(
    forwardedContent.includes(CONCISE_OUTPUT_STYLE_TURN_REMINDER),
    "enabled concise mode should merge an ephemeral reminder into the current user turn"
  )
  assert(
    forwardedRequest?.systemMessage === originalSystemMessage,
    "user-turn reminder injection must preserve the system message"
  )
  assert(
    !JSON.stringify(originalUserMessage.content).includes(CONCISE_OUTPUT_STYLE_TURN_REMINDER),
    "concise reminder middleware must not mutate the source user message"
  )
  assert(
    forwardedRequest?.messages?.length === 1 &&
      forwardedRequest.messages[0] !== originalUserMessage &&
      forwardedRequest.messages[0] instanceof HumanMessage,
    "user-turn reminder injection must replace only the last message without adding a turn"
  )

  const humanBlockContent = [
    { type: "text" as const, text: "ORIGINAL_USER_BLOCK" },
    { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA==" } }
  ]
  const originalBlockUserMessage = new HumanMessage({ content: humanBlockContent })
  let blockUserRequest: { messages?: HumanMessage[] } | undefined
  await middleware.wrapModelCall!(
    { systemMessage: originalSystemMessage, messages: [originalBlockUserMessage] } as never,
    async (request: unknown) => {
      blockUserRequest = request as { messages?: HumanMessage[] }
      return {} as never
    }
  )
  assert(
    Array.isArray(blockUserRequest?.messages?.[0]?.content) &&
      blockUserRequest.messages[0].content.length === humanBlockContent.length + 1 &&
      JSON.stringify(blockUserRequest.messages[0].content).includes(
        CONCISE_OUTPUT_STYLE_TURN_REMINDER
      ),
    "user-turn reminder injection must preserve block content and append one text block"
  )
  assert(
    originalBlockUserMessage.content === humanBlockContent &&
      !JSON.stringify(originalBlockUserMessage.content).includes(
        CONCISE_OUTPUT_STYLE_TURN_REMINDER
      ),
    "block user reminder injection must not mutate source content"
  )

  const toolArtifact = { fullOutput: "FULL_OUTPUT" }
  const toolMetadata = { provider: "test" }
  const toolAdditionalKwargs = { source: "unit" }
  const toolResponseMetadata = { latencyMs: 10 }
  const originalToolMessage = new ToolMessage({
    content: "ORIGINAL_TOOL_RESULT",
    tool_call_id: "tool-call-1",
    id: "tool-message-1",
    name: "execute",
    status: "success",
    artifact: toolArtifact,
    metadata: toolMetadata,
    additional_kwargs: toolAdditionalKwargs,
    response_metadata: toolResponseMetadata
  })
  const assistantToolCall = new AIMessage({
    content: "",
    tool_calls: [{ id: "tool-call-1", name: "execute", args: {} }]
  })
  let toolRequest: { systemMessage?: SystemMessage; messages?: unknown[] } | undefined
  await middleware.wrapModelCall!(
    {
      systemMessage: originalSystemMessage,
      messages: [assistantToolCall, originalToolMessage]
    } as never,
    async (request: unknown) => {
      toolRequest = request as { systemMessage?: SystemMessage; messages?: unknown[] }
      return {} as never
    }
  )
  const forwardedToolMessage = toolRequest?.messages?.[1]
  assert(
    toolRequest?.messages?.length === 2 &&
      toolRequest.messages[0] === assistantToolCall &&
      forwardedToolMessage instanceof ToolMessage &&
      forwardedToolMessage !== originalToolMessage,
    "tool-turn reminder injection must replace only the last tool result without adding a user turn"
  )
  assert(
    JSON.stringify(forwardedToolMessage.content).includes(CONCISE_OUTPUT_STYLE_TURN_REMINDER) &&
      !JSON.stringify(originalToolMessage.content).includes(CONCISE_OUTPUT_STYLE_TURN_REMINDER),
    "tool-turn reminder injection must be ephemeral and must not mutate source content"
  )
  assert(
    forwardedToolMessage.tool_call_id === originalToolMessage.tool_call_id &&
      forwardedToolMessage.id === originalToolMessage.id &&
      forwardedToolMessage.name === originalToolMessage.name &&
      forwardedToolMessage.status === originalToolMessage.status &&
      forwardedToolMessage.artifact === toolArtifact &&
      forwardedToolMessage.metadata === toolMetadata &&
      forwardedToolMessage.additional_kwargs === toolAdditionalKwargs &&
      forwardedToolMessage.response_metadata === toolResponseMetadata,
    "tool-turn reminder injection must preserve every ToolMessage routing and metadata field"
  )
  assert(
    toolRequest?.systemMessage === originalSystemMessage,
    "tool-turn reminder injection must preserve the system message"
  )

  const serializedToolRequest = convertMessagesToCompletionsMessageParams({
    messages: toolRequest?.messages as [AIMessage, ToolMessage],
    model: "openai-compatible-model"
  })
  assert(
    serializedToolRequest.length === 2 &&
      serializedToolRequest[1].role === "tool" &&
      "tool_call_id" in serializedToolRequest[1] &&
      serializedToolRequest[1].tool_call_id === "tool-call-1" &&
      JSON.stringify(serializedToolRequest[1].content).includes(CONCISE_OUTPUT_STYLE_TURN_REMINDER),
    "OpenAI-compatible serialization must retain the tool role, call id, and reminder"
  )

  let repeatedToolRequest: { messages?: unknown[] } | undefined
  await middleware.wrapModelCall!(
    {
      systemMessage: originalSystemMessage,
      messages: [assistantToolCall, originalToolMessage]
    } as never,
    async (request: unknown) => {
      repeatedToolRequest = request as { messages?: unknown[] }
      return {} as never
    }
  )
  assert(
    countOccurrences(
      JSON.stringify(repeatedToolRequest?.messages?.[1]),
      CONCISE_OUTPUT_STYLE_TURN_REMINDER
    ) === 1 &&
      countOccurrences(
        JSON.stringify(originalToolMessage.content),
        CONCISE_OUTPUT_STYLE_TURN_REMINDER
      ) === 0,
    "reusing checkpoint messages across model calls must inject exactly one ephemeral reminder"
  )

  const earlierToolMessage = new ToolMessage({
    content: "EARLIER_TOOL_RESULT",
    tool_call_id: "tool-call-earlier"
  })
  let consecutiveToolRequest: { messages?: unknown[] } | undefined
  await middleware.wrapModelCall!(
    {
      systemMessage: originalSystemMessage,
      messages: [assistantToolCall, earlierToolMessage, originalToolMessage]
    } as never,
    async (request: unknown) => {
      consecutiveToolRequest = request as { messages?: unknown[] }
      return {} as never
    }
  )
  assert(
    consecutiveToolRequest?.messages?.length === 3 &&
      consecutiveToolRequest.messages[1] === earlierToolMessage &&
      !JSON.stringify(consecutiveToolRequest.messages[1]).includes(
        CONCISE_OUTPUT_STYLE_TURN_REMINDER
      ) &&
      JSON.stringify(consecutiveToolRequest.messages[2]).includes(
        CONCISE_OUTPUT_STYLE_TURN_REMINDER
      ),
    "parallel tool results must keep earlier siblings intact and smoosh the reminder into only the last result"
  )

  const originalBlockToolMessage = new ToolMessage({
    content: [{ type: "text" as const, text: "ORIGINAL_TOOL_BLOCK" }],
    tool_call_id: "tool-call-2"
  })
  let blockToolRequest: { messages?: unknown[] } | undefined
  await middleware.wrapModelCall!(
    { systemMessage: originalSystemMessage, messages: [originalBlockToolMessage] } as never,
    async (request: unknown) => {
      blockToolRequest = request as { messages?: unknown[] }
      return {} as never
    }
  )
  const forwardedBlockToolMessage = blockToolRequest?.messages?.[0]
  assert(
    forwardedBlockToolMessage instanceof ToolMessage &&
      Array.isArray(forwardedBlockToolMessage.content) &&
      forwardedBlockToolMessage.content.length === 2 &&
      JSON.stringify(forwardedBlockToolMessage.content).includes(
        CONCISE_OUTPUT_STYLE_TURN_REMINDER
      ) &&
      Array.isArray(originalBlockToolMessage.content) &&
      originalBlockToolMessage.content.length === 1,
    "tool-turn reminder injection must preserve block content and append one text block"
  )

  const assistantMessage = new AIMessage("ORIGINAL_ASSISTANT_MESSAGE")
  let fallbackRequest: { systemMessage?: SystemMessage; messages?: unknown[] } | undefined
  await middleware.wrapModelCall!(
    { systemMessage: originalSystemMessage, messages: [assistantMessage] } as never,
    async (request: unknown) => {
      fallbackRequest = request as { systemMessage?: SystemMessage; messages?: unknown[] }
      return {} as never
    }
  )
  assert(
    fallbackRequest?.messages?.length === 1 &&
      fallbackRequest.messages[0] === assistantMessage &&
      JSON.stringify(fallbackRequest.systemMessage?.content).includes(
        CONCISE_OUTPUT_STYLE_TURN_REMINDER
      ) &&
      !JSON.stringify(originalSystemMessage.content).includes(CONCISE_OUTPUT_STYLE_TURN_REMINDER),
    "unexpected message shapes must use an ephemeral system fallback without adding a user turn"
  )

  let emptyFallbackRequest: { systemMessage?: SystemMessage; messages?: unknown[] } | undefined
  await middleware.wrapModelCall!({ messages: [] } as never, async (request: unknown) => {
    emptyFallbackRequest = request as { systemMessage?: SystemMessage; messages?: unknown[] }
    return {} as never
  })
  assert(
    emptyFallbackRequest?.messages?.length === 0 &&
      emptyFallbackRequest.systemMessage instanceof SystemMessage &&
      JSON.stringify(emptyFallbackRequest.systemMessage.content).includes(
        CONCISE_OUTPUT_STYLE_TURN_REMINDER
      ),
    "empty requests must receive a system fallback without creating a user turn"
  )
}

async function testAdditionalOutputStyleContracts(): Promise<void> {
  const runtimePrompt = "ADDITIONAL_STYLE_RUNTIME_PROMPT"
  const defaultPrompt = captureFinalSystemPrompt(runtimePrompt)
  const styles: Array<{
    style: AgentOutputStyle
    prompt: string
    reminder: string
  }> = [
    {
      style: "explanatory",
      prompt: EXPLANATORY_OUTPUT_STYLE_PROMPT,
      reminder: EXPLANATORY_OUTPUT_STYLE_TURN_REMINDER
    },
    {
      style: "learning",
      prompt: LEARNING_OUTPUT_STYLE_PROMPT,
      reminder: LEARNING_OUTPUT_STYLE_TURN_REMINDER
    }
  ]

  for (const { style, prompt, reminder } of styles) {
    const styledPrompt = captureFinalSystemPrompt(runtimePrompt, false, style)
    assert(
      styledPrompt === `${OUTPUT_STYLE_IDENTITY_PROMPT}\n\n${defaultPrompt}\n\n${prompt}`,
      `${style} should use Claude Code's output-style identity framing`
    )
    assert(
      countOccurrences(styledPrompt, prompt) === 1,
      `${style} should inject its full system prompt exactly once`
    )

    const middleware = createOutputStyleTurnReminderMiddleware(style)
    const originalUserMessage = new HumanMessage("ORIGINAL_USER_PROMPT")
    let forwardedRequest: { messages?: HumanMessage[] } | undefined
    await middleware.wrapModelCall!(
      { messages: [originalUserMessage] } as never,
      async (request: unknown) => {
        forwardedRequest = request as { messages?: HumanMessage[] }
        return {} as never
      }
    )
    assert(
      JSON.stringify(forwardedRequest?.messages?.[0]?.content).includes(reminder),
      `${style} should merge its ephemeral reminder into the current user turn`
    )
    assert(
      !JSON.stringify(originalUserMessage.content).includes(reminder),
      `${style} reminder middleware must not mutate the source user message`
    )
  }

  for (const prompt of [
    CONCISE_OUTPUT_STYLE_PROMPT,
    EXPLANATORY_OUTPUT_STYLE_PROMPT,
    LEARNING_OUTPUT_STYLE_PROMPT
  ]) {
    assert(!defaultPrompt.includes(prompt), "default output style must not inject any style prompt")
  }
  assert(
    !defaultPrompt.includes(OUTPUT_STYLE_IDENTITY_PROMPT),
    "default output style must not inject Claude Code's style identity framing"
  )
  assert(
    LEARNING_OUTPUT_STYLE_PROMPT.includes(
      "This pause is a deliberate user-input handoff, not task completion"
    ) && LEARNING_OUTPUT_STYLE_PROMPT.includes("complete and verify the remaining work"),
    "learning style should resume and finish after its intentional user contribution pause"
  )
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
  console.log(
    `sessionContextInjectWarning: ${harnessContext.sessionContextInjectWarning ?? "<none>"}`
  )
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

function testSoloPromptOmitsTaskToolGuidance(workspacePath: string): void {
  const soloPrompt = buildBaseRuntimePrompt(workspacePath, undefined, {
    includeSubagents: false
  })
  const multiPrompt = buildBaseRuntimePrompt(workspacePath, undefined, {
    includeSubagents: true
  })

  assert(
    !soloPrompt.includes("## Working with Subagents (task tool)"),
    "Solo prompt should omit task guidance"
  )
  assert(
    multiPrompt.includes("## Working with Subagents (task tool)"),
    "Multi prompt should include task guidance"
  )
}

function assertCompletionAndRepetitionContract(prompt: string, agentLabel: string): void {
  assert(
    countOccurrences(prompt, TASK_COMPLETION_AND_REPETITION_PROMPT) === 1,
    `${agentLabel} should receive the shared completion and repetition contract exactly once`
  )
  assert(
    !prompt.includes("After working on a file, just stop"),
    `${agentLabel} must not retain the premature-stop instruction`
  )
  assert(
    !prompt.includes("ALWAYS ask the user if the plan looks good") &&
      !prompt.includes("Wait for the user's response before marking the first todo"),
    `${agentLabel} should not require an unnecessary planning-confirmation pause`
  )
  assert(
    prompt.includes("Never repeat a user-denied call unless the user explicitly requests it again"),
    `${agentLabel} should prioritize the user-denial rule before other retry conditions`
  )
  assert(
    !prompt.includes("Retry identical arguments only when"),
    `${agentLabel} must not retain the ambiguous retry rule that preceded user-denial handling`
  )
}

function testDefaultCompletionAndRepetitionContract(workspacePath: string): void {
  const finalMainPrompt = captureFinalSystemPrompt(buildBaseRuntimePrompt(workspacePath))
  assertCompletionAndRepetitionContract(finalMainPrompt, "ordinary main agent")
  assert(
    finalMainPrompt.includes("continue with the first actionable item in the same turn"),
    "ordinary main agent should continue after creating a todo list"
  )

  const finalCoordinatorPrompt = captureFinalSystemPrompt(
    buildCoordinatorSystemPrompt({
      threadId: "runtime-final-coordinator",
      workspacePath,
      platform: process.platform,
      shell: "zsh",
      timezone: "Asia/Shanghai",
      currentTime: "2026-09-03T00:00:00+08:00",
      hasCodeExecTool: false,
      deferredToolIds: []
    })
  )
  assertCompletionAndRepetitionContract(finalCoordinatorPrompt, "coordinator main agent")
  assert(
    finalCoordinatorPrompt.includes("asynchronous handoff, not a completion claim") &&
      finalCoordinatorPrompt.includes("Continue from task notifications until the whole request"),
    "coordinator main agent should distinguish asynchronous turn boundaries from completion"
  )

  const finalWorkflowPrompt = captureFinalSystemPrompt(
    `${buildBaseRuntimePrompt(workspacePath)}${WORKFLOW_MODE_SYSTEM_PROMPT}`
  )
  assertCompletionAndRepetitionContract(finalWorkflowPrompt, "workflow main agent")
  assert(
    finalWorkflowPrompt.includes("an asynchronous handoff, not a claim") &&
      finalWorkflowPrompt.includes("continue when the task notification arrives"),
    "workflow main agent should distinguish asynchronous turn boundaries from completion"
  )

  const taskSubagentPrompts = captureTaskSubagentPrompts({ projectMode: false })
  for (const [name, prompt] of taskSubagentPrompts) {
    assertCompletionAndRepetitionContract(prompt, `task subagent ${name}`)
  }
}

interface ToolStrategyRequest {
  messages: BaseMessage[]
  tools: Array<{ name: string; description?: string; parameters: unknown }>
}

// Real createDeepAgent graph + real middleware; only the model/backend I/O is fake.
// Each bind gets a separate model view so concurrent task agents cannot mix tools.
class ToolStrategyContractModel extends BaseChatModel {
  constructor(
    private readonly calls: ToolStrategyRequest[],
    private readonly reply: (messages: BaseMessage[]) => AIMessage,
    private readonly boundTools: ToolStrategyRequest["tools"] = []
  ) {
    super({})
  }
  _llmType(): string {
    return "tool-strategy-contract"
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bindTools(tools: any[]): ToolStrategyContractModel {
    return new ToolStrategyContractModel(
      this.calls,
      this.reply,
      tools.map((tool) => convertToOpenAITool(tool).function)
    )
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push({ messages, tools: this.boundTools })
    const message = this.reply(messages)
    return { generations: [{ text: String(message.content), message }] }
  }
}

const finishedStrategyMessage = (): AIMessage =>
  new AIMessage({
    content: "Verified result",
    response_metadata: { finish_reason: "stop" }
  })
const requestText = (messages: BaseMessage[]): string =>
  messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")

async function testToolStrategyFinalRequests(workspacePath: string): Promise<void> {
  let executeCount = 0
  const backend = {
    id: "tool-strategy-contract",
    execute: async () => {
      executeCount++
      return { output: "sample", exitCode: 0 }
    }
  }
  const makeOptions = (toolStrategy?: AgentToolStrategy, outputStyle?: AgentOutputStyle) => ({
    backend,
    toolStrategy,
    outputStyle,
    mainSubagentsEnabled: false,
    mainTodosEnabled: false,
    includeGeneralPurposeSubagent: false,
    systemPrompt:
      getSystemPrompt(workspacePath, undefined, {
        toolStrategy,
        includeBackgroundExec: false,
        includeCurrentTime: false,
        includeMemory: false,
        includeSubagents: false
      }) + "\nPROJECT_SENTINEL: use read_file for a special project workflow."
  })
  let defaultRequest: ToolStrategyRequest | undefined
  for (const strategy of [undefined, "standard", "shell-first", "shell-first-relaxed"] as const) {
    for (const style of ["default", "concise", "explanatory", "learning"] as const) {
      const calls: ToolStrategyRequest[] = []
      const model = new ToolStrategyContractModel(calls, (messages) =>
        messages.at(-1)?._getType() === "tool"
          ? finishedStrategyMessage()
          : new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "inspect",
                  name: "execute",
                  args: { command: "inspect-fixture" },
                  type: "tool_call"
                }
              ]
            })
      )
      const original = new HumanMessage("Inspect the fixture")
      const agent = createDeepAgent({ ...makeOptions(strategy, style), model })
      const result = await agent.invoke({ messages: [original] })
      assert(calls.length === 2, "strategy must not create an extra model/user turn")
      assert(original.content === "Inspect the fixture", "source human content must stay unchanged")
      assert(
        !requestText(result.messages).includes("## Tool strategy:"),
        "strategy reminder must not enter graph state/history"
      )
      const active = strategy === "shell-first" || strategy === "shell-first-relaxed"
      for (const call of calls) {
        const text = requestText(call.messages)
        const count = text.split("## Tool strategy:").length - 1
        assert(count === (active ? 1 : 0), `unexpected reminder count: ${strategy}/${style}`)
        assert(
          text.includes("PROJECT_SENTINEL: use read_file for a special project workflow."),
          "project instructions must remain intact"
        )
        const description = call.tools.find((t) => t.name === "execute")!.description!
        assert(
          description.includes("MUST avoid") === !active,
          "bound execute description must match strategy"
        )
        if (active) {
          assert(
            description.includes(
              "subject to the active sandbox, approval, role, and workspace restrictions"
            ),
            "shell-first execute description must state the active execution restrictions"
          )
          assert(
            !description.includes("on the user's machine"),
            "shell-first execute description must not imply unrestricted host execution"
          )
        }
        assert(
          text.includes("Avoid using shell for file reading") === !active,
          "final base prompt must match strategy"
        )
        for (const name of ["execute", "read_file", "edit_file", "write_file"]) {
          assert(
            call.tools.some((t) => t.name === name),
            "strategy must preserve " + name
          )
        }
      }
      if (style === "default") {
        if (strategy === undefined) defaultRequest = calls[0]
        else if (strategy === "standard") {
          assert(
            requestText(calls[0].messages) === requestText(defaultRequest!.messages),
            "explicit standard must preserve default outgoing messages"
          )
          assert(
            JSON.stringify(calls[0].tools) === JSON.stringify(defaultRequest!.tools),
            "explicit standard must preserve default bound tool schemas/descriptions"
          )
        } else {
          assert(
            JSON.stringify(calls[0].tools.map(({ name, parameters }) => ({ name, parameters }))) ===
              JSON.stringify(
                defaultRequest!.tools.map(({ name, parameters }) => ({ name, parameters }))
              ),
            "enabled strategy must not change tool schemas"
          )
        }
      }
    }
  }
  assert(executeCount === 16, "all modes must use the same execute backend")

  // Each request is checked after late tool filtering, not just at construction.
  const filtered: ToolStrategyRequest[] = []
  const filteredAgent = createDeepAgent({
    ...makeOptions("shell-first"),
    model: new ToolStrategyContractModel(filtered, finishedStrategyMessage),
    middleware: [
      createMiddleware({
        name: "lateToolFilter",
        wrapModelCall: (request, handler) =>
          handler({
            ...request,
            tools: request.tools.filter((tool) => !("name" in tool && tool.name === "execute"))
          })
      })
    ]
  })
  await filteredAgent.invoke({ messages: [new HumanMessage("Report")] })
  assert(
    !requestText(filtered[0].messages).includes("## Tool strategy:"),
    "removed execute must suppress the reminder"
  )

  // An already-assembled runtime does not hot-switch; metadata-only/default
  // low-level construction does not implicitly read the global strategy either.
  const frozen: ToolStrategyRequest[] = []
  const frozenAgent = createDeepAgent({
    ...makeOptions("shell-first"),
    model: new ToolStrategyContractModel(frozen, finishedStrategyMessage)
  })
  try {
    configureAgentToolStrategy("standard")
    await frozenAgent.invoke({ messages: [new HumanMessage("Report")] })
    assert(
      requestText(frozen[0].messages).includes("## Tool strategy: shell-first"),
      "runtime strategy must stay captured"
    )
    configureAgentToolStrategy("shell-first")
    const lowLevel: ToolStrategyRequest[] = []
    await createDeepAgent({
      ...makeOptions(),
      model: new ToolStrategyContractModel(lowLevel, finishedStrategyMessage)
    }).invoke({ messages: [new HumanMessage("Report")] })
    assert(
      !requestText(lowLevel[0].messages).includes("## Tool strategy:"),
      "low-level default must remain standard independently of global configuration"
    )
  } finally {
    configureAgentToolStrategy("standard")
  }

  const noOp = createToolStrategyTurnReminderMiddleware("standard")
  const request = {
    messages: [new HumanMessage("original")],
    tools: [{ name: "execute" }, { name: "write_file" }]
  }
  await noOp.wrapModelCall!(request as never, async (forwarded: unknown) => {
    assert(forwarded === request, "standard reminder must forward the identical request")
    return {} as never
  })
}

async function testWorkflowToolStrategyRequests(workspacePath: string): Promise<void> {
  let standard: ToolStrategyRequest | undefined
  for (const requested of ["standard", "shell-first", "shell-first-relaxed"] as const) {
    for (const yoloMode of [false, true]) {
      const calls: ToolStrategyRequest[] = []
      const toolStrategy = resolveWorkflowToolStrategy(requested, yoloMode)
      const agent = createDeepAgent({
        model: new ToolStrategyContractModel(calls, finishedStrategyMessage),
        toolStrategy,
        systemPrompt: getSystemPrompt(workspacePath, undefined, {
          toolStrategy,
          includeBackgroundExec: false,
          includeCurrentTime: false,
          includeMemory: false,
          includeSubagents: false
        }),
        backend: { id: "workflow-strategy", execute: async () => ({ output: "", exitCode: 0 }) },
        mainSubagentsEnabled: false,
        mainTodosEnabled: false,
        includeGeneralPurposeSubagent: false
      })
      await agent.invoke({ messages: [new HumanMessage("Edit the workflow files")] })
      assert(calls.length === 1, "workflow strategy must not add a model turn")
      const call = calls[0]
      const active = yoloMode && requested !== "standard"
      if (!standard) standard = call
      if (!active) {
        assert(
          !requestText(call.messages).includes("## Tool strategy:"),
          "standard and approval-gated workflow leaves must not receive Bash First steering"
        )
        assert(
          requestText(call.messages) === requestText(standard.messages),
          "approval-gated workflow leaves must retain the complete standard prompt"
        )
        assert(
          JSON.stringify(call.tools) === JSON.stringify(standard.tools),
          "approval-gated workflow leaves must retain standard tool descriptions and schemas"
        )
      } else {
        assert(
          requestText(call.messages).includes(getToolStrategyReminder(requested)),
          "YOLO workflow leaves must retain the requested Bash First reminder"
        )
        assert(
          !call.tools.find((tool) => tool.name === "execute")!.description!.includes("MUST avoid"),
          "YOLO workflow leaves must not receive conflicting shell guidance"
        )
      }
    }
  }
}

async function testRestrictedRuntimeToolStrategyRequests(workspacePath: string): Promise<void> {
  const roles: Array<{
    name: string
    filesystemAccess?: CoordinatorWorkerFilesystemAccess
    mainBlockedToolNames?: string[]
    mainFilesystemEnabled?: boolean
  }> = [
    { name: "read-only worker", filesystemAccess: { workload: "read_only" } },
    { name: "verify worker", filesystemAccess: { workload: "verify" } },
    { name: "no shell", filesystemAccess: { shellAccess: "none" } },
    { name: "read-only shell", filesystemAccess: { shellAccess: "read_only" } },
    {
      name: "owned files",
      filesystemAccess: { ownedFiles: [join(workspacePath, "owned.ts")] }
    },
    { name: "blocked execute", mainBlockedToolNames: ["execute"] },
    { name: "blocked writers", mainBlockedToolNames: ["edit_file", "write_file"] },
    { name: "no filesystem", mainFilesystemEnabled: false }
  ]
  for (const role of roles) {
    let standard: ToolStrategyRequest | undefined
    for (const toolStrategy of ["standard", "shell-first", "shell-first-relaxed"] as const) {
      const calls: ToolStrategyRequest[] = []
      const promptOptions = {
        toolStrategy,
        filesystemAccess: role.filesystemAccess,
        blockedToolNames: role.mainBlockedToolNames,
        filesystemEnabled: role.mainFilesystemEnabled,
        includeBackgroundExec: false,
        includeCurrentTime: false,
        includeMemory: false,
        includeSubagents: false
      }
      await createDeepAgent({
        ...role,
        model: new ToolStrategyContractModel(calls, finishedStrategyMessage),
        backend: {
          id: "restricted-strategy-contract",
          execute: async () => {
            throw new Error("No shell I/O expected in prompt test")
          }
        },
        toolStrategy,
        systemPrompt: getSystemPrompt(workspacePath, undefined, promptOptions),
        mainSubagentsEnabled: false,
        mainTodosEnabled: false,
        includeGeneralPurposeSubagent: false
      }).invoke({ messages: [new HumanMessage("Report status")] })
      assert(calls.length === 1, `${role.name}: expected one model request`)
      const call = calls[0]
      const text = requestText(call.messages)
      assert(!text.includes("## Tool strategy:"), `${role.name}: no Bash First reminder`)
      assert(
        text.includes("Avoid using shell for file reading"),
        `${role.name}: original file-reading guidance must remain in ${toolStrategy}`
      )
      assert(
        text.includes("Avoid using shell for file searching"),
        `${role.name}: original file-search guidance must remain in ${toolStrategy}`
      )
      if (toolStrategy === "standard") standard = call
      else {
        assert(
          text === requestText(standard!.messages),
          `${role.name}: restricted outgoing prompt must match standard in ${toolStrategy}`
        )
        assert(
          JSON.stringify(call.tools) === JSON.stringify(standard!.tools),
          `${role.name}: tool descriptions and schemas must match standard in ${toolStrategy}`
        )
      }
    }
  }
}

async function testToolStrategySubagentRequests(
  toolStrategy: "shell-first" | "shell-first-relaxed",
  mainFilesystemEnabled = false
): Promise<void> {
  const calls: ToolStrategyRequest[] = []
  const model = new ToolStrategyContractModel(calls, (messages) => {
    const text = requestText(messages.filter((m) => m._getType() === "system"))
    if (
      text.includes("ROLE_READER") ||
      text.includes("ROLE_WRITER") ||
      messages.at(-1)?._getType() === "tool"
    )
      return finishedStrategyMessage()
    return new AIMessage({
      content: "",
      tool_calls: ["Reader", "Writer"].map((role) => ({
        id: role,
        name: "task",
        type: "tool_call" as const,
        args: { description: "Report the fixture status", subagent_type: role }
      }))
    })
  })
  const agent = createDeepAgent({
    model,
    toolStrategy,
    systemPrompt: "ROLE_COORDINATOR",
    backend: { id: "subagent-strategy", execute: async () => ({ output: "", exitCode: 0 }) },
    mainFilesystemEnabled,
    mainBlockedToolNames: mainFilesystemEnabled ? ["write_file", "edit_file"] : [],
    mainTodosEnabled: false,
    includeGeneralPurposeSubagent: false,
    registrySubagentSpecs: [
      {
        name: "Reader",
        description: "Read only",
        systemPrompt: "ROLE_READER",
        shellAccess: "read_only",
        disallowedTools: ["write_file", "edit_file"]
      },
      { name: "Writer", description: "Writable", systemPrompt: "ROLE_WRITER", shellAccess: "full" }
    ]
  })
  await agent.invoke({ messages: [new HumanMessage("Delegate inspection")] })
  const reader = calls.find((call) => requestText(call.messages).includes("ROLE_READER"))
  const writer = calls.find((call) => requestText(call.messages).includes("ROLE_WRITER"))
  assert(reader && writer, "both actual task subagents must reach the model")
  assert(
    !requestText(reader.messages).includes("## Tool strategy:"),
    "read-only task must not receive edit steering"
  )
  assert(
    !reader.tools.some((tool) => tool.name === "edit_file" || tool.name === "write_file"),
    "read-only task must stay read-only"
  )
  const readerExecute = reader.tools.find((tool) => tool.name === "execute")
  const writerExecute = writer.tools.find((tool) => tool.name === "execute")
  assert(readerExecute && writerExecute, "both roles must retain their existing execute tool")
  const sharedDescription = readerExecute.description ?? ""
  assert(
    !sharedDescription.includes("ordinary local text-file inspection and edits"),
    "shared execute description must not advertise text-file editing to a read-only task"
  )
  assert(
    sharedDescription.includes("active sandbox, approval, role, and workspace restrictions") &&
      sharedDescription.includes("this tool grants no additional permission"),
    "shared execute description must preserve explicit permission boundaries"
  )
  assert(
    sharedDescription === writerExecute.description,
    "siblings must keep the same neutral execute description without per-role mutation"
  )
  assert(
    requestText(writer.messages).includes(getToolStrategyReminder(toolStrategy)),
    "writable task must inherit requested preference from a non-filesystem parent"
  )
  assert(
    writer.tools.some((tool) => tool.name === "edit_file"),
    "writable sibling must retain its writer"
  )
  assert(
    !writerExecute.description!.includes("MUST avoid"),
    "parent downgrade must not restore conflicting shared descriptions for a writable child"
  )
  for (const call of calls.filter((call) =>
    requestText(call.messages.filter((m) => m._getType() === "system")).includes("ROLE_COORDINATOR")
  )) {
    assert(
      !requestText(call.messages).includes("## Tool strategy:"),
      "parent without filesystem or file writers must not be steered"
    )
    if (mainFilesystemEnabled) {
      assert(
        call.tools.find((tool) => tool.name === "execute")!.description!.includes("MUST avoid"),
        "parent without writers must retain its standard execute description"
      )
    }
  }
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
    testSoloPromptOmitsTaskToolGuidance(workspacePath)
    console.log("PASS Solo task-tool prompt exclusion")
    testDefaultCompletionAndRepetitionContract(workspacePath)
    console.log("PASS default completion and repetition contract")
    testTaskSubagentPromptModeMatrix()
    console.log("PASS task subagent prompt mode matrix")
    await testConciseOutputStyleContract()
    console.log("PASS concise output style contract")
    await testAdditionalOutputStyleContracts()
    console.log("PASS additional output style contracts")
    await testToolStrategyFinalRequests(workspacePath)
    console.log("PASS tool strategy final requests, tool schemas, and output-style matrix")
    await testWorkflowToolStrategyRequests(workspacePath)
    console.log("PASS workflow tool strategy approval-mode matrix")
    await testRestrictedRuntimeToolStrategyRequests(workspacePath)
    console.log("PASS restricted runtime prompts and tool descriptions remain standard")
    for (const toolStrategy of ["shell-first", "shell-first-relaxed"] as const) {
      await testToolStrategySubagentRequests(toolStrategy)
      await testToolStrategySubagentRequests(toolStrategy, true)
    }
    console.log("PASS tool strategy per-role task subagent requests")
  })
}

async function runHarnessCliMode(cliOptions: CliOptions): Promise<void> {
  const workspacePath = resolveExistingWorkspace(
    requireCliOption(cliOptions.workspace, "--workspace")
  )
  const projectId = requireCliOption(cliOptions.projectId, "--project-id")
  const feature = requireCliOption(cliOptions.feature, "--feature")
  const { buildHarnessFeatureAgentContext } = await import("../src/main/harness-board/service.ts")
  const harnessContext = await buildHarnessFeatureAgentContext({
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
