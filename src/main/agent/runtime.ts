/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createSkillsMiddleware,
  createMemoryMiddleware,
  createSummarizationMiddleware,
  StateBackend
} from "deepagents"
import {
  getThreadCheckpointPath,
  getEnabledSkillsSources,
  getEnabledMcpConnectors,
  getCustomModelConfigs,
  getUserInfo,
  isMemoryEnabled,
  DEFAULT_MAX_TOKENS,
  getEnabledPluginSkillsSources,
  getEnabledPluginMcpConfigs
} from "../storage"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import { buildMcpServerConfig } from "../ipc/mcp"

import { ChatOpenAI } from "@langchain/openai"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { LocalSandbox } from "./local-sandbox"
import {
  createAgent,
  ReactAgent,
  SystemMessage,
  todoListMiddleware,
  anthropicPromptCachingMiddleware,
  humanInTheLoopMiddleware
} from "langchain"
import { Runnable } from "@langchain/core/runnables"

import type * as _lcTypes from "langchain"
import type * as _lcMessages from "@langchain/core/messages"
import type * as _lcLanggraph from "@langchain/langgraph"
import type * as _lcZodTypes from "@langchain/core/utils/types"

import { createHash } from "crypto"
import path from "path"
import { join, delimiter } from "path"
import { existsSync, createWriteStream, statSync, unlinkSync } from "fs"
import { createReadStream } from "fs"
import { createGunzip } from "zlib"
import { pipeline } from "stream/promises"
import { app } from "electron"
import { BASE_SYSTEM_PROMPT, MEMORY_SYSTEM_PROMPT, LAZY_MCP_SYSTEM_PROMPT } from "./system-prompt"
import { getMemoryStore, closeMemoryStore } from "../memory/store"
import { createMemorySearchTool, createMemoryGetTool } from "../memory/tools"
import { createSchedulerTool } from "./tools/scheduler-tool"
import { createGitWorkflowTool } from "./tools/git-workflow-tool"
import {
  McpToolRegistry,
  createToolSearchTools,
  fixMcpToolSchema
} from "./tools/tool-search-tool"
import { getWindowsSandboxMode, getYoloMode } from "../storage"

/** Decompress codex.exe.gz → codex.exe if needed (re-extract if .gz is newer than .exe). */
async function ensureCodexExe(exePath: string): Promise<void> {
  const gzPath = exePath + ".gz"
  if (!existsSync(gzPath)) return
  if (existsSync(exePath)) {
    // Skip if exe is up-to-date (gz not newer)
    if (statSync(exePath).mtimeMs >= statSync(gzPath).mtimeMs) return
    // gz is newer — remove stale exe before re-extracting
    try { unlinkSync(exePath) } catch { /* ignore */ }
  }
  try {
    await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(exePath))
    console.log("[Runtime] codex.exe extracted from .gz")
  } catch (e) {
    console.error("[Runtime] Failed to extract codex.exe:", e)
  }
}

const BASE_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools."

const SEQUENTIAL_TASK_PROMPT = `## \`task\` (subagent spawner)

You have access to a \`task\` tool to launch short-lived subagents that handle isolated tasks. These agents are ephemeral — they live only for the duration of the task and return a single result.

When to use the task tool:
- When a task is complex and multi-step, and can be fully delegated in isolation
- When a task requires focused reasoning or heavy token/context usage that would bloat the orchestrator thread
- When sandboxing improves reliability (e.g. code execution, structured searches, data formatting)
- When you only care about the output of the subagent, and not the intermediate steps (ex. performing a lot of research and then returned a synthesized report, performing a series of computations or lookups to achieve a concise, relevant answer.)

Subagent lifecycle:
1. **Spawn** → Provide clear role, instructions, and expected output
2. **Run** → The subagent completes the task autonomously
3. **Return** → The subagent provides a single structured result
4. **Reconcile** → Incorporate or synthesize the result into the main thread

When NOT to use the task tool:
- If you need to see the intermediate reasoning or steps after the subagent has completed (the task tool hides them)
- If the task is trivial (a few tool calls or simple lookup)
- If delegating does not reduce token usage, complexity, or context switching
- If splitting would add latency without benefit

## Important Task Tool Usage Notes to Remember
- **CRITICAL: Only launch ONE subagent at a time.** Wait for the current subagent to finish and return its result before deciding whether to launch the next one. Do NOT spawn multiple subagents in parallel. This ensures stable context and predictable execution order.
- Remember to use the \`task\` tool to silo independent tasks within a multi-part objective.
- You should use the \`task\` tool whenever you have a complex task that will take multiple steps, and is independent from other tasks that the agent needs to complete. These agents are highly competent and efficient.`

