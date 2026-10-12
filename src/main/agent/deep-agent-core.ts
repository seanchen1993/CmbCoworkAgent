// Shared Cmb graph assembly extracted from runtime.ts. Desktop services are explicit host ports.
import { createTaskModelOutcomeMiddleware, withTaskModelOutcome } from "./task-model-outcome"
import { ModError } from "../mods/errors"
import { collectRuntimeToolCatalog } from "./runtime-tool-catalog"
import type { FunctionToolInfo } from "../../shared/mods/v2/tools"
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createMemoryMiddleware,
  GENERAL_PURPOSE_SUBAGENT,
  StateBackend
} from "deepagents"
import {
  createCmbContextController,
  createCmbSummarizationMiddleware
} from "./context-summarization-middleware"
import {
  createTurnCompletionGateMiddleware,
  type TurnCompletionRecoveryCallback
} from "./turn-completion-integrity"
import {
  withSubagentSessionCapture,
  subagentSessionCallbacks
} from "../services/subagent-session-capture"
import { DynamicStructuredTool, ToolInputParsingException, tool } from "@langchain/core/tools"
import type { LocalSandbox, SkillHookContextProvider } from "./local-sandbox"
import { agentFileWriteContext, readOnlyShellExecutionContext } from "./local-sandbox-core"
import { type AgentToolStrategy } from "../../shared/agent-runtime-limits"
import {
  getToolStrategyReminder,
  resolveEffectiveToolStrategy,
  resolveFilesystemToolStrategy,
  SHELL_FIRST_TOOL_DESCRIPTIONS,
  type ToolStrategyFileTools
} from "./tool-strategy"
import { resolveAgentOutputStyle, type AgentOutputStyle } from "../../shared/agent-output-style"
import {
  createAgent,
  createMiddleware,
  MiddlewareError,
  ReactAgent,
  SystemMessage,
  ToolInvocationError,
  todoListMiddleware,
  anthropicPromptCachingMiddleware,
  humanInTheLoopMiddleware,
  tool as lcTool
} from "langchain"
import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import { Runnable, RunnableLambda } from "@langchain/core/runnables"
import { Command, isGraphBubbleUp } from "@langchain/langgraph"
import { z } from "zod"
import {
  appendTaskCompletionAndRepetitionPrompt,
  getOutputStylePrompt,
  getOutputStyleTurnReminder,
  OUTPUT_STYLE_IDENTITY_PROMPT
} from "./system-prompt"
import { isHookHaltError } from "../hooks/halt"
import {
  hasFailureFired,
  markFailureFired,
  toolFailureSignalFromThrow,
  type ToolFailureSignal
} from "../hooks/tool-failure"
import {
  formatFailureFuseWarning,
  isFailureFuseHaltError,
  shouldAttachFailureFuseFeedback,
  shouldSendFailureFuseNotice,
  throwIfFailureFuseHalt,
  type FailureFuseDecision,
  type FailureFuseNoticeCallback
} from "./failure-fuse"
import { mergeUpdatedInput } from "../hooks/updated-input"
import { createCurrentRunMessageQueueMiddleware } from "./current-run-message-queue"
import { classifyCommandConcurrency, isReadOnlyShellCommand } from "./exec-policy"
import type { WindowsShellKind } from "./windows-safe-commands"
import { readOnlyExecuteBlockMessage } from "./read-only-shell-message"
import { configureContextCompactionModel } from "./context-compaction"
import {
  createMalformedToolCallGuardMiddleware,
  createMalformedToolCallRecoveryMiddleware
} from "./malformed-tool-call-recovery"
import {
  areAgentLoopGuardsEnabled,
  createActionStationarityMiddleware,
  getActionStationarityHaltError
} from "./action-stationarity"
import {
  applyCoordinatorWorkerFilesystemAccess,
  blockedToolNamesForAccess,
  registryAgentBlockedTools,
  type CoordinatorWorkerFilesystemAccess
} from "./coordinator-worker-access"
import { stripBlockedToolDocs, type AgentShellAccess } from "./agent-registry"
import { patchRuntimeReadFileTool } from "./read-file-tool"
import { isWorkflowStructuredOutputFatalError } from "./workflow/structured-output-error"
import type { SoloTaskTraceManager } from "./trace/solo-task"
import { HOOK_AGENT_OWNER_METADATA_KEY as SOLO_TASK_OWNER_METADATA_KEY } from "../hooks/execution-context"
import type { DeepAgentServices } from "./deep-agent-services"
import { createRefreshingSkillsMiddleware } from "./skill-sources"

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === "AbortError" || (error as { code?: unknown }).code === "ABORT_ERR"
}

export function describeToolError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Error"
  if (typeof error === "string" && error) return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

// ─── Tool concurrency: AsyncRWLock (writer-preferring) ──────────────────────
//
// Mirrors Codex's `ToolCallRuntime` model (codex-rs/core/src/tools/parallel.rs):
//   - shared (read lock): tools that are safe to run concurrently (reads)
//   - exclusive (write lock): side-effecting tools that must run alone
//   - bypass: tools we have no classification for — pass through without locking
//
// Approval events are NOT serialized by this lock — they fire immediately from
// each tool task. The renderer's pendingApprovals[] queue owns UI ordering.
// Execution is what this lock gates.

type ToolConcurrencyTier = "exclusive" | "shared" | "bypass"

/**
 * Tools that mutate cross-tool shared state (tool registry, scheduler, skill
 * files). These must run one-at-a-time across the entire thread — write lock.
 *
 * Note: mutating shell / file I/O tools are also exclusive. Only commands that
 * are provably read-only are allowed to overlap with other read-only work.
 */
const EXCLUSIVE_TOOL_NAMES = new Set([
  "code_exec",
  "save_code_exec_tool",
  "manage_scheduler",
  "manage_skill",
  "workflow",
  "invoke_deferred_tool",
  "write_file",
  "edit_file"
])

/**
 * Tools that hold the read lock. This includes:
 *   - True read-only tools (read_file, grep, glob, …)
 *   - `execute` only when its command is classified as read-only. Other
 *     commands are exclusive so writes/builds/package managers do not overlap.
 */
const SHARED_TOOL_NAMES = new Set([
  // True read-only
  "read_file",
  "ls",
  "glob",
  "grep",
  "search_tool",
  "inspect_tool",
  "task_output",
  "view_image",
  // Subagent task calls may run concurrently. Subagent-internal tools use the
  // separate subagent concurrency gate below, so file writes remain exclusive.
  "task"
])

const MAX_PARALLEL_TASK_SUBAGENTS = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function executeCommandFromToolArgs(args: unknown): string | null {
  if (isRecord(args) && typeof args.command === "string") {
    return args.command
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown
      if (isRecord(parsed) && typeof parsed.command === "string") {
        return parsed.command
      }
    } catch {
      return null
    }
  }
  return null
}

function classifyToolConcurrency(
  toolCall: { name?: string; args?: unknown } | undefined
): ToolConcurrencyTier {
  const toolName = toolCall?.name
  if (!toolName) return "exclusive" // safety default: unknown → write lock

  if (EXCLUSIVE_TOOL_NAMES.has(toolName)) return "exclusive"
  if (toolName === "execute") {
    const command = executeCommandFromToolArgs(toolCall?.args)
    return command && classifyCommandConcurrency(command) === "parallel_safe"
      ? "shared"
      : "exclusive"
  }
  if (SHARED_TOOL_NAMES.has(toolName)) return "shared"
  // Unknown tools (eager MCP tools registered with runtime toolId names,
  // dynamic plugin tools, custom extras) default to EXCLUSIVE. This matches
  // Codex's `configured_tool_supports_parallel` default (false). Opting in
  // to `shared` requires explicit whitelisting — unknown = unsafe.
  return "exclusive"
}

function shouldFastRejectActiveWorkflow(
  queueId: string,
  toolCall: { name?: string; args?: unknown } | undefined,
  isWorkflowActive?: (queueId: string) => boolean
): boolean {
  // A second workflow launch while one is already active should fail fast with the
  // workflow tool's own active-run error. If we wait for the exclusive tool lock
  // first, a long-running workflow subagent command can delay that user-facing
  // rejection until the command finishes.
  return toolCall?.name === "workflow" && Boolean(isWorkflowActive?.(queueId))
}

/**
 * Writer-preferring async read-write lock.
 *
 * - `read()`: multiple holders allowed. Blocks if a writer is active or waiting.
 * - `write()`: exclusive. Blocks until all readers drain and no other writer held.
 *
 * Writer preference prevents writer starvation when reads are frequent.
 */
class AsyncRWLock {
  private readers = 0
  private writerHeld = false
  private writerQueue: Array<() => void> = []
  private readerQueue: Array<() => void> = []

  async read<T>(task: () => Promise<T>): Promise<T> {
    await this.acquireRead()
    try {
      return await task()
    } finally {
      this.releaseRead()
    }
  }

  async write<T>(task: () => Promise<T>): Promise<T> {
    await this.acquireWrite()
    try {
      return await task()
    } finally {
      this.releaseWrite()
    }
  }

  private acquireRead(): Promise<void> {
    if (!this.writerHeld && this.writerQueue.length === 0) {
      this.readers++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.readerQueue.push(() => {
        this.readers++
        resolve()
      })
    })
  }

  private acquireWrite(): Promise<void> {
    if (!this.writerHeld && this.readers === 0) {
      this.writerHeld = true
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.writerQueue.push(() => {
        this.writerHeld = true
        resolve()
      })
    })
  }

  private releaseRead(): void {
    this.readers--
    if (this.readers === 0 && this.writerQueue.length > 0) {
      const next = this.writerQueue.shift()!
      next()
    }
  }

  private releaseWrite(): void {
    this.writerHeld = false
    if (this.writerQueue.length > 0) {
      const next = this.writerQueue.shift()!
      next()
    } else if (this.readerQueue.length > 0) {
      const pending = this.readerQueue.splice(0)
      for (const wake of pending) wake()
    }
  }
}

