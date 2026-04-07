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
  getSkillEvolutionThreshold as getStoredSkillEvolutionThreshold,
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
import { join, resolve, delimiter } from "path"
import { existsSync, createWriteStream, statSync, unlinkSync } from "fs"
import { createReadStream } from "fs"
import { createGunzip } from "zlib"
import { pipeline } from "stream/promises"
import { app, BrowserWindow } from "electron"
import { BASE_SYSTEM_PROMPT, MEMORY_SYSTEM_PROMPT, LAZY_MCP_SYSTEM_PROMPT } from "./system-prompt"
import { getMemoryStore, closeMemoryStore } from "../memory/store"
import { createMemorySearchTool, createMemoryGetTool } from "../memory/tools"
import { createSchedulerTool } from "./tools/scheduler-tool"
import { createSkillEvolutionTool } from "./tools/skill-evolution-tool"
import { getThread } from "../db/index"
import { createPlaywrightTool } from "./tools/playwright-tool"
import {
  McpToolRegistry,
  createToolSearchTools,
  fixMcpToolSchema
} from "./tools/tool-search-tool"
import { getWindowsSandboxMode, getYoloMode, getEnabledHooks } from "../storage"
import { ApprovalStore } from "./approval-store"
import { ToolOrchestrator } from "./tool-orchestrator"
import type { ApprovalRequest, ApprovalDecision } from "../types"
import { InterleavedThinkingChatOpenAICompletions } from "./interleaved-thinking-completions"

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

// ── Pending Approvals (shared between orchestrator and IPC) ──

/** Map of pending approval promises keyed by request ID. */
export const pendingApprovals = new Map<string, {
  resolve: (decision: ApprovalDecision) => void
  request: ApprovalRequest
  targetWebContentsIds: number[]
}>()

/** Per-thread approval store cache. */
const approvalStores = new Map<string, ApprovalStore>()