/**
 * Custom version of deepagents' createDeepAgent.
 *
 * Aligned with official 1.8.1 except:
 *   - Accepts `summarizationTrigger` / `summarizationKeep` for explicit overrides
 *     (useful for custom models without a profile).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createDeepAgent(params: Record<string, any> = {}): ReactAgent<any> {
  const {
    model = "claude-sonnet-4-5-20250929",
    tools = [],
    systemPrompt,
    middleware: customMiddleware = [],
    subagents = [],
    responseFormat,
    contextSchema,
    checkpointer,
    store,
    backend,
    interruptOn,
    name,
    memory,
    skills,
    filesystemSystemPrompt,
    summarizationTrigger,
    summarizationKeep,
    toolTokenLimitBeforeEvict,
    trimTokensToSummarize
  } = params

  // --- systemPrompt handling (identical to original) ---
  const finalSystemPrompt = systemPrompt
    ? typeof systemPrompt === "string"
      ? `${systemPrompt}\n\n${BASE_PROMPT}`
      : new SystemMessage({
          content: [
            { type: "text" as const, text: BASE_PROMPT },
            ...(typeof systemPrompt.content === "string"
              ? [{ type: "text" as const, text: systemPrompt.content }]
              : systemPrompt.content)
          ]
        })
    : BASE_PROMPT

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filesystemBackend = backend ? backend : (config: any) => new StateBackend(config)

  const skillsMiddlewareArray =
    skills != null && skills.length > 0
      ? [createSkillsMiddleware({ backend: filesystemBackend, sources: skills })]
      : []

  const memoryMiddlewareArray =
    memory != null && memory.length > 0
      ? [createMemoryMiddleware({ backend: filesystemBackend, sources: memory })]
      : []

  // Process subagents: auto-inject SkillsMiddleware for subagents with their own skills
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processedSubagents = subagents.map((subagent: any) => {
    if (Runnable.isRunnable(subagent)) return subagent
    if (!("skills" in subagent) || subagent.skills?.length === 0) return subagent
    const subagentSkillsMiddleware = createSkillsMiddleware({
      backend: filesystemBackend,
      sources: subagent.skills ?? []
    })
    return {
      ...subagent,
      middleware: [subagentSkillsMiddleware, ...(subagent.middleware || [])]
    }
  })

  // Summarization options: pass explicit trigger/keep if provided, otherwise let
  // createSummarizationMiddleware auto-compute from the model profile.
  const summarizationOptions = {
    model,
    backend: filesystemBackend,
    historyPathPrefix: ".cmbdevclaw/conversation_history",
    ...(trimTokensToSummarize != null && { trimTokensToSummarize }),
    ...(summarizationTrigger != null && { trigger: summarizationTrigger }),
    ...(summarizationKeep != null && { keep: summarizationKeep }),
    truncateArgsSettings: {
      trigger: { type: "messages" as const, value: 20 },
      keep: { type: "messages" as const, value: 20 },
      maxLength: 1000
    }
  }

  // Create filesystem middleware and fix grep tool's misleading "Regex pattern" param description
  // (upstream bug: description says "Regex" but implementation uses literal -F matching)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createFsMiddleware = (): any => {
    const mw = createFilesystemMiddleware({
      backend: filesystemBackend,
      ...(filesystemSystemPrompt && { systemPrompt: filesystemSystemPrompt }),
      ...(toolTokenLimitBeforeEvict != null && { toolTokenLimitBeforeEvict })
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const grepTool = mw.tools?.find((t: any) => t.name === "grep") as any
    if (grepTool?.schema?.shape?.pattern) {
      const oldDesc = grepTool.schema.shape.pattern.description ?? "(unknown)"
      grepTool.schema = grepTool.schema.extend({
        pattern: grepTool.schema.shape.pattern.describe("Text pattern to search for (literal, not regex)")
      })
      console.log(`[Runtime] grep schema patched: "${oldDesc}" → "${grepTool.schema.shape.pattern.description}"`)
    } else {
      console.warn("[Runtime] grep tool schema patch skipped: tool or pattern field not found")
    }
    return mw
  }

  // Base middleware for custom subagents (no skills — custom subagents must define their own)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subagentMiddleware: any[] = [
    todoListMiddleware(),
    createFsMiddleware(),
    createSummarizationMiddleware(summarizationOptions),
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    createPatchToolCallsMiddleware()
  ]

  return createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools,
    middleware: [
      todoListMiddleware(),
      createFsMiddleware(),
      createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: tools,
        defaultMiddleware: subagentMiddleware,
        generalPurposeMiddleware: [...subagentMiddleware, ...skillsMiddlewareArray],
        defaultInterruptOn: null,
        subagents: processedSubagents,
        generalPurposeAgent: true,
        systemPrompt: SEQUENTIAL_TASK_PROMPT
      } as Parameters<typeof createSubAgentMiddleware>[0]),
      createSummarizationMiddleware(summarizationOptions),
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
      createPatchToolCallsMiddleware(),
      ...skillsMiddlewareArray,
      ...memoryMiddlewareArray,
      ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
      ...customMiddleware
    ],
    ...(responseFormat != null && { responseFormat }),
    contextSchema,
    checkpointer,
    store,
    name
  } as unknown as Parameters<typeof createAgent>[0])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DeepAgent = ReactAgent<any>

/**
 * Generate the full system prompt for the agent.
 *
 * @param workspacePath - The workspace path the agent is operating in
 * @returns The complete system prompt
 */