class AsyncSemaphore {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next) next()
  }
}

const toolConcurrencyLocks = new Map<string, AsyncRWLock>()

const taskConcurrencyLimiters = new Map<string, AsyncSemaphore>()

export function getToolConcurrencyLock(queueId: string): AsyncRWLock {
  let lock = toolConcurrencyLocks.get(queueId)
  if (!lock) {
    lock = new AsyncRWLock()
    toolConcurrencyLocks.set(queueId, lock)
  }
  return lock
}

/**
 * Drops the tool-concurrency locks keyed by a thread (its own queue and the
 * `:subagent` queue) when the thread is deleted, so the module-level map doesn't
 * accumulate one idle lock per thread for the process lifetime. The thread is
 * being deleted and its queueId is never reused, so dropping the lock is safe
 * even if a slow task is still settling past cancelAndWait's BOUNDED/best-effort
 * wait — that straggler would just lazily recreate a lock no new work shares,
 * and it's GC'd once the straggler finishes. (No strong "all turns settled"
 * guarantee is assumed here.)
 */
export function clearToolConcurrencyLocksForThread(threadId: string): void {
  toolConcurrencyLocks.delete(threadId)
  toolConcurrencyLocks.delete(`${threadId}:subagent`)
  taskConcurrencyLimiters.delete(threadId)
  taskConcurrencyLimiters.delete(`${threadId}:subagent`)
}

function getTaskConcurrencyLimiter(queueId: string): AsyncSemaphore {
  let limiter = taskConcurrencyLimiters.get(queueId)
  if (!limiter) {
    limiter = new AsyncSemaphore(MAX_PARALLEL_TASK_SUBAGENTS)
    taskConcurrencyLimiters.set(queueId, limiter)
  }
  return limiter
}

function createGradedToolConcurrencyMiddleware(
  queueId: string,
  isWorkflowActive?: (queueId: string) => boolean
) {
  const lock = getToolConcurrencyLock(queueId)
  const taskLimiter = getTaskConcurrencyLimiter(queueId)
  return createMiddleware({
    name: "gradedToolConcurrency",
    wrapToolCall: async (request, handler) => {
      const toolCall = request.toolCall as
        | { id?: string; name?: string; args?: unknown }
        | undefined
      if (shouldFastRejectActiveWorkflow(queueId, toolCall, isWorkflowActive)) {
        return handler(request)
      }
      const tier = classifyToolConcurrency(toolCall)
      if (tier === "bypass") {
        return handler(request)
      }
      const label = `${toolCall?.name ?? "unknown"}:${toolCall?.id ?? "no-id"}`
      const waitStart = Date.now()
      if (tier === "shared") {
        const runSharedTool = () =>
          lock.read(async () => {
            const waited = Date.now() - waitStart
            if (waited > 50)
              console.log(`[Runtime] shared-lock acquired ${label} after ${waited}ms`)
            return handler(request)
          })

        if (toolCall?.name === "task") {
          return taskLimiter.run(runSharedTool)
        }

        return runSharedTool()
      }
      return lock.write(async () => {
        const waited = Date.now() - waitStart
        if (waited > 50) console.log(`[Runtime] exclusive-lock acquired ${label} after ${waited}ms`)
        return handler(request)
      })
    }
  })
}

const BASE_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools."

function stringifySystemPromptForPreview(systemMessage: unknown): string {
  if (typeof systemMessage === "string") return systemMessage
  if (!systemMessage || typeof systemMessage !== "object") return String(systemMessage ?? "")

  const content = (systemMessage as { content?: unknown }).content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block
        if (block && typeof block === "object") {
          const text = (block as { text?: unknown }).text
          if (typeof text === "string") return text
        }
        return ""
      })
      .filter(Boolean)
      .join("\n\n")
  }

  try {
    return JSON.stringify(systemMessage, null, 2)
  } catch {
    return String(systemMessage)
  }
}

export const TASK_TOOL_PROMPT = `## \`task\` (subagent spawner)

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
- If the user or Skills explicitly instruct not to use the task tool or subagents.

## Important Task Tool Usage Notes to Remember
- You can call up to 3 \`task\` tools in a single response. When delegated tasks have no dependencies, launch independent subagents in parallel instead of serializing work that can run simultaneously.
- Use parallel subagents for independent research angles, large-context investigations, or isolated multi-step work that would otherwise bloat the main thread. Do not use subagents excessively for trivial lookups.
- If one subagent's result is needed to define another task, run those tasks sequentially.
- For write-heavy work, avoid parallel subagents that may edit overlapping files; use one subagent per file area or serialize dependent edits.
- Avoid duplicate delegation and do not repeat the same research yourself while subagents are doing it. Give each subagent a distinct question, file area, or acceptance criterion.
- Each subagent prompt must be self-contained. Subagents cannot see the main conversation or other subagents' findings unless you include the needed context.
- After subagents return, synthesize results in the main thread. Do not hand off vague instructions like "based on the findings" to another subagent.
- Remember to use the \`task\` tool to silo independent tasks within a multi-part objective.
- You should use the \`task\` tool whenever you have a complex task that will take multiple steps, and is independent from other tasks that the agent needs to complete. These agents are highly competent and efficient.`

// Skill lifecycle hooks can return guidance for the model, but that guidance
// must not be appended to the SKILL.md file content returned by read_file.
// Drain it into an independent system-message section on the next model call.

export function createSkillHookContextMiddleware(
  filesystemBackend: Partial<SkillHookContextProvider>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return createMiddleware({
    name: "skillHookContext",
    wrapModelCall: (request, handler) => {
      if (typeof filesystemBackend.drainSkillHookContexts !== "function") return handler(request)

      let contexts: string[] = []
      try {
        contexts = filesystemBackend.drainSkillHookContexts()
      } catch (error) {
        console.warn("[Runtime] Failed to drain skill hook context:", error)
      }
      if (contexts.length === 0) return handler(request)

      const injectedContext = [
        "",
        "## Skill Hook Context",
        "The following guidance was produced by skill lifecycle hooks. It is not part of any SKILL.md file content.",
        ...contexts
      ].join("\n\n")

      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(injectedContext)
      })
    }
  })
}

export function createOutputStyleTurnReminderMiddleware(
  outputStyle: AgentOutputStyle
): ReturnType<typeof createMiddleware> {
  return createTurnReminderMiddleware(
    "outputStyleTurnReminder",
    getOutputStyleTurnReminder(outputStyle)
  )
}

export function createToolStrategyTurnReminderMiddleware(
  strategy: AgentToolStrategy,
  access?: CoordinatorWorkerFilesystemAccess,
  fileTools?: ToolStrategyFileTools
): ReturnType<typeof createMiddleware> {
  return createTurnReminderMiddleware(
    "toolStrategyTurnReminder",
    getToolStrategyReminder(strategy, fileTools),
    (request) =>
      resolveEffectiveToolStrategy(strategy, request.tools ?? [], access, fileTools) !== "standard"
  )
}

function createTurnReminderMiddleware(
  name: string,
  reminder: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldRemind: (request: any) => boolean = () => true
): ReturnType<typeof createMiddleware> {
  const reminderContent = reminder ? `<system-reminder>\n${reminder}\n</system-reminder>` : null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appendReminder = (content: any): any =>
    typeof content === "string"
      ? `${content}\n\n${reminderContent}`
      : [...content, { type: "text" as const, text: reminderContent }]

  return createMiddleware({
    name,
    // Mirror Claude Code's output-style attachment normalization without
    // persisting the reminder: merge into the current user turn, or smoosh into
    // the last tool result. Never append a standalone HumanMessage after a tool
    // result — compatible models can interpret that as a fresh user turn and
    // stop the agent loop. Unexpected message shapes use an ephemeral system
    // fallback so the reminder remains model-visible without changing history.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapModelCall: (request: any, handler: any) => {
      if (!reminderContent || !shouldRemind(request)) return handler(request)
      const messages = Array.isArray(request.messages) ? request.messages : []
      const lastMessage = messages[messages.length - 1]
      const lastType = lastMessage?._getType?.()

      if (lastMessage instanceof HumanMessage || lastType === "human") {
        const outboundLastMessage = new HumanMessage({
          content: appendReminder(lastMessage.content),
          id: lastMessage.id,
          name: lastMessage.name,
          additional_kwargs: lastMessage.additional_kwargs,
          response_metadata: lastMessage.response_metadata
        })
        return handler({
          ...request,
          messages: [...messages.slice(0, -1), outboundLastMessage]
        })
      }

      if (lastMessage instanceof ToolMessage || lastType === "tool") {
        const outboundLastMessage = new ToolMessage({
          content: appendReminder(lastMessage.content),
          tool_call_id: lastMessage.tool_call_id,
          id: lastMessage.id,
          name: lastMessage.name,
          status: lastMessage.status,
          artifact: lastMessage.artifact,
          metadata: lastMessage.metadata,
          additional_kwargs: lastMessage.additional_kwargs,
          response_metadata: lastMessage.response_metadata
        })
        return handler({
          ...request,
          messages: [...messages.slice(0, -1), outboundLastMessage]
        })
      }

      return handler({
        ...request,
        systemMessage: request.systemMessage
          ? request.systemMessage.concat(`\n\n${reminderContent}`)
          : new SystemMessage(reminderContent)
      })
    }
  })
}

/** Best-effort extraction of the command string from an execute tool call's args
 * (object or JSON string). Returns null if not determinable — then we let the
 * call through (assessCommandSafety can't judge what it can't see, and the normal
 * approval flow still applies downstream). */