export function getOrCreateApprovalStore(threadId: string): ApprovalStore {
  let store = approvalStores.get(threadId)
  if (!store) {
    store = new ApprovalStore()
    store.loadPermanentRules()
    approvalStores.set(threadId, store)
  }
  return store
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

    // Replace the default execute tool with a version that supports run_in_background.
    // Long-running commands (builds, dependency downloads) can be started in background
    // and their output retrieved later via task_output tool.
    const { tool: lcTool } = require("langchain") as typeof import("langchain")
    const { z } = require("zod") as typeof import("zod")

    const executeIdx = mw.tools?.findIndex((t: any) => t.name === "execute") ?? -1
    if (executeIdx >= 0) {
      const oldExecute = mw.tools![executeIdx]
      const customExecute = lcTool(async (input: { command: string; run_in_background?: boolean }) => {
        if (input.run_in_background) {
          const taskId = await (filesystemBackend as LocalSandbox).executeBackground(input.command)
          return `Background task started (id: ${taskId}). Use task_output tool with this id to check results later.`
        }
        // Delegate to original execute handler for foreground execution
        return (oldExecute as any).invoke(input)
      }, {
        name: "execute",
        description: (oldExecute as any).description,
        schema: z.object({
          command: z.string().describe("The shell command to execute"),
          run_in_background: z.boolean().optional().describe(
            "Set to true to run the command in the background. Returns a task ID immediately. " +
            "Use this for long-running commands like builds, dependency downloads, or test suites. " +
            "Retrieve the result later with the task_output tool."
          )
        })
      })
      mw.tools![executeIdx] = customExecute
      console.log("[Runtime] execute tool patched: added run_in_background support")
    }

    // Add task_output tool for retrieving background task results.
    // Mirrors Claude Code's TaskOutput: blocks internally (100ms poll loop)
    // until the task completes or the timeout expires, so the LLM only needs
    // one tool call per check instead of burning tokens on repeated polls.
    const taskOutputTool = lcTool(async (input: { task_id: string; block?: boolean; timeout?: number }) => {
      const sandbox = filesystemBackend as LocalSandbox
      const block = input.block !== false  // default true
      const timeout = input.timeout ?? 30_000 // default 30s, max 600s

      // Non-blocking: return immediately
      if (!block) {
        const result = sandbox.getTaskOutput(input.task_id)
        if (!result) return `Error: No background task found with id "${input.task_id}".`
        if (!result.completed) {
          return JSON.stringify({ retrieval_status: "not_ready", elapsed: result.elapsedSeconds, command: result.command })
        }
        const status = result.exitCode === 0 ? "succeeded" : "failed"
        return `${result.output ?? "<no output>"}\n[Command ${status} with exit code ${result.exitCode}, elapsed: ${result.elapsedSeconds}s]`
      }

      // Blocking: poll with progressive interval until completed, timeout, or abort.
      // First 2s at 100ms for snappy response, then 500ms to reduce CPU spin.
      const start = Date.now()
      while (Date.now() - start < timeout) {
        if (sandbox.isAborted) {
          return "Task polling aborted: conversation was cancelled by user."
        }
        const result = sandbox.getTaskOutput(input.task_id)
        if (!result) return `Error: No background task found with id "${input.task_id}".`
        if (result.completed) {
          const status = result.exitCode === 0 ? "succeeded" : "failed"
          return `${result.output ?? "<no output>"}\n[Command ${status} with exit code ${result.exitCode}, elapsed: ${result.elapsedSeconds}s]`
        }
        const elapsed = Date.now() - start
        await new Promise<void>(r => setTimeout(r, elapsed < 2000 ? 100 : 500))
      }

      // Timeout — return current status so the LLM can decide to call again
      const final = sandbox.getTaskOutput(input.task_id)
      if (!final) return `Error: No background task found with id "${input.task_id}".`
      if (final.completed) {
        const status = final.exitCode === 0 ? "succeeded" : "failed"
        return `${final.output ?? "<no output>"}\n[Command ${status} with exit code ${final.exitCode}, elapsed: ${final.elapsedSeconds}s]`
      }
      return JSON.stringify({ retrieval_status: "timeout", elapsed: final.elapsedSeconds, command: final.command })
    }, {
      name: "task_output",
      description:
        "Retrieve the output of a background task started with execute(run_in_background=true). " +
        "By default blocks up to 30 seconds waiting for the task to complete. " +
        "If the task finishes within the timeout, returns the full output. " +
        "If it times out, returns current status — call again to continue waiting. " +
        "Set block=false for a non-blocking status check.",
      schema: z.object({
        task_id: z.string().describe("The task ID returned by execute when run_in_background was true"),
        block: z.boolean().optional().describe("Whether to wait for completion (default: true)"),
        timeout: z.number().min(0).max(600_000).optional().describe("Max wait time in ms (default: 30000)")
      })
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.tools = [...(mw.tools || []), taskOutputTool] as any
    console.log("[Runtime] task_output tool added")

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
function getShellInfo(windowsSandbox?: "none" | "unelevated" | "readonly" | "elevated"): { name: string; isBashLike: boolean; isPowerShell: boolean } {
  const isSandboxed = process.platform === "win32" && (windowsSandbox === "unelevated" || windowsSandbox === "readonly" || windowsSandbox === "elevated")
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

function getSystemPrompt(workspacePath: string, windowsSandbox?: "none" | "unelevated" | "readonly" | "elevated"): string {
  const isWindows = process.platform === "win32"
  const platform = isWindows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"
  const { name: shell, isBashLike, isPowerShell } = getShellInfo(windowsSandbox)
  const examplePath = isWindows
    ? `${workspacePath}\\src\\index.ts`
    : `${workspacePath}/src/index.ts`

  const shellGuidance = isBashLike
    ? "- Use Unix/bash commands for shell operations (ls, cat, grep, etc.)"
    : isPowerShell
      ? `- **CRITICAL: Commands run in PowerShell (not bash).** You MUST use PowerShell syntax:
  - Chain commands: use \`; \` instead of \`&&\` (PowerShell 5.1 does NOT support \`&&\`)
  - Logic operators: use \`-and\`, \`-or\` instead of \`&&\`, \`||\`
  - Environment variables: use \`$env:VAR\` instead of \`$VAR\`
  - Null redirect: use \`$null\` or \`Out-Null\` instead of \`/dev/null\`
  - Line continuation: use backtick \` instead of \`\\\`
  - Common equivalents: \`Get-ChildItem\` (ls), \`Get-Content\` (cat), \`Select-String\` (grep), \`Remove-Item\` (rm)
  - You may also use standard Windows commands: dir, type, findstr, del, copy, move, mkdir, rmdir
  - Python: use \`python\` instead of \`py\` (the \`py\` launcher depends on Windows registry which may not be accessible in sandbox)
  - NEVER use bash-specific syntax: $(), \${}, <<<, <(), 2>&1 |, [[ ]], etc.`
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

  const backgroundExecSection = `
### 长时间命令执行

**重要提示：** execute 工具默认超时 60 秒。对于可能超过 60 秒的命令，**必须**使用 \`run_in_background: true\` 参数：
- 项目编译/构建：mvn, gradle, npm run build, dotnet build, cargo build, make 等
- 依赖安装：mvn dependency:resolve, npm install, pip install, go mod download 等
- 测试套件：mvn test, npm test, pytest, cargo test 等
- 代码生成、Docker 构建等耗时操作

使用方法：
1. 调用 execute({ command: "mvn clean package -DskipTests", run_in_background: true })
2. 获得 task_id 后，调用 task_output({ task_id: "..." }) 获取结果
3. task_output 默认会阻塞等待最多 30 秒，如果任务在 30 秒内完成则直接返回结果
4. 如果返回 timeout，再次调用 task_output 继续等待即可
5. 对于预计非常长的任务，可以设置更大的 timeout：task_output({ task_id: "...", timeout: 120000 })

**切勿**对编译、安装依赖等命令使用前台执行，否则会因超时被终止。
`

  const sandboxSection = windowsSandbox === "readonly"
    ? `
### 只读沙箱模式

**重要提示：** 你正在只读沙箱环境中运行。
- 你可以自由读取磁盘上的所有文件。
- 普通权限下写入操作被禁止。以管理员身份运行时允许写入工作目录内的文件。
- 此模式适用于安全审查、代码分析等只读场景。
- 除非用户明确要求，否则避免执行写入操作，应以建议修改替代直接写入。
`
    : windowsSandbox === "elevated"
    ? `
### Elevated 沙箱模式

**重要提示：** 你正在 Elevated 沙箱环境中运行。
- 所有 shell 命令以独立沙箱用户身份执行，与当前用户完全隔离。
- 出站网络访问不再由本地沙箱额外阻断；是否可联网取决于当前机器和公司的网络策略。
- 你可以读写工作目录内的文件，但无法访问用户的个人目录（如 .ssh、.aws）。
- 如果命令因权限不足失败，不要反复重试，向用户说明限制即可。
`
    : ""

  const memorySection = isMemoryEnabled() ? MEMORY_SYSTEM_PROMPT : ""
  return workingDirSection + backgroundExecSection + sandboxSection + BASE_SYSTEM_PROMPT + memorySection
}

// Per-thread checkpointer cache
const checkpointers = new Map<string, SqlJsSaver>()

// ─────────────────────────────────────────────────────────
// Tool-call counter: track how many tool calls have been made
// in each thread during the current session. Used to trigger
// the skill-evolution nudge after SKILL_EVOLUTION_THRESHOLD calls.
// ─────────────────────────────────────────────────────────

/** Returns the current skill-evolution threshold from persistent storage. */
export function getSkillEvolutionThreshold(): number {
  return getStoredSkillEvolutionThreshold()
}

/** Per-thread tool-call counters (in-memory, reset on app restart) */
const _threadToolCallCounts = new Map<string, number>()

export function incrementToolCallCount(threadId: string): number {
  const prev = _threadToolCallCounts.get(threadId) ?? 0
  const next = prev + 1
  _threadToolCallCounts.set(threadId, next)
  return next
}

export function getToolCallCount(threadId: string): number {
  return _threadToolCallCounts.get(threadId) ?? 0
}

export function resetToolCallCount(threadId: string): void {
  _threadToolCallCounts.delete(threadId)
}

/**
 * Threads that need the skill-evolution nudge injected on the NEXT invocation.
 * Used when auto-propose is disabled and we want the agent to decide itself.
 */
const _pendingNudgeThreads = new Set<string>()

export function scheduleSkillNudge(threadId: string): void {
  _pendingNudgeThreads.add(threadId)
}

/** Returns and clears the nudge flag for the given thread. */
export function consumeSkillNudge(threadId: string): boolean {
  const had = _pendingNudgeThreads.has(threadId)
  _pendingNudgeThreads.delete(threadId)
  return had
}

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
    interleavedThinking?: boolean
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

  const baseFields = {
    model: resolvedModel,
    apiKey,
    maxRetries: 1,
    timeout: 60_000,
    configuration: {
      baseURL: customConfig.baseUrl
    }
  }

  if (!customConfig.interleavedThinking) {
    return new ChatOpenAI(baseFields)
  }

  return new ChatOpenAI({
    ...baseFields,
    completions: new InterleavedThinkingChatOpenAICompletions(baseFields)
  } as never)
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
  /** Skip the manage_skill tool (disable skill evolution for scheduled/heartbeat agents) */
  noSkillEvolutionTool?: boolean
  /** AbortSignal — when signalled, any running child process is killed immediately. */
  abortSignal?: AbortSignal
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
  let resourceBase: string
  if (app.isPackaged) {
    resourceBase = process.resourcesPath
  } else {
    // Dev mode: __dirname may be relative on some machines.
    // Try multiple strategies to find the resources directory.
    const candidates = [
      resolve(__dirname, "../../resources"),
      join(app.getAppPath(), "resources"),
      join(app.getAppPath(), "..", "resources"),
    ]
    resourceBase = candidates.find(c => existsSync(join(c, "bin"))) ?? resolve(__dirname, "../../resources")
  }
  const rgDir = join(resourceBase, "bin", process.platform)
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

  const enabledHooks = getEnabledHooks()
  console.log(`[Runtime] Loaded ${enabledHooks.length} enabled hooks`)

  const backend = new LocalSandbox({
    rootDir: workspacePath,
    virtualMode: false,
    timeout: 60_000,
    maxOutputBytes,
    windowsSandbox,
    codexExePath: codexExists ? codexExePath : undefined,
    // Pass a getter so hooks are always read fresh from storage at call time
    hooks: getEnabledHooks,
    abortSignal: options.abortSignal,
    runId: threadId
  })

  // ── Wire up the approval orchestrator ──
  const yoloMode = getYoloMode()
  if (!yoloMode) {
    const approvalStore = getOrCreateApprovalStore(threadId)

    // The approval requester sends requests to the renderer via BrowserWindow IPC.
    // It returns a Promise that is resolved when the renderer sends back a decision.
    // P3 fix: auto-reject after 5 minutes to prevent indefinite hangs.
    const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

    const requestApproval = (req: ApprovalRequest): Promise<ApprovalDecision> => {
      return new Promise<ApprovalDecision>((resolve) => {
        const timeoutId = setTimeout(() => {
          if (pendingApprovals.has(req.id)) {
            pendingApprovals.delete(req.id)
            console.warn(`[Orchestrator] approval request timed out after ${APPROVAL_TIMEOUT_MS / 1000}s: reqId=${req.id}`)
            // P2 fix: notify renderer that approval timed out so it can clear the UI
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.send(`approval:timeout:${threadId}`, { requestId: req.id })
            }
            resolve({ type: "reject", tool_call_id: req.tool_call?.id ?? req.id })
          }
        }, APPROVAL_TIMEOUT_MS)

        pendingApprovals.set(req.id, {
          resolve: (decision: ApprovalDecision) => {
            clearTimeout(timeoutId)
            resolve(decision)
          },
          request: req,
          targetWebContentsIds: BrowserWindow.getAllWindows().map(w => w.webContents.id)
        })
        console.log(`[Orchestrator] sending approval request on channel: approval:request:${threadId}, reqId=${req.id}, command=${req.command}`)
        // Broadcast to all windows — the active one will display the approval UI
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(`approval:request:${threadId}`, req)
        }
      })
    }

    const rawExecute = (command: string, sandboxMode?: string): Promise<import("deepagents").ExecuteResponse> => {
      return backend.executeRaw(command, sandboxMode)
    }

    const orchestrator = new ToolOrchestrator(approvalStore, rawExecute, requestApproval, false)
    backend.setOrchestrator(orchestrator)
  }

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
      ? `- **CRITICAL: Commands run in PowerShell (not bash).** Use \`; \` instead of \`&&\`, \`$env:VAR\` instead of \`$VAR\`, \`-and\`/\`-or\` instead of \`&&\`/\`||\`. NEVER use bash syntax.`
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
- Browser strategy: for browser tasks, first follow any matching enabled skill; only if no relevant skill is available, use browser_playwright.
- browser_playwright: built-in browser automation and page interaction tool powered by project-local Playwright (fallback when no matching browser skill exists).

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
            mcpServers[c.id] = buildMcpServerConfig({ url: c.url, advanced: {
              ...c.advanced,
              headers:{
                ...c.advanced?.headers
              }
            } })
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
          return await originalFunc.apply(t, args)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          const level = e instanceof TypeError || e instanceof ReferenceError ? "error" : "warn"
          console[level](`[Runtime] MCP tool "${t.name}" error (non-fatal):`, msg)
          // MCP tools use responseFormat: "content_and_artifact", must return [content, artifact]
          return [`MCP tool error: ${msg}`, []]
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extraTools: any[] = []
  if (!options.noSchedulerTool) {
    let chatxRobotChatId: string | null = null
    if (options.threadId) {
      try {
        const threadRow = getThread(options.threadId)
        if (threadRow?.metadata) {
          const meta = JSON.parse(threadRow.metadata)
          chatxRobotChatId = (meta.chatxRobotChatId as string) || null
        }
      } catch { /* ignore */ }
    }
    extraTools.push(createSchedulerTool({
      workspacePath,
      modelId: options.modelId,
      threadId: options.threadId,
      chatxRobotChatId
    }))
  }
  if (!options.noSkillEvolutionTool) {
    extraTools.push(createSkillEvolutionTool({ threadId: options.threadId }))
  }

  extraTools.push(createPlaywrightTool(workspacePath))

  // Wrap extra tools so that errors are returned as strings instead of throwing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function wrapToolErrors(tools: any[]): void {
    for (const t of tools) {
      if (typeof t.func === "function") {
        const originalFunc = t.func
        t.func = async (...args: unknown[]) => {
          try {
            return await originalFunc.apply(t, args)
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            const level = e instanceof TypeError || e instanceof ReferenceError ? "error" : "warn"
            console[level](`[Runtime] Tool "${t.name}" error (non-fatal):`, msg)
            return msg
          }
        }
      }
    }
  }
  wrapToolErrors(extraTools)
  wrapToolErrors(memoryTools as any[])

  // Add tool search tools if there are lazy-loaded MCP tools
  const toolSearchTools = registry.getToolCount() > 0 ? createToolSearchTools(registry) : []
  if (toolSearchTools.length > 0) {
    console.log("[Runtime] Added tool search tools for lazy MCP tools:", registry.getToolCount())
    // Add lazy MCP system prompt so LLM knows how to use search_tool
    systemPrompt += LAZY_MCP_SYSTEM_PROMPT
    wrapToolErrors(toolSearchTools as any[])
  }

  const triggerTokens = Math.floor(maxTokens * 0.75)
  const keepTokens = Math.max(Math.floor(maxTokens * 0.08), 4_000)
  const toolEvictLimit = Math.min(6_000, Math.max(Math.floor(maxTokens * 0.05), 3_000))
  const trimForSummary = Math.min(12_000, Math.floor(maxTokens * 0.25))
  console.log("[Runtime] Context window:", maxTokens, "→ summarization trigger:", triggerTokens, "→ keep:", keepTokens, "→ tool evict limit:", toolEvictLimit, "→ trim for summary:", trimForSummary, "→ max output bytes:", maxOutputBytes)

  const finalTools = [...mcpTools, ...memoryTools, ...extraTools, ...toolSearchTools]
  backend.setGitWorkflowCommitOnly(false)
  console.log("[Runtime] Final tool list:", finalTools.map((t) => (t as { name?: string }).name ?? "(unnamed)"))

  const agent = createDeepAgent({
    model,
    tools: finalTools,
    checkpointer,
    backend,
    systemPrompt,
    filesystemSystemPrompt,
    skills: allSkillsSources.length > 0 ? allSkillsSources : undefined,
    memory: memorySources?.length ? memorySources : undefined,
    // When the orchestrator is active (non-YOLO), it handles execute approval
    // internally via IPC — no need for the HITL middleware to intercept execute.
    // HITL middleware is still used in YOLO=false mode for non-execute tools if needed.
    interruptOn: undefined,
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