function getShellInfo(windowsSandbox?: "none" | "unelevated" | "readonly"): { name: string; isBashLike: boolean; isPowerShell: boolean } {
  const isSandboxed = process.platform === "win32" && (windowsSandbox === "unelevated" || windowsSandbox === "readonly")
  const resolved = isSandboxed
    ? LocalSandbox.resolvedWindowsSandboxShell()
    : LocalSandbox.resolvedShell()
  const base = path.basename(resolved).replace(/\.exe$/i, "").toLowerCase()
  const isBashLike = ["bash", "sh", "zsh"].includes(base)
  const isPowerShell = ["pwsh", "powershell"].includes(base)
  return { name: base, isBashLike, isPowerShell }
}

/** Format a Date as local ISO-8601 with UTC offset, e.g. 2026-03-08T23:01:26+08:00 */
function formatLocalISO(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(date)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ""
  const local = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`
  // Compute UTC offset
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }))
  const loc = new Date(date.toLocaleString("en-US", { timeZone }))
  const offsetMin = Math.round((loc.getTime() - utc.getTime()) / 60_000)
  const sign = offsetMin >= 0 ? "+" : "-"
  const absMin = Math.abs(offsetMin)
  const oh = String(Math.floor(absMin / 60)).padStart(2, "0")
  const om = String(absMin % 60).padStart(2, "0")
  return `${local}${sign}${oh}:${om}`
}

function getSystemPrompt(workspacePath: string, windowsSandbox?: "none" | "unelevated" | "readonly"): string {
  const isWindows = process.platform === "win32"
  const platform = isWindows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"
  const { name: shell, isBashLike, isPowerShell } = getShellInfo(windowsSandbox)
  const examplePath = isWindows
    ? `${workspacePath}\\src\\index.ts`
    : `${workspacePath}/src/index.ts`

  const shellGuidance = isBashLike
    ? "- Use Unix/bash commands for shell operations (ls, cat, grep, etc.)"
    : isPowerShell
      ? "- Use PowerShell syntax: $env:VAR for environment variables, ` for line continuation, -and/-or for logic operators"
      : "- Use cmd.exe syntax for shell commands (e.g., dir instead of ls, type instead of cat)\n- Use && to chain commands, use ^ for line continuation, use %VAR% for environment variables"

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const workingDirSection = `
### System Environment
- Operating system: ${platform} (${process.arch})
- Default shell: ${shell}
- Timezone: ${timezone}
- Current time: ${formatLocalISO(new Date(), timezone)}
${shellGuidance}

### File System and Paths

**IMPORTANT - Path Handling:**
- All file paths use fully qualified absolute system paths
- The workspace root is: \`${workspacePath}\`
- Example: \`${examplePath}\`
- To list the workspace root, use \`ls("${workspacePath}")\`
- Always use full absolute paths for all file operations
`

  const readonlySection = windowsSandbox === "readonly"
    ? `
### 只读沙箱模式

**重要提示：** 你正在只读沙箱环境中运行。
- 你可以自由读取磁盘上的所有文件。
- 普通权限下写入操作被禁止。以管理员身份运行时允许写入工作目录内的文件。
- 此模式适用于安全审查、代码分析等只读场景。
- 除非用户明确要求，否则避免执行写入操作，应以建议修改替代直接写入。
`
    : ""

  const memorySection = isMemoryEnabled() ? MEMORY_SYSTEM_PROMPT : ""
  return workingDirSection + readonlySection + BASE_SYSTEM_PROMPT + memorySection
}