function extractExecuteCommand(args: unknown): string | null {
  let obj: unknown = args
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args)
    } catch {
      return null
    }
  }
  if (obj && typeof obj === "object") {
    const cmd = (obj as { command?: unknown }).command
    if (typeof cmd === "string") return cmd
  }
  return null
}

/**
 * Tool-access guard for a registry task subagent (agents with a non-default
 * tool policy — built-in Explore/Plan/verification + user agents). deepagents
 * shares the main fs middleware — which provides write_file/edit_file/execute —
 * across ALL task subagents, and a per-subagent middleware can only be APPENDED,
 * never remove that shared one. So this guard enforces the agent's policy by
 * (1) HIDING blocked tools from the model each turn via wrapModelCall (the same
 * lever deepagents itself uses to drop `execute` for non-exec backends), and
 * (2) HARD-REJECTING calls to them via wrapToolCall. For shellAccess="read_only"
 * it keeps execute visible but rejects any command exec-policy does not classify
 * as provably read-only — stronger than Claude Code's prompt-only constraint.
 */
export function createAgentToolGuardMiddleware(
  disallowedTools: string[],
  shellAccess: AgentShellAccess,
  windowsShell: WindowsShellKind = "unknown"
): ReturnType<typeof createMiddleware> {
  // Full blocked set = the agent's disallowedTools + ad-hoc-exec/orchestration
  // meta tools (registry agents are subagents, not orchestrators) + execute/
  // task_output when shell is off + browser for read-only. MCP is kept.
  const blocked = registryAgentBlockedTools(disallowedTools, shellAccess)
  return createMiddleware({
    name: `agentToolGuard:${shellAccess}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapModelCall: (request: any, handler: any) => {
      const tools = Array.isArray(request.tools)
        ? request.tools.filter((t: { name?: string }) => !t.name || !blocked.has(t.name))
        : request.tools
      // Also strip the blocked tools' usage docs from the injected system prompt
      // (deepagents' fs middleware advertises tools there, not just in the tool
      // list) so the model never even sees a description of a tool it can't use —
      // matching Claude Code, whose disallowed tools never appear in the prompt.
      const systemMessage = stripBlockedToolDocs(request.systemMessage, blocked)
      return handler({ ...request, tools, systemMessage })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapToolCall: (request: any, handler: any) => {
      const name: string | undefined = request.toolCall?.name
      const toolCallId: string = request.toolCall?.id ?? ""
      if (name && blocked.has(name)) {
        return new ToolMessage({
          content: `Tool "${name}" is unavailable: this agent's tool policy does not allow it. Inspect and report instead of modifying files.`,
          tool_call_id: toolCallId,
          name,
          status: "error"
        })
      }
      if (name === "execute" && shellAccess === "read_only") {
        const command = extractExecuteCommand(request.toolCall?.args)
        if (command !== null && !isReadOnlyShellCommand(command, "", windowsShell)) {
          return new ToolMessage({
            content: readOnlyExecuteBlockMessage(windowsShell),
            tool_call_id: toolCallId,
            name,
            status: "error"
          })
        }
        // This guards a registry task subagent that SHARES the main agent's
        // (non-read-only) LocalSandbox, so the sandbox's instance flag is off.
        // Run the execute call inside the read-only context so the sandbox's
        // post-hook gate still fires if a PreToolUse hook rewrites this safe
        // command into a build/write one. AsyncLocalStorage scopes it to this
        // call — concurrent write-capable sibling subagents are unaffected.
        return readOnlyShellExecutionContext.run(true, () => handler(request))
      }
      return handler(request)
    }
  })
}

/**
 * Exact main-runtime tool denylist used by transport capability policies.
 *
 * This stays separate from the registry/coordinator worker access model: a
 * remote inbox is still the main agent and may keep `manage_scheduler`, while
 * transport-incompatible tools such as `execute` are removed. Hiding and
 * hard-rejecting use the same set so a recovered tool call cannot bypass the
 * advertised policy.
 */
export function createRuntimeToolDenylistMiddleware(
  disallowedTools: readonly string[]
): ReturnType<typeof createMiddleware> {
  const blocked = new Set(disallowedTools.map((name) => name.trim()).filter(Boolean))
  return createMiddleware({
    name: "runtimeToolDenylist",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapModelCall: (request: any, handler: any) => {
      const tools = Array.isArray(request.tools)
        ? request.tools.filter((tool: { name?: string }) => !tool.name || !blocked.has(tool.name))
        : request.tools
      return handler({
        ...request,
        tools,
        systemMessage: stripBlockedToolDocs(request.systemMessage, blocked)
      })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapToolCall: (request: any, handler: any) => {
      const name: string | undefined = request.toolCall?.name
      if (!name || !blocked.has(name)) return handler(request)
      return new ToolMessage({
        content: `Tool "${name}" is unavailable for this message source. Continue using the available tools.`,
        tool_call_id: request.toolCall?.id ?? "",
        name,
        status: "error"
      })
    }
  })
}

function describeRegistrySubagentAccess(
  disallowedTools: readonly string[],
  shellAccess: AgentShellAccess
): string {
  const parts: string[] = []
  if (disallowedTools.length > 0) parts.push(`no ${disallowedTools.join("/")}`)
  parts.push(
    shellAccess === "none"
      ? "no shell"
      : shellAccess === "read_only"
        ? "read-only shell"
        : "full shell"
  )
  return parts.join(", ")
}

function appendRegistrySubagentAccessDescription(
  description: string,
  disallowedTools: readonly string[],
  shellAccess: AgentShellAccess
): string {
  return `${description} [${describeRegistrySubagentAccess(disallowedTools, shellAccess)}]`
}

/**
 * Stable metadata key stamped onto every subagent-interior stream chunk so the
 * renderer can attribute it to the owning `task` tool call deterministically —
 * independent of concurrency or chunk ordering. The value is the parent `task`
 * tool_call_id (== the subagent id used by the UI).
 *
 * Mirrored as a literal in electron-transport.ts and stream-converter.ts; the
 * renderer cannot import from main, so keep the three in sync.
 */
export const SUBAGENT_OWNER_METADATA_KEY = SOLO_TASK_OWNER_METADATA_KEY

export const ACTION_STATIONARITY_OWNER_CONFIG_KEY = "cmb_action_stationarity_owner"

export const SUBAGENT_SUMMARIZATION_OWNER_CONFIG_KEY = "cmb_subagent_summarization_owner"

const TASK_SUBAGENT_SUMMARIZATION_STATE_KEYS = new Set([
  "_summarizationEvent",
  "_summarizationSessionId",
  "_cmbSummarizationOwner"
])

/**
 * Task subagents are isolated conversations. DeepAgents copies arbitrary parent
 * state into the child and returns arbitrary child state to the parent, which
 * would otherwise leak its cutoff-based summarization event across the task
 * boundary. Strip only those private lifecycle fields from the returned Command.
 */
function stripTaskSubagentSummarizationState(result: unknown): unknown {
  if (!(result instanceof Command) || result.update == null) return result

  const update = result.update
  if (Array.isArray(update)) {
    const sanitized = update.filter(
      ([key]) => typeof key !== "string" || !TASK_SUBAGENT_SUMMARIZATION_STATE_KEYS.has(key)
    )
    if (sanitized.length === update.length) return result
    return new Command({
      graph: result.graph,
      resume: result.resume,
      goto: result.goto,
      update: sanitized
    })
  }

  if (typeof update !== "object") return result
  const sanitized = Object.fromEntries(
    Object.entries(update).filter(([key]) => !TASK_SUBAGENT_SUMMARIZATION_STATE_KEYS.has(key))
  )
  if (Object.keys(sanitized).length === Object.keys(update).length) return result
  return new Command({
    graph: result.graph,
    resume: result.resume,
    goto: result.goto,
    update: sanitized
  })
}

let idlessTaskInvocationSequence = 0

function taskInvocationOwnerId(config: { toolCall?: { id?: unknown }; toolCallId?: unknown }): {
  explicit?: string
  stationarity: string
} {
  const normalizeId = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined
  const explicit = normalizeId(config?.toolCall?.id) ?? normalizeId(config?.toolCallId)
  if (explicit) return { explicit, stationarity: explicit }

  idlessTaskInvocationSequence += 1
  return {
    stationarity: `idless-task-${idlessTaskInvocationSequence}`
  }
}

/**
 * Wrap deepagents' internal `task` tool so each subagent invocation stamps its
 * owning tool_call_id into run metadata. deepagents passes the task tool's
 * `config` straight to `subagent.invoke`, and LangGraph propagates
 * `config.metadata` into every streamed message's metadata — so the owner id
 * rides along on all subagent-interior chunks. Re-invoking the original tool
 * with the ToolCall as input re-establishes `config.toolCall` inside it (see
 * @langchain/core tools `invoke`), preserving its Command/result contract.
 */
export type ModTaskExecution = <T>(
  input: { agentId: string; subagentType?: string; signal?: AbortSignal },
  run: () => Promise<T>
) => Promise<T>

export function wrapTaskToolWithOwnerMetadata(
  taskTool: DynamicStructuredTool,
  soloTaskTraceManager?: SoloTaskTraceManager,
  captureThreadId?: string,
  runModTask?: ModTaskExecution
): DynamicStructuredTool {
  return tool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (input: Record<string, unknown>, config: any) => {
      const invocationOwner = taskInvocationOwnerId(config)
      const ownerId = invocationOwner.explicit
      const metadata = { ...(config?.metadata ?? {}) }
      const configurable = { ...(config?.configurable ?? {}) }
      // A nested id-less task must not inherit its parent's renderer identity.
      delete metadata[SUBAGENT_OWNER_METADATA_KEY]
      delete configurable[SUBAGENT_OWNER_METADATA_KEY]
      if (ownerId) {
        metadata[SUBAGENT_OWNER_METADATA_KEY] = ownerId
        configurable[SUBAGENT_OWNER_METADATA_KEY] = ownerId
      }
      const patchedConfig = {
        ...config,
        // Only a real tool-call id may be exposed as renderer attribution.
        // The generated fallback exists solely inside configurable so an
        // id-less invocation receives its own stationarity scope without
        // pretending to be a UI task id.
        metadata,
        configurable: {
          ...configurable,
          [ACTION_STATIONARITY_OWNER_CONFIG_KEY]: invocationOwner.stationarity,
          [SUBAGENT_SUMMARIZATION_OWNER_CONFIG_KEY]: invocationOwner.stationarity
        }
      }
      const taskInput =
        config?.toolCall?.args && typeof config.toolCall.args === "object"
          ? (config.toolCall.args as Record<string, unknown>)
          : input
      if (ownerId) {
        soloTaskTraceManager?.startTask({
          ownerId,
          description:
            typeof taskInput.description === "string" ? taskInput.description : undefined,
          subagentType:
            typeof taskInput.subagent_type === "string" ? taskInput.subagent_type : undefined
        })
      }
      try {
        // Pass the ToolCall as input so the original re-derives config.toolCall.id
        // and preserves its Command/task-ToolMessage contract.
        const invoke = () =>
          taskTool.invoke(config?.toolCall ?? input, {
            ...patchedConfig,
            callbacks: subagentSessionCallbacks(patchedConfig.callbacks)
          })
        const invokeCaptured = () =>
          captureThreadId && ownerId
            ? withSubagentSessionCapture(
                { kind: "multi", threadId: captureThreadId, subagentId: ownerId },
                typeof taskInput.description === "string" ? taskInput.description : "子代理",
                invoke
              )
            : taskTool.invoke(config?.toolCall ?? input, patchedConfig)
        const execute = () => withTaskModelOutcome(invokeCaptured, config?.signal)
        const result = await (runModTask
          ? runModTask(
              {
                agentId: ownerId ?? `mod-task:${invocationOwner.stationarity}`,
                subagentType:
                  typeof taskInput.subagent_type === "string" ? taskInput.subagent_type : undefined,
                signal: config?.signal
              },
              execute
            )
          : execute())
        const sanitizedResult = stripTaskSubagentSummarizationState(result)
        if (ownerId) soloTaskTraceManager?.finishTask(ownerId, "success", sanitizedResult)
        return sanitizedResult
      } catch (error) {
        if (ownerId) {
          soloTaskTraceManager?.finishTask(
            ownerId,
            isAbortError(error) ? "cancelled" : "error",
            error
          )
        }
        throw error
      }
    },
    {
      name: taskTool.name,
      description: taskTool.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schema: (taskTool as any).schema
    }
  ) as unknown as DynamicStructuredTool
}

/**
 * Replace the `task` tool inside a subagent middleware with the owner-stamping
 * wrapper, leaving the middleware's wrapModelCall (task system prompt) intact.
 */
function stampSubagentOwnerMetadata<T>(
  middleware: T,
  soloTaskTraceManager?: SoloTaskTraceManager,
  captureThreadId?: string,
  runModTask?: ModTaskExecution
): T {
  const mw = middleware as { tools?: DynamicStructuredTool[] }
  if (Array.isArray(mw.tools) && mw.tools.length > 0) {
    mw.tools = mw.tools.map((t) =>
      t?.name === "task"
        ? wrapTaskToolWithOwnerMetadata(t, soloTaskTraceManager, captureThreadId, runModTask)
        : t
    )
  }
  return middleware
}

/**
 * Keep a model-requested write_file distinguishable from DeepAgents' automatic
 * large-tool-result spill. Both eventually call Backend.write(), but only the
 * latter is allowed to use the app-managed internal artifact channel.
 */
function markFilesystemWriteToolAsUserInitiated(middleware: {
  tools?: DynamicStructuredTool[]
}): void {
  const tools = middleware.tools
  const index = tools?.findIndex((candidate) => candidate?.name === "write_file") ?? -1
  if (index < 0 || !tools?.[index]) {
    console.warn("[Runtime] write_file tool origin patch skipped: tool not found")
    return
  }

  const original = tools[index]
  tools[index] = tool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (input: Record<string, unknown>, config: any) =>
      agentFileWriteContext.run(true, () => original.invoke(config?.toolCall ?? input, config)),
    {
      name: original.name,
      description: original.description,
      // DynamicStructuredTool keeps its schema public, but the generic type is
      // intentionally broader than the tool() helper accepts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schema: (original as any).schema
    }
  ) as unknown as DynamicStructuredTool
}

/**
 * Custom version of deepagents' createDeepAgent.
 *
 * Aligned with the lockfile-pinned DeepAgents 1.8.5 except:
 *   - Accepts `summarizationTrigger` / `summarizationKeep` for explicit overrides
 *     (useful for custom models without a profile).
 *   - Accepts a custom summarization prompt tuned for coding-agent handoffs.
 *   - Accepts custom argument-truncation thresholds so large-context models
 *     don't trim old edit/write tool args after a fixed 20 messages.
 */
export function createDeepAgent(
  params: Parameters<typeof assembleDeepAgent>[0] = {},
  services: DeepAgentServices = {}
): DeepAgent {
  return assembleDeepAgent(params, false, services) as DeepAgent
}

export interface DeepAgentToolCatalogOptions {
  tools: unknown[]
  mainSubagentsEnabled: boolean
  registrySubagentSpecs: Array<{
    name: string
    description: string
    systemPrompt: string
    disallowedTools?: string[]
    shellAccess?: AgentShellAccess
  }>
}

/** The same tool factories, without creating a model, graph, sandbox or runtime authority. */
export function prepareDeepAgentToolCatalog(
  options: DeepAgentToolCatalogOptions,
  services: DeepAgentServices = {}
): FunctionToolInfo[] {
  return assembleDeepAgent(
    {
      ...options,
      backend: () => {
        throw new ModError("MODS_TOOL_METADATA_ONLY")
      }
    },
    true,
    services
  ) as FunctionToolInfo[]
}