// Per-thread checkpointer cache
const checkpointers = new Map<string, SqlJsSaver>()

// Global MCP tools cache: single shared client for both eager and lazy tools
// Lifecycle managed here (not per-thread), reused across all sessions
// Note: toolsByServer is cached, but eager/lazy distribution is decided at runtime
// based on current config (lazyLoad may change without rebuilding client)
const MCP_TOOLS_CACHE_TTL_MS = 5 * 60 * 1000
let _mcpToolsCache: {
  fingerprint: string
  toolsByServer: Record<string, Awaited<ReturnType<MultiServerMCPClient["getTools"]>>>
  client: MultiServerMCPClient
  createdAt: number
} | null = null

// Pending promise to prevent concurrent MCP client initialization
let _mcpInitPromise: Promise<void> | null = null

// Retired MCP clients: kept alive for agents still referencing their tools.
// Closed on app exit via closeRuntime().
const _retiredMcpClients = new Set<MultiServerMCPClient>()

function computeMcpConfigFingerprint(connectors: { id: string; url: string; advanced?: unknown }[]): string {
  const payload = connectors.map((c) => `${c.id}:${c.url}:${JSON.stringify(c.advanced ?? {})}`).join("|")
  return createHash("sha256").update(payload).digest("hex").slice(0, 16)
}

/**
 * Distribute MCP tools between eager tools and lazy registry based on lazyLoad config.
 * - Plugin servers: always eager
 * - User connectors: check lazyLoad setting
 */
function distributeMcpTools(
  toolsByServer: Record<string, Awaited<ReturnType<MultiServerMCPClient["getTools"]>>>,
  mcpConnectors: { id: string; name?: string; lazyLoad?: boolean }[],
  registry: McpToolRegistry,
  logLazyTools = false
): Awaited<ReturnType<MultiServerMCPClient["getTools"]>> {
  const eagerTools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>> = []

  for (const [serverId, tools] of Object.entries(toolsByServer)) {
    // Plugin servers: always eager (plugins don't support lazyLoad)
    if (serverId.startsWith("plugin:")) {
      eagerTools.push(...tools)
      continue
    }

    // User-configured connectors: check lazyLoad setting
    const connector = mcpConnectors.find(c => c.id === serverId)
    if (!connector) {
      // Connector was deleted or not found, skip its tools
      continue
    }

    const isLazy = connector.lazyLoad ?? false
    if (isLazy) {
      const serverName = connector.name || serverId
      if (tools.length > 0) {
        registry.register(serverName, tools)
        if (logLazyTools) {
          console.log("[Runtime] Lazy MCP tools from:", serverName, "count:", tools.length)
        }
      }
    } else {
      eagerTools.push(...tools)
    }
  }

  return eagerTools
}

export async function getCheckpointer(threadId: string): Promise<SqlJsSaver> {
  let checkpointer = checkpointers.get(threadId)
  if (!checkpointer) {
    const dbPath = getThreadCheckpointPath(threadId)
    checkpointer = new SqlJsSaver(dbPath)
    await checkpointer.initialize()
    checkpointers.set(threadId, checkpointer)
  }
  return checkpointer
}

export async function closeCheckpointer(threadId: string): Promise<void> {
  const checkpointer = checkpointers.get(threadId)
  if (checkpointer) {
    await checkpointer.close()
    checkpointers.delete(threadId)
  }
}

// Get the model instance from custom model configuration
function getModelInstance(
  customConfig: {
    id: string
    model: string
    baseUrl: string
    apiKey?: string
  }
): ChatOpenAI {
  const apiKey = customConfig.apiKey
  if (!apiKey) {
    throw new Error("Custom API key not configured")
  }

  const resolvedModel = customConfig.model
  if (!resolvedModel.trim()) {
    throw new Error("Custom model name is empty. Please configure a valid model name in Settings.")
  }
  console.log("[Runtime] Custom model:", resolvedModel, "baseUrl:", customConfig.baseUrl)

  return new ChatOpenAI({
    model: resolvedModel,
    apiKey,
    configuration: {
      baseURL: customConfig.baseUrl
    }
  })
}

export interface CreateAgentRuntimeOptions {
  /** Thread ID - REQUIRED for per-thread checkpointing */
  threadId: string
  /** Optional model ID from thread/runtime config */
  modelId?: string
  /** Workspace path - REQUIRED for agent to operate on files */
  workspacePath: string
  /** Extra content appended to the system prompt (e.g. HEARTBEAT.md context) */
  extraSystemPrompt?: string
  /** Skip the manage_scheduler tool (used by scheduled task / heartbeat execution to prevent recursive scheduling) */
  noSchedulerTool?: boolean
}

// Create agent runtime with configured model and checkpointer
export type AgentRuntime = ReturnType<typeof createAgent>