function assembleDeepAgent(
  params: Record<string, unknown>,
  metadataOnly: boolean,
  services: DeepAgentServices
): DeepAgent | FunctionToolInfo[] {
  const unavailable = () => {
    throw new Error("The requested graph capability requires a host service")
  }
  const {
    getModsManager = unavailable,
    createTrustedToolFilePreviewContextMiddleware = unavailable,
    createTaskMmdMiddleware = unavailable,
    createFunctionChildTurnMiddleware = unavailable,
    currentFunctionExecution = unavailable,
    setCapturedSystemPromptPreview = unavailable,
    createFunctionSessionViewMiddleware = unavailable
  } = services
  const {
    model = "claude-sonnet-4-5-20250929",
    summarizationModel = model,
    summarizationFallbackModel,
    tools = [],
    systemPrompt,
    middleware: customMiddleware = [],
    outerMiddleware = [],
    isFatalToolError,
    turnCompletionOwnerToken,
    turnCompletionCheckpointed = false,
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
    trimTokensToSummarize,
    summarizationMaxInputTokens,
    summarizationPostCompactionInputBudgetTokens,
    summarizationSummaryPrompt,
    summarizationHistoryPathPrefix,
    summarizationHistoryStorage,
    summarizationLegacyHistoryPathPrefix,
    summarizationTruncateArgsSettings,
    onContextCompaction,
    subagentExtraSystemPrompt,
    subagentExtraSystemPromptForRestrictedRoles = false,
    mainFilesystemEnabled = true,
    mainTodosEnabled = true,
    subagentDefaultTools,
    taskSystemPrompt = TASK_TOOL_PROMPT,
    includeGeneralPurposeSubagent = true,
    mainSubagentsEnabled = true,
    filesystemAccess,
    mainBlockedToolNames = [],
    managedExecution = false,
    registrySubagentSpecs = [],
    modRuntimeAuthority,
    modSessionModel,
    modSessionCompact,
    modTurnRunId,
    // Windows shell kind the runtime's commands execute in (derived from the
    // sandbox). Threaded into the read-only execute gate so Windows PowerShell
    // read-only cmdlets (Get-Content, …) aren't false-blocked. "unknown" =
    // strict cross-platform behavior (the macOS/Linux default).
    windowsShellKind = "unknown",
    toolConcurrencyQueueId = "default",
    toolHookMiddleware,
    threadId,
    onTaskSubagentPromptsResolved,
    currentRunMessageQueueOwnerToken,
    currentRunDurableQueue,
    soloTaskTraceManager,
    actionStationarityTurnId,
    // PR-12 — optional callback fired-and-forgotten by toolErrorMiddleware
    // when a tool throws. Closed-over context (threadId / workspace /
    // hookScope / onHookResult) lives at the createAgentRuntime layer; this
    // adapter keeps createDeepAgent oblivious to that wiring.
    onToolFailureSignal,
    onFinalSystemPrompt,
    onFailureFuseNotice,
    onTurnCompletionRecovery,
    turnCompletionTodoGateEnabled = true,
    outputStyle,
    toolStrategy = "standard",
    conciseModeEnabled = false
  }: {
    isFatalToolError?: (error: unknown) => boolean
    onFinalSystemPrompt?: (prompt: string) => void
    onTaskSubagentPromptsResolved?: (prompts: Array<{ name: string; systemPrompt: string }>) => void
    onToolFailureSignal?: (input: {
      toolName: string | undefined
      toolCallId: string | undefined
      toolArgs: unknown
      signal: ToolFailureSignal
    }) => FailureFuseDecision | void
    onFailureFuseNotice?: FailureFuseNoticeCallback
    onTurnCompletionRecovery?: TurnCompletionRecoveryCallback
    turnCompletionTodoGateEnabled?: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any
  } = params

  const loopGuardsEnabled = areAgentLoopGuardsEnabled()

  // Only this graph's native filesystem descriptions use its effective strategy.
  // Shared task tools and child runtimes retain the requested preference.
  const mainToolStrategy = resolveFilesystemToolStrategy(toolStrategy, {
    filesystemAccess,
    blockedToolNames: mainBlockedToolNames,
    filesystemEnabled: mainFilesystemEnabled
  })
  const effectiveOutputStyle = resolveAgentOutputStyle(outputStyle, conciseModeEnabled)
  const outputStylePrompt = getOutputStylePrompt(effectiveOutputStyle)

  // Preserve the existing assembled prompt exactly when the default style is selected.
  const assembledSystemPrompt = systemPrompt
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
  const finalSystemPrompt = outputStylePrompt
    ? typeof assembledSystemPrompt === "string"
      ? `${OUTPUT_STYLE_IDENTITY_PROMPT}\n\n${assembledSystemPrompt}\n\n${outputStylePrompt}`
      : new SystemMessage({
          content: [
            { type: "text" as const, text: OUTPUT_STYLE_IDENTITY_PROMPT },
            ...(typeof assembledSystemPrompt.content === "string"
              ? [{ type: "text" as const, text: assembledSystemPrompt.content }]
              : assembledSystemPrompt.content),
            { type: "text" as const, text: outputStylePrompt }
          ]
        })
    : assembledSystemPrompt
  if (typeof finalSystemPrompt === "string") {
    onFinalSystemPrompt?.(finalSystemPrompt)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filesystemBackend = backend ? backend : (config: any) => new StateBackend(config)
  const skillsMiddlewareArray =
    skills != null && skills.length > 0
      ? [createRefreshingSkillsMiddleware({ backend: filesystemBackend, sources: skills })]
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
    const subagentSkillsMiddleware = createRefreshingSkillsMiddleware({
      backend: filesystemBackend,
      sources: subagent.skills ?? []
    })
    return {
      ...subagent,
      middleware: [subagentSkillsMiddleware, ...(subagent.middleware || [])]
    }
  })

  // Summarization options: pass explicit trigger/keep if provided, otherwise let
  // the CmbCowork summarization middleware compute them from the model profile.
  const summarizationBaseOptions = {
    backend: filesystemBackend,
    historyPathPrefix: summarizationHistoryPathPrefix ?? "/conversation_history",
    ...(summarizationHistoryStorage && { historyStorage: summarizationHistoryStorage }),
    ...(summarizationLegacyHistoryPathPrefix && {
      legacyHistoryPathPrefix: summarizationLegacyHistoryPathPrefix
    }),
    ...(summarizationSummaryPrompt && { summaryPrompt: summarizationSummaryPrompt }),
    ...(trimTokensToSummarize != null && { trimTokensToSummarize }),
    ...(summarizationMaxInputTokens != null && {
      maxInputTokens: summarizationMaxInputTokens
    }),
    ...(summarizationPostCompactionInputBudgetTokens != null && {
      postCompactionInputBudgetTokens: summarizationPostCompactionInputBudgetTokens
    }),
    ...(summarizationTrigger != null && { trigger: summarizationTrigger }),
    ...(summarizationKeep != null && { keep: summarizationKeep }),
    ...(summarizationTruncateArgsSettings && {
      truncateArgsSettings: summarizationTruncateArgsSettings
    })
  }
  const mainSummarizationOptions = {
    ...summarizationBaseOptions,
    model: configureContextCompactionModel(summarizationModel, onContextCompaction),
    ...(summarizationFallbackModel && {
      fallbackModel: configureContextCompactionModel(
        summarizationFallbackModel,
        onContextCompaction
      )
    })
  }
  const subagentSummarizationOptions = {
    ...summarizationBaseOptions,
    stateOwnerConfigKey: SUBAGENT_SUMMARIZATION_OWNER_CONFIG_KEY,
    model: configureContextCompactionModel(summarizationModel),
    ...(summarizationFallbackModel && {
      fallbackModel: configureContextCompactionModel(summarizationFallbackModel)
    })
  }
  const mainSummarizationController = createCmbContextController(mainSummarizationOptions)

  // Create filesystem middleware and patch upstream tool defaults/descriptions.
  const createFsMiddleware = (
    fsSystemPrompt = filesystemSystemPrompt,
    fsToolStrategy = toolStrategy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any => {
    // For any restricted leaf runtime — coordinator worker (workload) OR registry
    // workflow agent (explicit denylist/shell) — strip the blocked tools' docs
    // from the injected fs system prompt so a removed tool's description doesn't
    // linger and contradict the tool list (parity with the Solo guard / CC). This
    // only cleans the prompt; it changes no tool permissions or behaviour. The
    // unrestricted main agent (filesystemAccess undefined) keeps the full docs.
    const effectiveFsPrompt =
      fsSystemPrompt && filesystemAccess
        ? (stripBlockedToolDocs(
            fsSystemPrompt,
            blockedToolNamesForAccess(filesystemAccess)
          ) as string)
        : fsSystemPrompt
    const mw = createFilesystemMiddleware({
      backend: filesystemBackend,
      ...(fsToolStrategy !== "standard" && {
        customToolDescriptions: SHELL_FIRST_TOOL_DESCRIPTIONS
      }),
      ...(effectiveFsPrompt && { systemPrompt: effectiveFsPrompt }),
      ...(toolTokenLimitBeforeEvict != null && { toolTokenLimitBeforeEvict })
    })
    markFilesystemWriteToolAsUserInitiated(mw)
    patchRuntimeReadFileTool({
      middleware: mw,
      filesystemBackend,
      toolTokenLimitBeforeEvict,
      ...(soloTaskTraceManager
        ? {
            resolveTraceContextForAgent: (agentId: string) =>
              soloTaskTraceManager.getTraceContextForOwner(agentId)
          }
        : {})
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const grepTool = mw.tools?.find((t: any) => t.name === "grep") as any
    if (grepTool?.schema?.shape?.pattern) {
      const oldDesc = grepTool.schema.shape.pattern.description ?? "(unknown)"
      grepTool.schema = grepTool.schema.extend({
        pattern: grepTool.schema.shape.pattern.describe(
          "Text pattern to search for (literal, not regex)"
        )
      })
      console.log(
        `[Runtime] grep schema patched: "${oldDesc}" → "${grepTool.schema.shape.pattern.description}"`
      )
    } else {
      console.warn("[Runtime] grep tool schema patch skipped: tool or pattern field not found")
    }

    // Replace the default execute tool with a version that supports run_in_background.
    // Long-running commands (builds, dependency downloads) can be started in background
    // and their output retrieved later via task_output tool.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executeIdx = mw.tools?.findIndex((t: any) => t.name === "execute") ?? -1
    if (executeIdx >= 0) {
      const oldExecute = mw.tools![executeIdx]
      const formatExecuteResponse = (result: import("deepagents").ExecuteResponse): string => {
        const parts = [result.output]
        if (result.exitCode !== null) {
          const status = result.exitCode === 0 ? "succeeded" : "failed"
          parts.push(`\n[Command ${status} with exit code ${result.exitCode}]`)
        }
        if (result.truncated) parts.push("\n[Output was truncated due to size limits]")
        return parts.join("")
      }
      const customExecute = lcTool(
        async (input: {
          command: string
          cwd?: string
          run_in_background?: boolean
        }): Promise<string> => {
          const sandbox = filesystemBackend as LocalSandbox
          // Read-only runtimes keep execute but may only run PROVABLY read-only
          // commands — gated per command by isReadOnlyShellCommand. Covers both
          // the registry path (shellAccess "read_only", e.g. Explore) and the
          // coordinator read-only worker (workload "read_only"). Stronger than
          // CC's prompt-only constraint AND stronger than plain "safe": "safe" is
          // the auto-approve tier (so this never surfaces an extra prompt) but it
          // also auto-approves build/install/codegen (npm install, cargo build,
          // make, go run, javac …), which WRITE the tree / run arbitrary code.
          // isReadOnlyShellCommand additionally rejects those while keeping the
          // tools' inspection subcommands (npm ls, go list, mvn dependency:tree).
          const readOnlyShell =
            filesystemAccess?.shellAccess === "read_only" ||
            filesystemAccess?.workload === "read_only"
          if (
            readOnlyShell &&
            !isReadOnlyShellCommand(input.command, input.cwd ?? "", windowsShellKind)
          ) {
            return readOnlyExecuteBlockMessage(windowsShellKind)
          }
          if (input.run_in_background) {
            if (managedExecution) {
              return formatExecuteResponse(await sandbox.execute(input.command, input.cwd))
            }
            return sandbox.executeBackground(input.command, input.cwd)
          }
          if (input.cwd?.trim()) {
            return formatExecuteResponse(await sandbox.execute(input.command, input.cwd))
          }
          // Delegate to original execute handler for foreground execution
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await (oldExecute as any).invoke(input)
          if (typeof result === "string") return result
          try {
            return JSON.stringify(result) ?? String(result)
          } catch {
            return String(result)
          }
        },
        {
          name: "execute",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          description: (oldExecute as any).description,
          schema: z.object({
            command: z.string().describe("The shell command to execute"),
            cwd: z
              .string()
              .optional()
              .describe(
                "Optional working directory for the command. Use the skill directory when running scripts or resources referenced by a SKILL.md."
              ),
            run_in_background: z
              .boolean()
              .optional()
              .describe(
                managedExecution
                  ? "Managed sessions always execute in the foreground. This flag is accepted for compatibility but still waits up to 20 minutes and returns the final command result instead of a task ID."
                  : "Set to true to run the command in the background. Returns a task ID immediately. " +
                      "Use this for long-running commands like builds, dependency downloads, or test suites. " +
                      "Retrieve the result later with the task_output tool."
              )
          })
        }
      )
      mw.tools![executeIdx] = customExecute
      console.log("[Runtime] execute tool patched: added run_in_background support")
    }

    // Add task_output tool for retrieving background task results.
    // Mirrors Claude Code's TaskOutput: blocks internally (100ms poll loop)
    // until the task completes or the timeout expires, so the LLM only needs
    // one tool call per check instead of burning tokens on repeated polls.
    const taskOutputTool = lcTool(
      async (input: { task_id: string; block?: boolean; timeout?: number }) => {
        const sandbox = filesystemBackend as LocalSandbox
        const toolArgs: Record<string, unknown> = { ...input }
        const preResult = await sandbox.runPreToolUseHookForTool("task_output", toolArgs)
        if (preResult?.blocked || preResult?.decision === "block") {
          return `[Hook blocked] ${preResult.stdout || preResult.reason || "task_output was blocked by a hook"}`
        }
        const effectiveArgs = mergeUpdatedInput(toolArgs, preResult?.updatedInput)
        const taskId =
          typeof effectiveArgs.task_id === "string" && effectiveArgs.task_id.trim()
            ? effectiveArgs.task_id
            : input.task_id
        if (!taskId || typeof taskId !== "string") {
          return "Error: Invalid task id."
        }
        const block =
          typeof effectiveArgs.block === "boolean" ? effectiveArgs.block : input.block !== false
        const timeout =
          typeof effectiveArgs.timeout === "number" && Number.isFinite(effectiveArgs.timeout)
            ? Math.max(0, effectiveArgs.timeout)
            : (input.timeout ?? 30_000)

        const readTaskOutputText = async (): Promise<string> => {
          // Non-blocking: return immediately
          if (!block) {
            const result = sandbox.getTaskOutput(taskId)
            if (!result) return `Error: No background task found with id "${taskId}".`
            if (!result.completed) {
              return JSON.stringify({
                retrieval_status: "not_ready",
                elapsed: result.elapsedSeconds,
                command: result.command,
                partialOutput: result.partialOutput,
                partialTruncated: result.partialTruncated,
                idleSeconds: result.idleSeconds
              })
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
            const result = sandbox.getTaskOutput(taskId)
            if (!result) return `Error: No background task found with id "${taskId}".`
            if (result.completed) {
              const status = result.exitCode === 0 ? "succeeded" : "failed"
              return `${result.output ?? "<no output>"}\n[Command ${status} with exit code ${result.exitCode}, elapsed: ${result.elapsedSeconds}s]`
            }
            const elapsed = Date.now() - start
            await new Promise<void>((r) => setTimeout(r, elapsed < 2000 ? 100 : 500))
          }

          // Timeout — return current status so the LLM can decide to call again
          const final = sandbox.getTaskOutput(taskId)
          if (!final) return `Error: No background task found with id "${taskId}".`
          if (final.completed) {
            const status = final.exitCode === 0 ? "succeeded" : "failed"
            return `${final.output ?? "<no output>"}\n[Command ${status} with exit code ${final.exitCode}, elapsed: ${final.elapsedSeconds}s]`
          }
          return JSON.stringify({
            retrieval_status: "timeout",
            elapsed: final.elapsedSeconds,
            command: final.command,
            partialOutput: final.partialOutput,
            partialTruncated: final.partialTruncated,
            idleSeconds: final.idleSeconds
          })
        }

        const resultText = await readTaskOutputText()
        return sandbox.applyPostToolUseHookToText("task_output", effectiveArgs, resultText)
      },
      {
        name: "task_output",
        description:
          "Retrieve the output of a background task started with execute(run_in_background=true). " +
          "By default blocks up to 30 seconds waiting for the task to complete. " +
          "If the task finishes within the timeout, returns the full output. " +
          "If it times out, returns current status — call again to continue waiting. " +
          "Set block=false for a non-blocking status check.",
        schema: z.object({
          task_id: z
            .string()
            .describe("The task ID returned by execute when run_in_background was true"),
          block: z.boolean().optional().describe("Whether to wait for completion (default: true)"),
          timeout: z
            .number()
            .min(0)
            .max(600_000)
            .optional()
            .describe("Max wait time in ms (default: 30000)")
        })
      }
    )
    const guardedTools = applyCoordinatorWorkerFilesystemAccess(
      [...(mw.tools || []), taskOutputTool],
      filesystemAccess
    )
    mw.tools = guardedTools as typeof mw.tools
    console.log("[Runtime] task_output tool added")

    return mw
  }

  // Once any wrapToolCall middleware is attached, ToolNode's
  // defaultHandleToolErrors stops catching tool-body throws. So this
  // middleware must convert any recoverable tool error into a ToolMessage,
  // otherwise runs that used to just show a failed tool crash outright.
  //
  // Re-throw (let the run stop) only for:
  //   - GraphBubbleUp: HITL / subgraph control flow
  //   - AbortError: user cancellation
  //   - ActionStationarityHaltError: a child-agent protection stop
  //   - programmer errors (TypeError / ReferenceError): code bugs we
  //     want surfaced instead of silently retrying
  //   - MiddlewareError: a sibling wrapToolCall middleware threw — its
  //     own bug, not a tool failure
  //
  // Note: `task` / `task_output` errors are treated as recoverable too.
  // deepagents throws a plain Error when the model picks an unknown
  // subagent_type, and we want the model to see that error and retry with
  // a valid name. A real subagent crash will also be surfaced as a
  // ToolMessage — the model can decide whether to retry or abandon.
  const NON_RECOVERABLE_TOOL_NAMES = new Set<string>()

  const isProgrammerError = (error: unknown): boolean =>
    error instanceof TypeError || error instanceof ReferenceError

  const unwrapToolFailure = (
    error: unknown,
    toolName: string | undefined
  ): { kind: "schema" | "runtime"; message: string } | null => {
    if (isFatalToolError?.(error)) return null
    if (isWorkflowStructuredOutputFatalError(error)) return null
    if (isGraphBubbleUp(error) || isAbortError(error)) return null
    if (isHookHaltError(error)) return null
    if (isFailureFuseHaltError(error)) return null
    if (getActionStationarityHaltError(error)) return null
    if (isProgrammerError(error)) return null
    if (MiddlewareError.isInstance(error)) return null

    // ToolNode wraps schema parsing failures in ToolInvocationError.
    // Schema errors are always recoverable — even for task/task_output,
    // since a bad-schema call never actually runs the subagent.
    if (error instanceof ToolInvocationError) {
      if (error.toolError instanceof ToolInputParsingException) {
        return { kind: "schema", message: error.toolError.message }
      }
      return unwrapToolFailure(error.toolError, toolName)
    }

    // Reserved: tool names that should bypass runtime-error recovery even
    // when NON_RECOVERABLE_TOOL_NAMES is non-empty. Currently no tool is
    // listed — task/task_output recover too, matching Claude Code's
    // behaviour of letting the model decide whether to retry after a
    // subagent failure.
    if (toolName && NON_RECOVERABLE_TOOL_NAMES.has(toolName)) return null

    // Any other throw from the tool body is recoverable. Including non-
    // standard throws (plain objects, numbers) — describeToolError will
    // serialise them — because leaving any path un-caught means ToolNode
    // bubbles the throw and kills the run.
    return { kind: "runtime", message: describeToolError(error) }
  }

  const toolErrorMiddleware = createMiddleware({
    name: "toolErrorCatch",
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request)
      } catch (error) {
        // Protection halts are control flow, not tool failures. Propagate
        // before PostToolUseFailure/failure-fuse accounting can misclassify
        // or replace the dedicated stationarity halt.
        if (getActionStationarityHaltError(error)) throw error

        const toolName = request.toolCall?.name
        const toolCallId = request.toolCall?.id

        const aborted =
          (request.runtime as { signal?: AbortSignal } | undefined)?.signal?.aborted === true

        // PR-12 — fire PostToolUseFailure fire-and-forget. Even when the abort
        // path rethrows below, we still want hook scripts to observe the
        // failure so security/observability hooks fire on the same signal as
        // CC. Dedupe by tool_call_id so a downstream `detectToolFailure`
        // check on a recovered ToolMessage doesn't re-fire.
        let failureFuseDecision: FailureFuseDecision | void = undefined
        if (onToolFailureSignal && toolCallId && !hasFailureFired(toolCallId)) {
          const signal = toolFailureSignalFromThrow(error, { aborted })
          markFailureFired(toolCallId)
          failureFuseDecision = onToolFailureSignal({
            toolName,
            toolCallId,
            toolArgs: request.toolCall?.args,
            signal
          })
          if (shouldSendFailureFuseNotice(failureFuseDecision)) {
            onFailureFuseNotice?.(failureFuseDecision)
          }
          if (failureFuseDecision) throwIfFailureFuseHalt(failureFuseDecision)
        }

        if (aborted) {
          throw error
        }

        const recovered = unwrapToolFailure(error, toolName)
        if (!recovered) throw error

        // Without a tool_call_id we can't emit a usable ToolMessage —
        // deepagents' patch middleware treats any ToolMessage whose id
        // doesn't match a corresponding AIMessage.tool_calls[].id as an
        // orphan and drops it silently, so the model would never see the
        // error. Surfacing the original throw is the lesser evil: it
        // crashes visibly instead of swallowing the failure.
        if (!toolCallId) throw error

        console.warn(
          `[Runtime] Recoverable ${recovered.kind} error from tool "${toolName}" handed back to model:`,
          recovered.message
        )
        return new ToolMessage({
          content:
            (recovered.kind === "schema"
              ? `Invalid tool arguments: ${recovered.message}\nPlease fix the arguments and try again.`
              : `Tool execution failed: ${recovered.message}\nPlease adjust your approach and try again if appropriate.`) +
            (shouldAttachFailureFuseFeedback(failureFuseDecision)
              ? `\n\n${formatFailureFuseWarning(failureFuseDecision)}`
              : ""),
          tool_call_id: toolCallId,
          name: toolName,
          status: "error"
        })
      }
    }
  })

  // Base middleware for custom subagents (no skills — custom subagents must define their own)

  const gradedToolConcurrencyMiddleware = createGradedToolConcurrencyMiddleware(
    toolConcurrencyQueueId,
    services.isWorkflowActive
  )
  const subagentToolConcurrencyMiddleware = createGradedToolConcurrencyMiddleware(
    `${toolConcurrencyQueueId}:subagent`,
    services.isWorkflowActive
  )

  const modManager = modRuntimeAuthority ? getModsManager() : undefined
  if (modRuntimeAuthority && !modManager) throw new ModError("MODS_TOOL_AGENT_UNAVAILABLE")
  if (
    tools.some((candidate: { name?: string }) => candidate.name === "workflow") &&
    !services.isWorkflowActive
  )
    throw new Error("Workflow tools require the host workflow lifecycle service")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subagentMiddleware: any[] = mainSubagentsEnabled
    ? [
        ...(soloTaskTraceManager ? [soloTaskTraceManager.middleware] : []),
        // FIRST for the same reason as the main agent: reject recovered-malformed
        // calls before any tool lifecycle (hooks/fuse/task-mmd) can observe them.
        createMalformedToolCallGuardMiddleware(),
        ...(loopGuardsEnabled
          ? [
              createActionStationarityMiddleware({
                turnId: actionStationarityTurnId,
                ownerConfigKey: ACTION_STATIONARITY_OWNER_CONFIG_KEY,
                requireOwner: true
              })
            ]
          : []),
        ...(threadId ? [createTrustedToolFilePreviewContextMiddleware(threadId)] : []),
        todoListMiddleware(),
        createFsMiddleware(),
        ...(threadId ? [createTaskMmdMiddleware({ threadId, scope: "subagent" })] : []),
        createSkillHookContextMiddleware(filesystemBackend),
        subagentToolConcurrencyMiddleware,
        ...(toolHookMiddleware ? [toolHookMiddleware] : []),
        toolErrorMiddleware,
        createCmbSummarizationMiddleware(subagentSummarizationOptions),
        anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
        // Same malformed tool-call recovery as the main agent — task subagents call
        // the same OpenAI-compatible endpoint and can be handed truncated JSON too.
        createMalformedToolCallRecoveryMiddleware(),
        createPatchToolCallsMiddleware(),
        createTaskModelOutcomeMiddleware(),
        ...(modRuntimeAuthority && modManager?.isActive(modRuntimeAuthority.workspace)
          ? [createFunctionChildTurnMiddleware(modManager)]
          : [])
      ]
    : []

  // Manual general-purpose subagent so AGENTS.md can be injected into its
  // systemPrompt. deepagents' built-in generalPurposeAgent path offers no
  // hook for project instructions. Spread GENERAL_PURPOSE_SUBAGENT to inherit
  // the canonical name/description/default prompt, so future upstream tweaks
  // propagate automatically.
  const generalPurposeSubagent = {
    ...GENERAL_PURPOSE_SUBAGENT,
    systemPrompt: subagentExtraSystemPrompt
      ? `${GENERAL_PURPOSE_SUBAGENT.systemPrompt}\n\n## Project Instructions\n\n${subagentExtraSystemPrompt}`
      : GENERAL_PURPOSE_SUBAGENT.systemPrompt,
    // general-purpose is write-capable → gets MEMORY.md injection. This mirrors
    // CC's DEFAULT (tengu_moth_copse off): the user's auto-MEMORY.md (AutoMem) is
    // carried in userContext.claudeMd alongside CLAUDE.md, and a write-capable
    // subagent inherits claudeMd — only agents with omitClaudeMd (Explore/Plan)
    // drop it. Verified against CC source (getMemoryFiles → getClaudeMds →
    // getUserContext; runAgent omitClaudeMd path). memory_search/memory_get tools
    // are inherited too.
    middleware: [...skillsMiddlewareArray, ...memoryMiddlewareArray]
  }
  // Open registry agents (built-in Explore/Plan/verification + user files under
  // .cmbcoworkagent/agents/) join general-purpose as task-tool subagents. Each
  // carries a focused systemPrompt, an optional model override, and — when its
  // tool policy is non-default — a guard middleware that genuinely removes the
  // disallowed tools from the model and enforces the shell policy (deepagents
  // shares the main fs middleware across subagents and only appends per-subagent
  // middleware, so the guard hides + hard-rejects rather than detaching the
  // shared tools). Skip any spec colliding with general-purpose or an
  // already-processed subagent name.
  const existingSubagentNames = new Set<string>(
    [
      ...(includeGeneralPurposeSubagent ? [GENERAL_PURPOSE_SUBAGENT.name] : []),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...processedSubagents.map((s: any) => (s && typeof s.name === "string" ? s.name : undefined))
    ].filter((name): name is string => Boolean(name))
  )
  const modAgentAccess = new Map<
    string,
    { blockedToolNames: ReadonlySet<string>; readOnly: boolean; tools?: FunctionToolInfo[] }
  >()
  if (
    includeGeneralPurposeSubagent &&
    !processedSubagents.some((subagent) => subagent?.name === GENERAL_PURPOSE_SUBAGENT.name)
  )
    modAgentAccess.set(GENERAL_PURPOSE_SUBAGENT.name, {
      blockedToolNames: new Set(),
      readOnly: false
    })
  const registrySubagents = (
    registrySubagentSpecs as Array<{
      name: string
      description: string
      systemPrompt: string
      disallowedTools?: string[]
      shellAccess?: AgentShellAccess
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model?: any
    }>
  )
    .filter(
      (spec) => spec.name !== GENERAL_PURPOSE_SUBAGENT.name && !existingSubagentNames.has(spec.name)
    )
    .map((spec) => {
      const disallowed = spec.disallowedTools ?? []
      const shell: AgentShellAccess = spec.shellAccess ?? "full"
      modAgentAccess.set(spec.name, {
        blockedToolNames: registryAgentBlockedTools(disallowed, shell),
        readOnly: shell === "read_only"
      })
      // read_only AND none are both restricted roles. Outside project mode they
      // preserve the existing omitClaudeMd-style behavior; project mode may
      // explicitly share the main agent's already-resolved project context with
      // every task subagent without changing this role's tools or MEMORY.md policy.
      const restrictedRole = shell === "read_only" || shell === "none"
      // The guard ALWAYS applies to registry agents: even a write-capable custom
      // agent is a subagent and must not get ad-hoc-exec/orchestration meta tools
      // (code_exec/manage_scheduler/manage_skill). It's ordered BEFORE the skills
      // middleware so the guard's systemMessage strip runs first and never touches
      // the injected skill list. Registry agents also see the project skill
      // catalogue (CC subagents can invoke skills). MEMORY.md keeps the existing
      // restricted-role policy; project-mode context inheritance is handled only
      // in the systemPrompt below. memory_search/memory_get TOOLS are inherited
      // regardless of role.
      const middleware = [
        createAgentToolGuardMiddleware(disallowed, shell, windowsShellKind),
        ...skillsMiddlewareArray,
        ...(restrictedRole ? [] : memoryMiddlewareArray)
      ]
      return {
        name: spec.name,
        description: appendRegistrySubagentAccessDescription(spec.description, disallowed, shell),
        // Preserve the existing non-project restricted-role behavior. In project
        // mode the caller opts every task subagent into the same resolved context
        // snapshot as the main agent, without another AGENTS.md read.
        systemPrompt:
          (!restrictedRole || subagentExtraSystemPromptForRestrictedRoles) &&
          subagentExtraSystemPrompt
            ? `${spec.systemPrompt}\n\n## Project Instructions\n\n${subagentExtraSystemPrompt}`
            : spec.systemPrompt,
        ...(spec.model ? { model: spec.model } : {}),
        ...(middleware.length > 0 ? { middleware } : {})
      }
    })

  const unresolvedSubagents = includeGeneralPurposeSubagent
    ? [generalPurposeSubagent, ...processedSubagents, ...registrySubagents]
    : [...processedSubagents, ...registrySubagents]
  const runModTask: ModTaskExecution | undefined =
    modRuntimeAuthority && modManager
      ? (input, run) => {
          const execution = currentFunctionExecution()
          const parent = execution ? execution.runtimeAuthority : modRuntimeAuthority
          if (!parent) throw new ModError("MODS_TOOL_AGENT_UNAVAILABLE")
          const access = input.subagentType ? modAgentAccess.get(input.subagentType) : undefined
          return modManager.withSharedAgent(
            parent,
            input.agentId,
            input.signal,
            access,
            () =>
              readOnlyShellExecutionContext.run(
                readOnlyShellExecutionContext.getStore() === true || access?.readOnly === true,
                run
              ),
            modTurnRunId
          )
        }
      : undefined
  // Task-tool subagents have role-specific prompts and do not inherit the main
  // BASE_SYSTEM_PROMPT. Apply the shared completion/repetition contract at the
  // common exit so general-purpose, registry, and custom string-prompt agents
  // receive the same guidance exactly once. Opaque Runnable agents own their
  // prompt assembly and cannot be safely rewritten here.
  const availableSubagents = unresolvedSubagents.map((subagent) => {
    if (
      Runnable.isRunnable(subagent) ||
      !subagent ||
      typeof subagent !== "object" ||
      typeof subagent.systemPrompt !== "string"
    ) {
      return subagent
    }
    return {
      ...subagent,
      systemPrompt: appendTaskCompletionAndRepetitionPrompt(subagent.systemPrompt),
      ...(toolStrategy !== "standard" && !("runnable" in subagent)
        ? {
            middleware: [
              ...(subagent.middleware ?? []),
              // Per-role tail: the shared filesystem tools are never mutated,
              // and the guard has already removed unavailable tools by this point.
              createToolStrategyTurnReminderMiddleware(
                toolStrategy,
                modAgentAccess.get(subagent.name)?.readOnly
                  ? { ...filesystemAccess, shellAccess: "read_only" }
                  : filesystemAccess
              )
            ]
          }
        : {})
    }
  })

  // Capture each known graph's own tool sources before its first model request.
  // The execution binding below still owns filtering and the child's private lifetime.
  for (const subagent of availableSubagents) {
    const access = modAgentAccess.get(subagent?.name)
    if (!access) continue
    access.tools = collectRuntimeToolCatalog(subagent.tools ?? subagentDefaultTools ?? tools, [
      ...subagentMiddleware,
      ...(subagent.middleware ?? [])
    ])
  }

  if (mainSubagentsEnabled && onTaskSubagentPromptsResolved) {
    onTaskSubagentPromptsResolved(
      availableSubagents.flatMap((subagent) =>
        subagent &&
        typeof subagent === "object" &&
        "name" in subagent &&
        typeof subagent.name === "string" &&
        "systemPrompt" in subagent &&
        typeof subagent.systemPrompt === "string"
          ? [{ name: subagent.name, systemPrompt: subagent.systemPrompt }]
          : []
      )
    )
  }

  // deepagents' fs middleware RE-APPENDS its own `## Execute Tool` section in
  // wrapModelCall whenever the BACKEND supports execution (our LocalSandbox
  // always does), and that runs AFTER createFsMiddleware already cleaned the
  // injected filesystemSystemPrompt. So for a restricted runtime whose execute
  // tool is actually removed (shellAccess "none" registry agent, scoped write
  // worker), the re-appended doc would survive and advertise a tool the model
  // doesn't have. Run a SECOND strip placed NEXT in the chain (→ inner, so it
  // observes the appended section) keyed on the SAME access policy: it drops
  // `## Execute Tool` only when execute is in the blocked set, so
  // read_only/verify/full (which KEEP execute, command-gated) are untouched. The
  // Registry task path already gets this via createAgentToolGuardMiddleware; this
  // covers the Level-1 workflow-leaf + coordinator-worker (filesystemAccess)
  // path, which has no such guard.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let postFsToolDocStripMiddleware: any[] = []
  if (mainFilesystemEnabled && filesystemAccess) {
    const postFsBlocked = blockedToolNamesForAccess(filesystemAccess)
    postFsToolDocStripMiddleware = [
      createMiddleware({
        name: "postFsToolDocStrip",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wrapModelCall: (request: any, handler: any) =>
          handler({
            ...request,
            systemMessage: stripBlockedToolDocs(request.systemMessage, postFsBlocked)
          })
      })
    ]
  }
  const mainToolDenylistMiddleware =
    mainBlockedToolNames.length > 0
      ? [createRuntimeToolDenylistMiddleware(mainBlockedToolNames)]
      : []
  const systemPromptPreviewCaptureMiddleware =
    threadId && typeof threadId === "string"
      ? [
          createMiddleware({
            name: "systemPromptPreviewCapture",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            wrapModelCall: (request: any, handler: any) => {
              setCapturedSystemPromptPreview({
                threadId,
                prompt: stringifySystemPromptForPreview(request.systemMessage),
                updatedAt: Date.now()
              })
              return handler(request)
            }
          })
        ]
      : []
  const outputStyleTurnReminderMiddleware = outputStylePrompt
    ? [createOutputStyleTurnReminderMiddleware(effectiveOutputStyle)]
    : []

  const agentOptions = {
    model,
    systemPrompt: finalSystemPrompt,
    tools,
    middleware: [
      // FIRST (outermost wrapToolCall): reject recovered-malformed calls before
      // ANY tool lifecycle — PreToolUse hooks must not block/rewrite them (that
      // would replace the diagnosis with a misleading message), and the fuse/
      // task-mmd must not observe a tool that never runs. Mirrors Claude Code's
      // validate-before-permissions order.
      createMalformedToolCallGuardMiddleware(),
      ...outerMiddleware,
      ...(loopGuardsEnabled
        ? [
            // Grok-style action-stationarity guard: observe the complete normalized
            // tool-call batch, nudge after 8 identical calls, and halt after 16.
            // Separate instances are used for the main graph and task-subagent stack;
            // the middleware isolates shared task subagents by their stamped owner id.
            createActionStationarityMiddleware({
              turnId: actionStationarityTurnId,
              ownerConfigKey: SUBAGENT_OWNER_METADATA_KEY
            })
          ]
        : []),
      ...(threadId ? [createTrustedToolFilePreviewContextMiddleware(threadId)] : []),
      ...(mainTodosEnabled ? [todoListMiddleware()] : []),
      ...(mainFilesystemEnabled ? [createFsMiddleware("\n", mainToolStrategy)] : []),
      ...postFsToolDocStripMiddleware,
      // The filesystem middleware appends execute documentation dynamically;
      // run the transport denylist after it so the docs and tool disappear
      // together.
      ...mainToolDenylistMiddleware,
      ...(threadId ? [createTaskMmdMiddleware({ threadId, scope: "main" })] : []),
      createSkillHookContextMiddleware(filesystemBackend),
      gradedToolConcurrencyMiddleware,
      ...(toolHookMiddleware ? [toolHookMiddleware] : []),
      toolErrorMiddleware,
      ...(mainSubagentsEnabled
        ? [
            stampSubagentOwnerMetadata(
              createSubAgentMiddleware({
                defaultModel: model,
                defaultTools: subagentDefaultTools ?? tools,
                defaultMiddleware: subagentMiddleware,
                defaultInterruptOn: null,
                subagents: metadataOnly
                  ? availableSubagents.map((subagent) => ({
                      name: subagent.name,
                      description: subagent.description,
                      runnable: RunnableLambda.from(() => {
                        throw new ModError("MODS_TOOL_METADATA_ONLY")
                      })
                    }))
                  : availableSubagents,
                generalPurposeAgent: false,
                systemPrompt: taskSystemPrompt
              } as Parameters<typeof createSubAgentMiddleware>[0]),
              soloTaskTraceManager,
              threadId,
              runModTask
            )
          ]
        : []),
      // Refuse to END the turn on an invalid final message (empty reply after a
      // tool result, a length-truncated answer, a tool call the provider never
      // structured, a stream that EOF'd without a terminal event) or with the
      // model's own todo list still open. Placed immediately BEFORE the steer
      // queue: afterModel runs in REVERSE array order, so a message the user
      // typed into the running turn is injected first and outranks any recovery
      // prompt this gate would add. See turn-completion-integrity.ts.
      createTurnCompletionGateMiddleware({
        ownerRunToken: turnCompletionOwnerToken ?? currentRunMessageQueueOwnerToken,
        checkpointed: turnCompletionCheckpointed,
        observationRunToken: modTurnRunId,
        todoGateEnabled: mainTodosEnabled && turnCompletionTodoGateEnabled,
        onRecovery: onTurnCompletionRecovery
      }),
      // Inject user messages steered into the running turn. Placed BEFORE
      // summarization (injected turns should participate in context management)
      // and BEFORE humanInTheLoop (a steered message must never race a pending
      // tool-approval interrupt). See createCurrentRunMessageQueueMiddleware.
      createCurrentRunMessageQueueMiddleware(
        currentRunMessageQueueOwnerToken,
        currentRunDurableQueue
      ),
      mainSummarizationController.middleware,
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
      // Recover from malformed/truncated tool-call JSON (deepseek et al.): promote
      // invalid_tool_calls into normalized tool_calls (the guard middleware above
      // rejects them with a cause-targeted error before the tool runs), and strip
      // any already-poisoned raw tool call from the outgoing request so the
      // OpenAI-compatible API can't 400. Complementary to patchToolCalls below
      // (which only pairs NORMALIZED dangling calls).
      createMalformedToolCallRecoveryMiddleware(),
      createPatchToolCallsMiddleware(),
      ...skillsMiddlewareArray,
      ...memoryMiddlewareArray,
      ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
      ...customMiddleware,
      ...outputStyleTurnReminderMiddleware,
      ...(toolStrategy !== "standard"
        ? [createToolStrategyTurnReminderMiddleware(toolStrategy, filesystemAccess)]
        : []),
      ...systemPromptPreviewCaptureMiddleware,
      ...(!metadataOnly &&
      modRuntimeAuthority?.agentId === "main" &&
      typeof modSessionModel === "string" &&
      modManager?.isActive(modRuntimeAuthority.workspace)
        ? [
            createFunctionSessionViewMiddleware(
              modManager,
              modRuntimeAuthority,
              modSessionModel,
              modTurnRunId,
              summarizationMaxInputTokens,
              modSessionCompact
                ? (instructions, messages, state, signal) =>
                    modSessionCompact(
                      mainSummarizationController,
                      instructions,
                      messages,
                      state,
                      signal
                    )
                : undefined
            )
          ]
        : [])
    ],
    ...(responseFormat != null && { responseFormat }),
    contextSchema,
    checkpointer,
    store,
    name
  }
  if (metadataOnly) return collectRuntimeToolCatalog(agentOptions.tools, agentOptions.middleware)
  const agent = createAgent(agentOptions as unknown as Parameters<typeof createAgent>[0])
  if (modRuntimeAuthority && modManager?.isActive(modRuntimeAuthority.workspace)) {
    modManager.bindFunctionToolCatalog(
      {
        ...modRuntimeAuthority,
        runtimeAuthority: modRuntimeAuthority,
        blockedToolNames: new Set(mainBlockedToolNames)
      },
      collectRuntimeToolCatalog(agentOptions.tools, agentOptions.middleware)
    )
  }
  return agent
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DeepAgent = ReactAgent<any>