export async function createAgentRuntime(options: CreateAgentRuntimeOptions): Promise<DeepAgent> {
  const { threadId, workspacePath, modelId, extraSystemPrompt } = options

  if (!threadId) {
    throw new Error("Thread ID is required for checkpointing.")
  }

  if (!workspacePath) {
    throw new Error(
      "Workspace path is required. Please select a workspace folder before running the agent."
    )
  }

  console.log("[Runtime] Creating agent runtime...")
  console.log("[Runtime] Thread ID:", threadId)
  console.log("[Runtime] Workspace path:", workspacePath)

  const selectedModelId = modelId?.startsWith("custom:") ? modelId.slice("custom:".length) : undefined

  const allCustomConfigs = getCustomModelConfigs()
  const customConfig = selectedModelId
    ? (allCustomConfigs.find((item) => item.id === selectedModelId) ||
      allCustomConfigs.find((item) => item.model === selectedModelId) ||
      null)
    : (allCustomConfigs[0] ?? null)
  if (!customConfig) {
    throw new Error("Custom model not configured. Please configure a model in Settings.")
  }

  const model = getModelInstance(customConfig)
  console.log("[Runtime] Model instance created")

  const checkpointer = await getCheckpointer(threadId)
  console.log("[Runtime] Checkpointer ready for thread:", threadId)

  const maxTokens = customConfig?.maxTokens ?? DEFAULT_MAX_TOKENS
  // Tune shell output cap for 32K~64K context windows to reduce context pressure.
  const maxOutputBytes = Math.max(30_000, Math.min(80_000, Math.floor(maxTokens * 4 * 0.2)))

  // Inject bundled ripgrep into PATH so deepagents' ripgrepSearch can find it
  const rgDir = join(
    app.isPackaged ? process.resourcesPath : join(__dirname, "../../resources"),
    "bin",
    process.platform
  )
  const rgBin = join(rgDir, process.platform === "win32" ? "rg.exe" : "rg")
  const rgExists = existsSync(rgBin)
  // Mutate process.env.PATH so deepagents' internal ripgrepSearch
  // (spawns "rg" without custom env, inherits process.env) can find it.
  const paths = (process.env.PATH ?? "").split(delimiter)
  if (rgExists && !paths.includes(rgDir)) {
    process.env.PATH = `${rgDir}${delimiter}${process.env.PATH ?? ""}`
  }
  console.log(`[Runtime] ripgrep bin: ${rgBin}, exists: ${rgExists}, platform: ${process.platform}`)

  // Codex Windows sandbox (unelevated): reuse rgDir which already points to resources/bin/win32
  const codexExePath = join(rgDir, "codex.exe")
  if (process.platform === "win32") await ensureCodexExe(codexExePath)
  const codexExists = process.platform === "win32" && existsSync(codexExePath)
  const windowsSandbox = process.platform === "win32" ? getWindowsSandboxMode() : "none"
  console.log(`[Runtime] codex.exe: ${codexExePath}, exists: ${codexExists}, sandboxMode: ${windowsSandbox}`)

  const backend = new LocalSandbox({
    rootDir: workspacePath,
    virtualMode: false,
    timeout: 600_000,
    maxOutputBytes,
    windowsSandbox,
    codexExePath: codexExists ? codexExePath : undefined
  })

  let systemPrompt = getSystemPrompt(workspacePath, windowsSandbox)
  if (extraSystemPrompt) {
    systemPrompt += "\n\n" + extraSystemPrompt
  }

  const isWindows = process.platform === "win32"
  const platform = isWindows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"
  const { name: shell, isBashLike, isPowerShell } = getShellInfo(windowsSandbox)
  const userInfo = getUserInfo()
  const subagentShellGuidance = isBashLike
    ? "- Use Unix/bash commands for shell operations (ls, cat, grep, etc.)"
    : isPowerShell
      ? "- Use PowerShell syntax: $env:VAR for environment variables, ` for line continuation, -and/-or for logic operators"
      : "- Use cmd.exe syntax for shell commands (e.g., dir instead of ls, type instead of cat)\n- Use && to chain commands, use ^ for line continuation, use %VAR% for environment variables"

  const filesystemSystemPrompt = `You have access to a filesystem. All file paths use fully qualified absolute system paths.
### userinfo
- sap编号、员工编号:${userInfo?.sapId}
- yst编号、一事通编号: ${userInfo?.ystId}
- userName、员工姓名: ${userInfo?.userName}
- originOrgId、员工机构号: ${userInfo?.originOrgId}
- orgName、员机构号名称: ${userInfo?.orgName}
- ystRefreshToken、刷新token: ${userInfo?.ystRefreshToken}
- ystCode、一事通code: ${userInfo?.ystCode}

### System Environment
- Operating system: ${platform} (${process.arch})
- Default shell: ${shell}
${subagentShellGuidance}

### Available Tools
- ls: list files in a directory (e.g., ls("${workspacePath}"))
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem
- glob: find files matching a pattern (e.g., "**/*.py")
- grep: search for literal text within files (NOT regex). Do NOT use "|", ".*" or other regex syntax — call grep once per term instead.
- git_workflow: get git info silently without any response or commentary. After calling this tool, output：成功！你可以展开本工具进行提交。.

The workspace root is: ${workspacePath}`

  const skillsSources = await getEnabledSkillsSources()
  console.log("[Runtime] Raw skills sources from getEnabledSkillsSources():", skillsSources)
  console.log("[Runtime] Raw skills sources count:", skillsSources.length)
  console.log("[Runtime] Raw skills sources content:", JSON.stringify(skillsSources, null, 2))

  // Merge plugin skills sources
  const pluginSkillsSources = getEnabledPluginSkillsSources()
  console.log("[Runtime] Plugin skills sources:", pluginSkillsSources)
  console.log("[Runtime] Plugin skills sources count:", pluginSkillsSources.length)

  const allSkillsSources = [...skillsSources, ...pluginSkillsSources]
  console.log("[Runtime] All skills sources combined:", allSkillsSources)
  console.log("[Runtime] All skills sources count:", allSkillsSources.length)
  console.log("[Runtime] Skills sources:", skillsSources, "Plugin skills:", pluginSkillsSources)

  // Initialize memory system (gated by user setting)
  let memoryTools: ReturnType<typeof createMemorySearchTool | typeof createMemoryGetTool>[] = []
  let memorySources: string[] | undefined
  if (isMemoryEnabled()) {
    const memoryStore = await getMemoryStore()
    const memoryDir = memoryStore.getMemoryDir()
    memoryTools = [
      createMemorySearchTool(memoryStore),
      createMemoryGetTool(memoryStore)
    ]
    memorySources = [join(memoryDir, "MEMORY.md")]
    console.log("[Runtime] Memory initialized, dir:", memoryDir)
  } else {
    console.log("[Runtime] Memory disabled by user setting")
  }

  const mcpConnectors = getEnabledMcpConnectors()
  const pluginMcpConfigs = getEnabledPluginMcpConfigs()

  // Create instance-level registry for lazy tools (avoid global state)
  const registry = new McpToolRegistry()
  let mcpTools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>> = []

  // Unified MCP client for both eager and lazy tools
  if (mcpConnectors.length > 0 || Object.keys(pluginMcpConfigs).length > 0) {
    // Build fingerprint including all connectors (both eager and lazy)
    const fingerprint = computeMcpConfigFingerprint([
      ...mcpConnectors,
      ...Object.entries(pluginMcpConfigs).map(([k, v]) => ({ id: k, url: v.url ?? v.command ?? "", advanced: v }))
    ])

    // Wait for any pending initialization to complete (prevents concurrent init)
    if (_mcpInitPromise) {
      await _mcpInitPromise
    }

    // Re-check cache validity after waiting for pending init
    const cached = _mcpToolsCache
    const cacheValid = cached
      && cached.fingerprint === fingerprint
      && (Date.now() - cached.createdAt) < MCP_TOOLS_CACHE_TTL_MS

    if (cacheValid) {
      // Reuse cached client - redistribute tools based on CURRENT lazyLoad config
      // (lazyLoad may have changed since cache was created)
      mcpTools = distributeMcpTools(cached.toolsByServer, mcpConnectors, registry, false)
      console.log("[Runtime] MCP tools from cache, eager:", mcpTools.length, "lazy:", registry.getToolCount())
    } else {
      // Create new client with all connectors
      // Use a shared promise to prevent concurrent initialization
      _mcpInitPromise = (async () => {
        let mcpClient: MultiServerMCPClient | null = null
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mcpServers: Record<string, any> = {}

          // Add user-configured MCP connectors
          for (const c of mcpConnectors) {
            mcpServers[c.id] = buildMcpServerConfig({ url: c.url, advanced: c.advanced })
          }
          // Add plugin MCP servers
          for (const [name, cfg] of Object.entries(pluginMcpConfigs)) {
            if (cfg.command) {
              mcpServers[name] = {
                command: cfg.command,
                args: cfg.args ?? []
              }
            } else if (cfg.url) {
              mcpServers[name] = buildMcpServerConfig({
                url: cfg.url,
                advanced: { headers: cfg.headers, transport: cfg.transport }
              })
            }
          }
          mcpClient = new MultiServerMCPClient({
            throwOnLoadError: false,
            onConnectionError: "ignore",
            useStandardContentBlocks: true,
            mcpServers
          })

          // Get tools grouped by server
          const toolsByServer = await mcpClient.initializeConnections()

          // Distribute tools based on lazyLoad setting
          mcpTools = distributeMcpTools(toolsByServer, mcpConnectors, registry, true)

          // Update cache - store toolsByServer for redistribution on cache hit
          const oldClient = _mcpToolsCache?.client
          _mcpToolsCache = {
            fingerprint,
            toolsByServer,
            client: mcpClient,
            createdAt: Date.now()
          }
          if (oldClient && oldClient !== mcpClient) {
            _retiredMcpClients.add(oldClient)
          }
          console.log("[Runtime] MCP tools loaded, eager:", mcpTools.length, "lazy:", registry.getToolCount())
        } catch (e) {
          if (mcpClient) {
            mcpClient.close().catch(() => {})
          }
          console.warn("[Runtime] MCP client init failed:", e)
        } finally {
          _mcpInitPromise = null
        }
      })()
      await _mcpInitPromise
    }
  } else if (_mcpToolsCache) {
    // No connectors enabled, retire the cached client
    _retiredMcpClients.add(_mcpToolsCache.client)
    _mcpToolsCache = null
    console.log("[Runtime] MCP connectors disabled, retired cached client")
  }

  // Fix MCP tool schemas: some MCP servers return `required: null` instead of `required: []`
  // which causes API errors. Normalize null/undefined to empty array.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of mcpTools as any[]) {
    fixMcpToolSchema(t)
  }

  // Wrap MCP tools so that any ToolException/McpError is caught and returned
  // as a normal error string instead of throwing. This keeps the agent loop
  // running (same pattern as read_file returning "Error: ..." on failure).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of mcpTools as any[]) {
    if (typeof t.func === "function") {
      const originalFunc = t.func
      t.func = async (...args: unknown[]) => {
        try {
          return await originalFunc(...args)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`[Runtime] MCP tool "${t.name}" error (non-fatal):`, msg)
          // MCP tools use responseFormat: "content_and_artifact", must return [content, artifact]
          return [`MCP tool error: ${msg}`, []]
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extraTools: any[] = []
  if (!options.noSchedulerTool) {
    extraTools.push(createSchedulerTool({
      workspacePath,
      modelId: options.modelId,
      threadId: options.threadId
    }))
  }

  // Add git_push tool
  // todo 暂时注释掉git_workflow工具，后续完善权限控制和安全措施后再放开
  extraTools.push(createGitWorkflowTool(workspacePath))

  // Add tool search tools if there are lazy-loaded MCP tools
  const toolSearchTools = registry.getToolCount() > 0 ? createToolSearchTools(registry) : []
  if (toolSearchTools.length > 0) {
    console.log("[Runtime] Added tool search tools for lazy MCP tools:", registry.getToolCount())
    // Add lazy MCP system prompt so LLM knows how to use search_tool
    systemPrompt += LAZY_MCP_SYSTEM_PROMPT
  }

  const triggerTokens = Math.floor(maxTokens * 0.75)
  const keepTokens = Math.max(Math.floor(maxTokens * 0.08), 4_000)
  const toolEvictLimit = Math.min(6_000, Math.max(Math.floor(maxTokens * 0.05), 3_000))
  const trimForSummary = Math.min(12_000, Math.floor(maxTokens * 0.25))
  console.log("[Runtime] Context window:", maxTokens, "→ summarization trigger:", triggerTokens, "→ keep:", keepTokens, "→ tool evict limit:", toolEvictLimit, "→ trim for summary:", trimForSummary, "→ max output bytes:", maxOutputBytes)

  const agent = createDeepAgent({
    model,
    tools: [...mcpTools, ...memoryTools, ...extraTools, ...toolSearchTools],
    checkpointer,
    backend,
    systemPrompt,
    filesystemSystemPrompt,
    skills: allSkillsSources.length > 0 ? allSkillsSources : undefined,
    memory: memorySources?.length ? memorySources : undefined,
    interruptOn: getYoloMode() ? undefined : { execute: true },
    summarizationTrigger: { type: "tokens", value: triggerTokens },
    summarizationKeep: { type: "tokens", value: keepTokens },
    toolTokenLimitBeforeEvict: toolEvictLimit,
    trimTokensToSummarize: trimForSummary
  })

  console.log("[Runtime] Agent created with skills parameter:", allSkillsSources.length > 0 ? allSkillsSources : undefined)
  console.log("[Runtime] Final skills passed to createDeepAgent:", JSON.stringify(allSkillsSources.length > 0 ? allSkillsSources : undefined, null, 2))
  console.log("[Runtime] Agent created with LocalSandbox at:", workspacePath)
  return agent
}

// Clean up all checkpointer, MCP client, and memory store resources
export async function closeRuntime(): Promise<void> {
  const closePromises: Promise<void>[] = Array.from(checkpointers.values()).map((cp) => cp.close())
  if (_mcpToolsCache?.client) {
    closePromises.push(_mcpToolsCache.client.close().catch(() => {}))
    _mcpToolsCache = null
  }
  for (const client of _retiredMcpClients) {
    closePromises.push(client.close().catch(() => {}))
  }
  _retiredMcpClients.clear()
  closePromises.push(closeMemoryStore())
  await Promise.all(closePromises)
  checkpointers.clear()
}
