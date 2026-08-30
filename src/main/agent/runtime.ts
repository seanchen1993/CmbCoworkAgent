/* eslint-disable @typescript-eslint/no-unused-vars */
// Runtime: agent lifecycle and middleware orchestration
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createSkillsMiddleware,
  createMemoryMiddleware,
  GENERAL_PURPOSE_SUBAGENT,
  StateBackend
} from "deepagents"
import {
  getThreadCheckpointPath,
  deleteThreadCheckpoint,
  getEnabledSkillsSources,
  getEnabledSkillMiddlewareSources,
  getUserInfo,
  getSkillEvolutionThreshold as getStoredSkillEvolutionThreshold,
  getSkillEvolutionTurnThreshold as getStoredSkillEvolutionTurnThreshold,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOP_P,
  DEFAULT_TOP_K,
  DEFAULT_THINKING_EFFORT,
  getEnabledPluginSkillSourceMetadata,
  getEnabledPluginSkillMiddlewareSources,
  getPlugins,
  getDisabledSkillDirs,
  getGlobalRoutingMode
} from "../storage"
import { getAvailableModelConfigOrDefault, getModelConfigByRef } from "../models/registry"
import { createCmbSummarizationMiddleware } from "./context-summarization-middleware"
import { getProjectThreadDataDirectory } from "./context-history-path"

import { ChatOpenAI, ChatOpenAICompletions } from "@langchain/openai"
import { DynamicStructuredTool, ToolInputParsingException, tool } from "@langchain/core/tools"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import {
  LocalSandbox,
  agentFileWriteContext,
  readOnlyShellExecutionContext,
  type SkillHookContextProvider
} from "./local-sandbox"
import { approvalMatchesRuntimeThread } from "./approval-thread-match"
import { SkillLifecycleRegistry } from "./skill-lifecycle/registry"
import { combineSkillMiddlewareSources } from "./skill-sources"
import type { SkillUseTracker } from "./skill-lifecycle/tracker"
import type { AgentFileMutationKind } from "../services/agent-auto-commit"
import type { HookResultCallback } from "../hooks/runner"
import type { HookResult } from "../hooks/types"
import type {
  HarnessAgentmdLoadStatusItem,
  HarnessDeployUnitMapping,
  HarnessProjectModeSubagentConfig,
  HarnessRequestUserInputConfig
} from "../../shared/harness-board-types"
import {
  calculateModelInputBudgetTokens,
  calculateSummarizationKeepTokens,
  calculateSummarizationTriggerTokens
} from "../../shared/model-token-budget"
import {
  getAgentGraphRecursionLimit,
  getWorkflowWorktreeTimeoutMs
} from "../../shared/agent-runtime-limits"
import {
  DEFAULT_AGENT_OUTPUT_STYLE,
  resolveAgentOutputStyle,
  type AgentOutputStyle
} from "../../shared/agent-output-style"
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
import { Runnable } from "@langchain/core/runnables"
import { Command, isGraphBubbleUp } from "@langchain/langgraph"
import { z } from "zod"

import type * as _lcTypes from "langchain"
import type * as _lcMessages from "@langchain/core/messages"
import type * as _lcLanggraph from "@langchain/langgraph"
import type * as _lcZodTypes from "@langchain/core/utils/types"

import path from "path"
import { join, resolve, delimiter } from "path"
import { createWriteStream, createReadStream } from "fs"
import fs from "fs/promises"
import { createGunzip } from "zlib"
import { pipeline } from "stream/promises"
import { app, BrowserWindow } from "electron"
import {
  getOutputStylePrompt,
  getOutputStyleTurnReminder,
  MEMORY_SYSTEM_PROMPT,
  OUTPUT_STYLE_IDENTITY_PROMPT,
  renderBaseSystemPrompt,
  renderInjectedToolUsagePrompt,
  renderAvailableDeferredToolsPrompt
} from "./system-prompt"
import { getMemoryStore, closeMemoryStore } from "../memory/store"
import { createMemorySearchTool, createMemoryGetTool } from "../memory/tools"
import { resolveWorkspaceMemoryDirs } from "../memory/paths"
import { createSchedulerTool } from "./tools/scheduler-tool"
import { createSkillEvolutionTool } from "./tools/skill-evolution-tool"
import {
  flushStrict,
  getThread,
  getThreadMessages,
  moveThreadMessagesAfterAnchor,
  moveThreadMessagesAfterLastNonAssistant,
  replaceThreadMessageId,
  upsertThreadMessages
} from "../db/index"
import { createRequestUserInputTool } from "./tools/user-input-tool"
import { createToolSearchTools } from "./tools/tool-search-tool"
import { createCodeExecTool } from "./tools/code-exec-tool"
import { createTaskMmdMiddleware } from "./task-mmd/middleware"
import { createToolHookMiddleware } from "./tool-hooks"
import { listSavedCodeExecTools } from "../code-exec/saved-tool-store"
import {
  getWindowsSandboxMode,
  getYoloMode,
  getEnabledHooks,
  isCodeExecEnabled,
  getLspConfig,
  isThreadMemoryEnabled
} from "../storage"
import { runHooks, type HookContext } from "../hooks/runner"
import type { HookEvent } from "../hooks/types"
import { runHooksEnriched } from "../hooks/required-skill"
import { isHookHaltError, throwIfHookHalt } from "../hooks/halt"
import {
  hasFailureFired,
  markFailureFired,
  toolFailureSignalFromThrow,
  type ToolFailureSignal
} from "../hooks/tool-failure"
import {
  formatFailureFuseWarning,
  getFailureFuseMode,
  isFailureFuseHaltError,
  recordToolFailure,
  recordToolSuccess,
  shouldAttachFailureFuseFeedback,
  shouldSendFailureFuseNotice,
  throwIfFailureFuseHalt,
  type FailureFuseDecision,
  type FailureFuseNoticeCallback
} from "./failure-fuse"
import { mergeUpdatedInput } from "../hooks/updated-input"
import {
  createHookScope,
  createInheritedHookScope,
  resolvePluginIdForSkillPath,
  extractPluginIdFromProviderKey,
  resolveEnabledHooksForRun,
  type ScopeSkipCallback,
  type HookScopeController
} from "../hooks/scope"
import { ApprovalStore } from "./approval-store"
import {
  assertCurrentRunMessagesDurablyPersisted,
  createCurrentRunMessageQueueMiddleware,
  isCurrentRunMessageQueueOwner,
  registerCurrentRunCompletedAssistantRoute,
  resolveCurrentRunCompletedAssistantIdentity,
  resolveCurrentRunInjectionAnchorId,
  setCurrentRunInjectionNotifier
} from "./current-run-message-queue"
// Re-exported so existing importers (ipc/agent.ts) keep resolving these from
// runtime; the implementation now lives in the electron-free queue module.
export {
  clearCurrentRunMessageQueue,
  deleteCurrentRunQueuedMessage,
  getCurrentRunInjectedMessageIds,
  isCurrentRunMessageQueueOwner,
  isCurrentRunMessageWithdrawn,
  peekCurrentRunMessageQueue,
  queueCurrentRunMessage,
  routeCurrentRunCompletedAssistantMessage,
  setCurrentRunMessageQueueOwner
} from "./current-run-message-queue"
export type { CurrentRunQueuedMessage } from "./current-run-message-queue"

let flushTranscriptBeforeCurrentRunInjection:
  | ((threadId: string, runToken: string) => void)
  | null = null

export function setCurrentRunTranscriptFlushBeforeInjection(
  flush: (threadId: string, runToken: string) => void
): void {
  flushTranscriptBeforeCurrentRunInjection = flush
}
import { ToolOrchestrator } from "./tool-orchestrator"
import { classifyCommandConcurrency, isReadOnlyShellCommand } from "./exec-policy"
import type { WindowsShellKind } from "./windows-safe-commands"
import { readOnlyExecuteBlockMessage } from "./read-only-shell-message"
import { SkillUsageDetector } from "./skill-evolution/usage-detector"
import type { ApprovalRequest, ApprovalDecision, Message } from "../types"
import { emitAppAttention } from "../app-attention-events"
import {
  isTraceReasoningTruncated,
  mergeStreamingReasoning,
  truncateReasoningForTrace
} from "../../shared/model-reasoning"
import type { ContextCompactionLifecycleCallback } from "../../shared/context-compaction-events"
import { configureContextCompactionModel } from "./context-compaction"
import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../mcp/capability-types"
import { buildAliasMaps, buildScopedToolAliases } from "../mcp/aliasing"
import {
  closeGlobalMcpCapabilityService,
  getGlobalMcpCapabilityService
} from "../mcp/capability-service"
import { createEagerMcpTool } from "../mcp/langchain-tool"
import {
  autoSelectPlaywrightInAppBrowserTab,
  invokeMcpToolWithPlaywrightInAppBrowserSupport
} from "../browser/cdp/playwright-mcp-bridge"
import {
  InterleavedThinkingChatOpenAICompletions,
  ReasoningDisplayChatOpenAICompletions
} from "./interleaved-thinking-completions"
import {
  createMalformedToolCallGuardMiddleware,
  createMalformedToolCallRecoveryMiddleware
} from "./malformed-tool-call-recovery"
import {
  areAgentLoopGuardsEnabled,
  clearActionStationarityTurn,
  createActionStationarityMiddleware,
  getActionStationarityHaltError
} from "./action-stationarity"
import { createLspTool } from "./tools/lsp-tool"
import { detectJavaProject } from "../lsp"
import {
  buildAgentsPromptLoadStatusItems,
  DEFAULT_AGENTS_MAX_BYTES,
  DEFAULT_GLOBAL_AGENTS_MAX_BYTES,
  loadAgentsPromptForWorkspaces,
  loadAgentsPromptForWorkspace,
  type AgentsPromptRuntimeResult
} from "./agents-md"
import {
  buildCoordinatorSystemPrompt,
  buildCoordinatorTaskPrompt,
  buildCoordinatorWorkerSubagents,
  createCoordinatorWorkerTools,
  getCoordinatorScratchpadDir,
  injectSelectedSkillIntoWorkerPrompt,
  type AgentMode,
  type CoordinatorSelectedSkill,
  type CoordinatorWorkerTurnPlanningState
} from "./coordinator-mode"
import {
  coordinatorWorkerManager,
  type CoordinatorWorkerSnapshot,
  type CoordinatorWorkerContinuationIntent,
  type CoordinatorWorkerUpdateEvent,
  type CoordinatorWorkerRole,
  type CoordinatorWorkerRunner,
  type CoordinatorWorkerTokenUsage,
  type CoordinatorWorkerWorkload
} from "./coordinator-worker-manager"
import {
  applyCoordinatorWorkerFilesystemAccess,
  filterCoordinatorWorkerFinalTools,
  isExplicitToolAccess,
  blockedToolNamesForAccess,
  registryAgentBlockedTools,
  type CoordinatorWorkerFilesystemAccess
} from "./coordinator-worker-access"
import {
  isGeneralPurposeSubagentEnabled,
  loadAgentProfiles,
  stripBlockedToolDocs,
  stripCustomModelPrefix,
  type AgentShellAccess
} from "./agent-registry"
import {
  createWorkerValuesSnapshotContext,
  extractWorkerFinalText,
  extractWorkerVisibleReasoning,
  extractWorkerUsage,
  isWorkerFinalTextDelta,
  observeSkillUsageFromStream,
  shouldClearWorkerFinalText,
  observeWorkerProgress,
  summarizeWorkerText,
  type WorkerValuesSnapshotContext
} from "./coordinator-worker-stream"
import { setAdoptionContext } from "../services/adoption-tracker"
import { buildOrderedChain, isRetryableApiError } from "./failover"
import { resolveModel } from "../routing"
import { patchRuntimeReadFileTool } from "./read-file-tool"
import { createWorkflowTool } from "./workflow/tool"
import { workflowRunManager } from "./workflow/run-manager"
import { WORKFLOW_MODE_SYSTEM_PROMPT } from "./workflow/prompts"
import {
  PROJECT_MODE_MEMORY_ENV,
  isMemoryAllowedForProjectMode,
  isProjectModeMemoryEnabled
} from "../project-mode-memory"
import {
  isWorkflowStructuredOutputFatalError,
  type WorkflowSubagentRuntime
} from "./workflow/subagent"
import {
  isWorkflowSubagentThreadOf,
  type WorkflowWorktreeIsolationBoundary
} from "./workflow/types"
import {
  createTraceCollectorSafely,
  finishTraceInBackground,
  runTraceSideEffect,
  type TraceCollector
} from "./trace/collector"
import { SOLO_TASK_OWNER_METADATA_KEY, type SoloTaskTraceManager } from "./trace/solo-task"
import type { TraceContext, TraceOutcome } from "./trace/types"

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === "AbortError" || (error as { code?: unknown }).code === "ABORT_ERR"
}

function describeToolError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Error"
  if (typeof error === "string" && error) return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** Decompress codex.exe.gz → codex.exe if needed (re-extract if .gz is newer than .exe). */
async function ensureCodexExe(exePath: string): Promise<void> {
  const gzPath = exePath + ".gz"
  const gzStat = await fs.stat(gzPath).catch(() => null)
  if (!gzStat) return
  const exeStat = await fs.stat(exePath).catch(() => null)
  if (exeStat) {
    // Skip if exe is up-to-date (gz not newer)
    if (exeStat.mtimeMs >= gzStat.mtimeMs) return
    // gz is newer — remove stale exe before re-extracting
    await fs.unlink(exePath).catch(() => {})
  }
  try {
    await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(exePath))
    console.log("[Runtime] codex.exe extracted from .gz")
  } catch (e) {
    console.error("[Runtime] Failed to extract codex.exe:", e)
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

// ── Pending Approvals (shared between orchestrator and IPC) ──

/** Map of pending approval promises keyed by request ID. */
export const pendingApprovals = new Map<
  string,
  {
    resolve: (decision: ApprovalDecision) => void
    request: ApprovalRequest
    /** Approval-ROUTING thread (where the UI prompt surfaces). For a workflow
     * subagent this is the PARENT thread, not the subagent's own thread. */
    threadId: string
    /** The runtime's OWN thread id. For a workflow subagent this is
     * `<parent>__wf_<run>_a<i>` (differs from threadId/the parent). Used to detect
     * which workflow run is blocked on an approval — see hasPendingWorkflowApproval. */
    runtimeThreadId: string
    targetWebContentsIds: number[]
  }
>()

/**
 * True when any workflow subagent of `parentThreadId` is currently blocked on a
 * pending approval. Subagent runtime threads are `<parent>__wf_<run>_a<i>`, so we
 * match on runtimeThreadId (NOT threadId, which is the parent approval-routing id
 * and would also match the parent's own non-workflow approvals). The engine's
 * inactivity watchdog uses this to NOT abort a run that is merely waiting for an
 * absent user to answer an approval prompt.
 *
 * `runId` scopes the check to ONE run so two concurrent runs on the same parent
 * thread don't share an "awaiting approval" state (one's pending prompt would
 * otherwise suppress the other's hung-run watchdog).
 */
export function hasPendingWorkflowApproval(parentThreadId: string, runId?: string): boolean {
  for (const approval of pendingApprovals.values()) {
    if (isWorkflowSubagentThreadOf(approval.runtimeThreadId, parentThreadId, runId)) return true
  }
  return false
}

/**
 * True when the given runtime thread (or a nested child of it, delimiter-fenced
 * so `w1` cannot match `w10`) is blocked on a pending user approval. The
 * coordinator worker manager's inactivity watchdog uses this — via the probe
 * wired below, not a direct import (this module imports the manager, so the
 * manager importing back would be a cycle) — to treat an approval-blocked
 * worker as WAITING rather than hung, mirroring hasPendingWorkflowApproval's
 * role for the workflow engine watchdog.
 */
export function hasPendingApprovalForRuntimeThread(runtimeThreadId: string): boolean {
  for (const approval of pendingApprovals.values()) {
    if (approvalMatchesRuntimeThread(approval.runtimeThreadId, runtimeThreadId)) {
      return true
    }
  }
  return false
}

coordinatorWorkerManager.setWorkerApprovalProbe(hasPendingApprovalForRuntimeThread)

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

type RuntimePromptToolPolicy = {
  isProjectMode: boolean
  includeCurrentTime: boolean
  includeTimestampRule: boolean
  includeMemory: boolean
  includeCodeExecRoute: boolean
  includeSavedCodeExecTools: boolean
  includeInjectedToolUsagePrompt: boolean
  includeDeferredToolInventoryPrompt: boolean
}

function createRuntimePromptToolPolicy(input: {
  featureId?: string
  isHarnessProjectSession?: boolean
  agentMode: AgentMode
  memoryEnabled: boolean
}): RuntimePromptToolPolicy {
  const isProjectMode = Boolean(input.featureId) || input.isHarnessProjectSession === true
  return {
    isProjectMode,
    includeCurrentTime: !isProjectMode,
    includeTimestampRule: !isProjectMode,
    includeMemory: input.memoryEnabled && isMemoryAllowedForProjectMode(input.featureId),
    includeCodeExecRoute: !isProjectMode && input.agentMode !== "coordinator",
    includeSavedCodeExecTools: true,
    includeInjectedToolUsagePrompt: true,
    includeDeferredToolInventoryPrompt: true
  }
}

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
  toolCall: { name?: string; args?: unknown } | undefined
): boolean {
  // A second workflow launch while one is already active should fail fast with the
  // workflow tool's own active-run error. If we wait for the exclusive tool lock
  // first, a long-running workflow subagent command can delay that user-facing
  // rejection until the command finishes.
  return toolCall?.name === "workflow" && workflowRunManager.isActive(queueId)
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

function getToolConcurrencyLock(queueId: string): AsyncRWLock {
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

function createGradedToolConcurrencyMiddleware(queueId: string) {
  const lock = getToolConcurrencyLock(queueId)
  const taskLimiter = getTaskConcurrencyLimiter(queueId)
  return createMiddleware({
    name: "gradedToolConcurrency",
    wrapToolCall: async (request, handler) => {
      const toolCall = request.toolCall as
        | { id?: string; name?: string; args?: unknown }
        | undefined
      if (shouldFastRejectActiveWorkflow(queueId, toolCall)) {
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

// The current-run message queue (in-flight steering) lives in a dedicated,
// electron-free module (current-run-message-queue.ts) so its logic can be
// unit-tested directly. Here we only wire its injection notifier to broadcast to
// renderer windows, so each window's draft queue can reconcile the messages that
// were steered into the running turn (drop them from the queue, render them as
// committed user turns).
setCurrentRunInjectionNotifier(async (threadId, messages, context) => {
  // This strict DB flush is the durable acknowledgement boundary. The
  // renderer may remove its localStorage draft only after this succeeds; if it
  // throws, the queue middleware restores the messages for a later retry.
  if (!flushTranscriptBeforeCurrentRunInjection) {
    throw new Error("Current-run transcript flush is not registered")
  }
  // Streamed assistant/tool chunks use a deferred transcript buffer. Flush that
  // buffer first so the steered user turn receives an ordinal after every model
  // message that preceded it in the active run.
  if (!context?.runToken) {
    throw new Error("Current-run transcript flush is missing its physical run token")
  }
  flushTranscriptBeforeCurrentRunInjection(threadId, context.runToken)
  // afterModel runs before the outer stream consumer receives the final AI
  // message. Resolve and migrate the exact provider occurrence before writing
  // the completed reply so a reused raw provider id cannot overwrite history.
  // The completed reply's priority then wins over delayed chunks for that tuple.
  const completedAssistantMessage = context?.completedAssistantMessage
  const durableMessagesBeforeCompletedAssistant = getThreadMessages(threadId)
  const durableAnchorMessageId = context.anchorMessage
    ? resolveCurrentRunInjectionAnchorId(
        durableMessagesBeforeCompletedAssistant,
        context.anchorMessage
      )
    : undefined
  if (context.anchorMessage && !durableAnchorMessageId) {
    throw new Error("Cannot resolve current-run injection predecessor in durable transcript")
  }
  const completedAssistantIdentity = completedAssistantMessage
    ? resolveCurrentRunCompletedAssistantIdentity(
        durableMessagesBeforeCompletedAssistant,
        completedAssistantMessage
      )
    : undefined
  const completedAssistantObservedContent = completedAssistantIdentity?.sourceId
    ? durableMessagesBeforeCompletedAssistant.find(
        (message) =>
          message.id === completedAssistantIdentity.sourceId && message.role === "assistant"
      )?.content
    : undefined
  if (
    completedAssistantMessage &&
    completedAssistantIdentity?.sourceId &&
    completedAssistantIdentity.sourceId !== completedAssistantMessage.id &&
    !replaceThreadMessageId(
      threadId,
      completedAssistantIdentity.sourceId,
      completedAssistantMessage.id,
      "assistant"
    )
  ) {
    throw new Error("Failed to migrate the completed assistant provider occurrence")
  }
  const transcriptMessages: Message[] = [
    ...(completedAssistantMessage
      ? [
          {
            id: completedAssistantMessage.id,
            ...(completedAssistantIdentity?.providerSourceId
              ? { provider_source_id: completedAssistantIdentity.providerSourceId }
              : {}),
            ...(completedAssistantIdentity?.providerOccurrence
              ? { provider_occurrence: completedAssistantIdentity.providerOccurrence }
              : {}),
            role: "assistant" as const,
            content: completedAssistantMessage.content,
            content_priority: 1,
            created_at: new Date()
          }
        ]
      : []),
    ...messages.map((message) => ({
      id: message.id,
      role: "user" as const,
      // Keep the durable transcript aligned with the user bubble. The prepared
      // model payload remains in the checkpoint HumanMessage below, with the
      // visible alias attached for checkpoint restore/export.
      content: message.displayContent || message.content,
      created_at: new Date()
    }))
  ]
  const persistedCount = upsertThreadMessages(threadId, transcriptMessages)
  assertCurrentRunMessagesDurablyPersisted(transcriptMessages.length, persistedCount)
  const transcriptMessageIds = transcriptMessages.map((message) => message.id)
  if (durableAnchorMessageId) {
    moveThreadMessagesAfterAnchor(threadId, durableAnchorMessageId, transcriptMessageIds)
  } else {
    moveThreadMessagesAfterLastNonAssistant(threadId, transcriptMessageIds)
  }
  await flushStrict()
  // Persistence above is still valid if a replacement run took ownership while
  // fsync was in flight, but old-run stream events are not: they would append the
  // injected user turn after the replacement's optimistic bubble and reset its
  // assistant accumulator. The renderer's durable-draft reconciliation will pick
  // up the already persisted message once the replacement becomes idle.
  if (!isCurrentRunMessageQueueOwner(threadId, context.runToken)) {
    const ownershipError = new Error("Current-run injection owner changed during persistence")
    ownershipError.name = "AbortError"
    throw ownershipError
  }
  if (
    completedAssistantMessage?.sourceId &&
    completedAssistantMessage.sourceId !== completedAssistantMessage.id &&
    context?.runToken &&
    completedAssistantIdentity?.providerSourceId &&
    completedAssistantIdentity.providerOccurrence
  ) {
    registerCurrentRunCompletedAssistantRoute(threadId, context.runToken, {
      rawSourceId: completedAssistantMessage.sourceId,
      stableId: completedAssistantMessage.id,
      providerSourceId: completedAssistantIdentity.providerSourceId,
      providerOccurrence: completedAssistantIdentity.providerOccurrence,
      content: completedAssistantMessage.content,
      ...(completedAssistantObservedContent !== undefined
        ? { observedContent: completedAssistantObservedContent }
        : {})
    })
  }
  const assistantIdAlias =
    completedAssistantMessage &&
    completedAssistantIdentity?.sourceId &&
    completedAssistantIdentity.sourceId !== completedAssistantMessage.id
      ? {
          sourceId: completedAssistantIdentity.sourceId,
          id: completedAssistantMessage.id
        }
      : undefined
  const payload = {
    messages: messages.map((message) => ({
      id: message.id,
      content: message.displayContent || message.content
    })),
    ...(assistantIdAlias
      ? {
          assistantIdAlias
        }
      : {})
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      // The coordinator can have already streamed the provider id to the UI
      // before afterModel assigns a stable id for the durable transcript. Reuse
      // the normal stream alias event so the existing live bubble is renamed,
      // rather than rendering the stable values snapshot as a second reply.
      if (assistantIdAlias) {
        win.webContents.send(`agent:stream:${threadId}`, {
          type: "custom",
          data: {
            type: "message_id_alias",
            fromId: assistantIdAlias.sourceId,
            toId: assistantIdAlias.id,
            role: "assistant",
            currentRunCompleted: true,
            providerSourceId: completedAssistantIdentity?.providerSourceId,
            providerOccurrence: completedAssistantIdentity?.providerOccurrence
          }
        })
      }
      // Guided input starts a new user/assistant boundary inside the same run.
      // Reset the renderer's live assistant accumulator before the model is
      // invoked again so coordinator output cannot append to the prior reply.
      win.webContents.send(`agent:stream:${threadId}`, {
        type: "custom",
        data: {
          type: "current_run_user_injected",
          ...(completedAssistantMessage
            ? {
                completedAssistantId: completedAssistantMessage.id,
                completedAssistantContent: completedAssistantMessage.content,
                completedAssistantProviderIdless: !completedAssistantMessage.sourceId
              }
            : {}),
          messages: payload.messages
        }
      })
      win.webContents.send(`agent:queueInjected:${threadId}`, payload)
    } catch (error) {
      // Persistence is the acknowledgement boundary. A renderer can disappear
      // after the durable write (reload/window close); notification failure must
      // not restore the queue and prevent the model from receiving the message.
      console.warn("[Runtime] Failed to notify renderer about injected messages:", error)
    }
  }
  return completedAssistantIdentity ? { completedAssistantIdentity } : undefined
})

const BASE_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools."

export interface CapturedSystemPromptPreview {
  threadId: string
  prompt: string
  updatedAt: number
}

const systemPromptPreviewByThread = new Map<string, CapturedSystemPromptPreview>()
const MAX_SYSTEM_PROMPT_PREVIEW_ENTRIES = 10

function setCapturedSystemPromptPreview(preview: CapturedSystemPromptPreview): void {
  systemPromptPreviewByThread.delete(preview.threadId)
  systemPromptPreviewByThread.set(preview.threadId, preview)

  while (systemPromptPreviewByThread.size > MAX_SYSTEM_PROMPT_PREVIEW_ENTRIES) {
    const oldestThreadId = systemPromptPreviewByThread.keys().next().value
    if (!oldestThreadId) break
    systemPromptPreviewByThread.delete(oldestThreadId)
  }
}

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

export function getCapturedSystemPromptPreview(
  threadId: string
): CapturedSystemPromptPreview | null {
  return systemPromptPreviewByThread.get(threadId) ?? null
}

export { calculateSummarizationTriggerTokens }
export const CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS = 20_000
// Used only after the summary request itself reports context overflow. Normal compaction
// sends the complete old history so user intent is not discarded before summarization.
const SUMMARY_OVERFLOW_RETRY_TARGET_RATIO = 0.65
const SUMMARY_OVERFLOW_RETRY_TOKEN_CAP = 700_000

export function calculateSummaryOverflowRetryTargetTokens(
  contextWindowTokens: number,
  summaryMaxOutputTokens: number
): number {
  return Math.min(
    SUMMARY_OVERFLOW_RETRY_TOKEN_CAP,
    Math.floor(contextWindowTokens * SUMMARY_OVERFLOW_RETRY_TARGET_RATIO),
    calculateModelInputBudgetTokens(contextWindowTokens, summaryMaxOutputTokens)
  )
}

const CMB_COWORK_SUMMARY_PROMPT = `Create a compact continuation handoff from the structured conversation messages above. The next agent must be able to continue without redoing completed work.

Use these exact headings:
## Goal
## Constraints
## Completed
## Current State
## Blockers
## Key Decisions
## Next Step
## Critical Evidence

Use concise, high-information bullets. Preserve exact user corrections, file paths, symbols, commands, test results, errors, identifiers, configuration values, Git state, and unresolved decisions when they matter. Explicitly preserve unresolved contradictions between user requirements, current source code, tests, compiled artifacts, workflow reports, and claimed verification results. Do not let a later conclusion hide conflicting evidence. Treat any <previous-summary> as authoritative context: retain facts that are still true, update changed facts, and remove stale facts. If the latest request is complete, say so under Next Step instead of inventing work. Preserve the user's language for user-facing details. Do not include private reasoning, generic narrative, a verbatim transcript, or full code unless exact code is essential.`

function createEagerMcpTools(
  capabilityService: McpCapabilityService,
  tools: McpCapabilityTool[],
  context: { workspacePath: string; threadId?: string }
): DynamicStructuredTool[] {
  return tools.map((tool) =>
    createEagerMcpTool(
      {
        listTools: capabilityService.listTools.bind(capabilityService),
        getSnapshot: capabilityService.getSnapshot?.bind(capabilityService),
        getTool: capabilityService.getTool.bind(capabilityService),
        invoke: async (_idOrAlias, args) =>
          invokeMcpToolWithPlaywrightInAppBrowserSupport({
            tool,
            workspacePath: context.workspacePath,
            threadId: context.threadId,
            args,
            invoke: () => capabilityService.invoke(tool.capabilityId, args)
          }),
        invalidate: capabilityService.invalidate.bind(capabilityService),
        close: capabilityService.close.bind(capabilityService)
      },
      tool
    )
  )
}

export function isRetryableMcpTransportError(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined
  const code = typeof record?.code === "string" ? record.code.toUpperCase() : ""
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "EPIPE"
    ].includes(code)
  ) {
    return true
  }

  const status =
    typeof record?.status === "number"
      ? record.status
      : typeof record?.statusCode === "number"
        ? record.statusCode
        : undefined
  if (status === 502 || status === 503 || status === 504) return true

  const message = error instanceof Error ? error.message : ""
  return (
    /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE)\b/i.test(
      message
    ) ||
    /\b(?:502|503|504)\b/.test(message) ||
    /\b(?:timeout|timed?\s+out)\b/i.test(message) ||
    /\b(?:terminated|disconnected)\b/i.test(message) ||
    /\bservice\s+unavailable\b/i.test(message)
  )
}

export function createScopedMcpCapabilityService(
  service: McpCapabilityService,
  hookScope: HookScopeController,
  resolveHooksForContext: (
    event: HookEvent,
    context: HookContext
  ) => ReturnType<typeof resolveEnabledHooksForRun>,
  onHookResult: HookResultCallback | undefined,
  onFailureFuseNotice: FailureFuseNoticeCallback | undefined,
  baseContext: {
    workspacePath: string
    threadId: string
    agentId?: string
    turnId?: string
    pluginOutputDir?: string
    systemId?: string
    pluginWorkspace?: string
    featureId?: string
    harnessProjectId?: string
    harnessAdapterName?: string
    harnessAdapterVersion?: string
    harnessNodeName?: string
    harnessNodeStatus?: string
    projectCode?: string
    projectDir?: string
    workspaceHookCwd?: string
    forceSyncWorkspaceHooks?: boolean
  }
): McpCapabilityService {
  const getEffectivePriority = (tool: McpCapabilityTool): number => {
    return tool.priority ?? (tool.sourceKind === "connector" ? 100 : 50)
  }

  let scopedSnapshotCache: {
    key: string
    tools: McpCapabilityTool[]
    maps: ReturnType<typeof buildAliasMaps>
  } | null = null
  let baseSnapshotCache: { fingerprint: string; tools: McpCapabilityTool[] } | null = null

  const getActivePluginKey = (): string => {
    return [...hookScope.activePluginIds].sort().join("\u001f")
  }

  const getBaseToolSnapshot = async (): Promise<{
    fingerprint: string
    tools: McpCapabilityTool[]
  }> => {
    if (baseSnapshotCache) {
      return { fingerprint: baseSnapshotCache.fingerprint, tools: [...baseSnapshotCache.tools] }
    }

    let snapshot: { fingerprint: string; tools: McpCapabilityTool[] }
    if (service.getSnapshot) {
      snapshot = await service.getSnapshot()
    } else {
      const tools = await service.listTools()
      snapshot = {
        fingerprint: tools
          .map((tool) => tool.capabilityId)
          .sort()
          .join("\u001f"),
        tools
      }
    }
    baseSnapshotCache = { fingerprint: snapshot.fingerprint, tools: [...snapshot.tools] }
    return { fingerprint: snapshot.fingerprint, tools: [...snapshot.tools] }
  }

  const getScopedToolSnapshot = async (): Promise<{
    tools: McpCapabilityTool[]
    maps: ReturnType<typeof buildAliasMaps>
  }> => {
    const baseSnapshot = await getBaseToolSnapshot()
    const cacheKey = `${baseSnapshot.fingerprint}\u001e${getActivePluginKey()}`
    if (scopedSnapshotCache?.key === cacheKey) {
      return { tools: [...scopedSnapshotCache.tools], maps: scopedSnapshotCache.maps }
    }

    const tools = baseSnapshot.tools.map((tool) => {
      const pluginId = extractPluginIdFromProviderKey(tool.providerKey)
      const isInactiveScopedPlugin =
        tool.scope === "plugin-active" &&
        pluginId &&
        !hookScope.activePluginIds.has(pluginId.toLowerCase())
      return isInactiveScopedPlugin ? { ...tool, visibility: "lazy" as const } : tool
    })
    const scopedTools = buildScopedToolAliases(tools, getEffectivePriority)
    const maps = buildAliasMaps(scopedTools)
    scopedSnapshotCache = { key: cacheKey, tools: scopedTools, maps }
    return { tools: [...scopedTools], maps }
  }

  const resolveScopedTool = async (idOrAlias: string): Promise<McpCapabilityTool | null> => {
    const { maps } = await getScopedToolSnapshot()
    return (
      maps.capabilityById.get(idOrAlias) ??
      maps.toolIds.get(idOrAlias) ??
      maps.canonicalToolIds.get(idOrAlias) ??
      service.getTool(idOrAlias)
    )
  }

  const stableSchemaStringify = (value: unknown): string => {
    if (!value || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSchemaStringify(item)).join(",")}]`
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSchemaStringify(record[key])}`)
      .join(",")}}`
  }

  const schemasCompatible = (
    left: Record<string, unknown> | undefined,
    right: Record<string, unknown> | undefined,
    strict: boolean
  ): boolean => {
    if (!strict) return true
    return stableSchemaStringify(left ?? {}) === stableSchemaStringify(right ?? {})
  }

  const findFallbackTool = (
    tool: McpCapabilityTool,
    tools: McpCapabilityTool[]
  ): McpCapabilityTool | null => {
    if (
      !tool.fallback?.enabled ||
      tool.fallback.safeToRetry !== true ||
      tool.fallback.to !== "global"
    ) {
      return null
    }
    const strict = (tool.fallback.match ?? "toolNameAndSchema") === "toolNameAndSchema"
    return (
      tools.find(
        (candidate) =>
          candidate.sourceKind === "connector" &&
          candidate.toolName === tool.toolName &&
          schemasCompatible(tool.inputSchema, candidate.inputSchema, strict)
      ) ?? null
    )
  }

  const shouldFallbackMcpError = isRetryableMcpTransportError

  const appendFallbackNotice = (
    result: McpInvocationResult,
    fromTool: McpCapabilityTool,
    fallbackTool: McpCapabilityTool
  ) => {
    const notice = `[MCP fallback] ${fromTool.toolId} failed; used ${fallbackTool.toolId}.`
    return {
      ...result,
      capabilityId: fromTool.capabilityId,
      fallbackCapabilityId: fallbackTool.capabilityId,
      text: result.text ? `${result.text}\n\n${notice}` : notice,
      contentBlocks: result.contentBlocks
        ? [...result.contentBlocks, { type: "text", text: notice }]
        : result.contentBlocks
    }
  }

  const getPluginName = (pluginId: string): string | undefined => {
    try {
      return getPlugins().find((plugin) => plugin.id === pluginId)?.name
    } catch {
      return undefined
    }
  }

  const formatPostHookFeedback = (postResult: HookResult | null): string | null => {
    if (!postResult) return null
    const parts = [
      !postResult.suppressOutput && postResult.stdout
        ? `[Hook output]\n${postResult.stdout}`
        : undefined,
      postResult.additionalContext ? `[Hook context]\n${postResult.additionalContext}` : undefined,
      postResult.systemMessage ? `[Hook notice]\n${postResult.systemMessage}` : undefined,
      postResult.decision === "block" && postResult.reason
        ? `[Hook requested review] ${postResult.reason}`
        : undefined,
      postResult.continue === false
        ? `[Hook stopped turn] ${postResult.stopReason || postResult.reason || "PostToolUse hook stopped the turn"}`
        : undefined
    ].filter((item): item is string => Boolean(item))
    return parts.length > 0 ? parts.join("\n\n") : null
  }

  const buildMcpFailureFuseDecision = (
    tool: McpCapabilityTool,
    args: Record<string, unknown>,
    result: McpInvocationResult
  ): FailureFuseDecision | null => {
    const turnId = baseContext.turnId
    if (!turnId) return null
    if (!result.isError) {
      recordToolSuccess({
        threadId: baseContext.threadId,
        turnId,
        toolName: tool.toolId,
        toolArgs: args
      })
      return null
    }

    return recordToolFailure({
      threadId: baseContext.threadId,
      turnId,
      toolName: tool.toolId,
      toolArgs: args,
      signal: {
        kind: "explicit-error",
        message: result.text || `MCP tool ${tool.toolId} returned isError`,
        errorType: "unknown",
        isInterrupt: false,
        isTimeout: false
      },
      mode: getFailureFuseMode()
    })
  }

  return {
    listTools: async () => (await getScopedToolSnapshot()).tools,
    getSnapshot: async () => {
      const baseSnapshot = await getBaseToolSnapshot()
      const scopedSnapshot = await getScopedToolSnapshot()
      return {
        fingerprint: `${baseSnapshot.fingerprint}\u001e${getActivePluginKey()}`,
        tools: scopedSnapshot.tools
      }
    },
    getTool: resolveScopedTool,
    invoke: async (idOrAlias, args) => {
      const snapshot = await getScopedToolSnapshot()
      const tool =
        snapshot.maps.capabilityById.get(idOrAlias) ??
        snapshot.maps.toolIds.get(idOrAlias) ??
        snapshot.maps.canonicalToolIds.get(idOrAlias) ??
        (await service.getTool(idOrAlias))
      const pluginId = extractPluginIdFromProviderKey(tool?.providerKey)
      if (!tool) return service.invoke(idOrAlias, args)

      const hookContext: HookContext = {
        toolName: tool.toolId,
        toolArgs: args,
        workspacePath: baseContext.workspacePath,
        sessionId: baseContext.threadId,
        agentId: baseContext.agentId,
        turnId: baseContext.turnId,
        pluginOutputDir: baseContext.pluginOutputDir,
        systemId: baseContext.systemId,
        pluginWorkspace: baseContext.pluginWorkspace,
        featureId: baseContext.featureId,
        harnessProjectId: baseContext.harnessProjectId,
        harnessAdapterName: baseContext.harnessAdapterName,
        harnessAdapterVersion: baseContext.harnessAdapterVersion,
        harnessNodeName: baseContext.harnessNodeName,
        harnessNodeStatus: baseContext.harnessNodeStatus,
        projectCode: baseContext.projectCode,
        projectDir: baseContext.projectDir,
        workspaceHookCwd: baseContext.workspaceHookCwd,
        forceSyncWorkspaceHooks: baseContext.forceSyncWorkspaceHooks,
        pluginId,
        pluginName: pluginId ? getPluginName(pluginId) : undefined
      }
      const preHooks = resolveHooksForContext("PreToolUse", hookContext)
      const preResult = await runHooksEnriched(preHooks, "PreToolUse", hookContext, onHookResult)
      if (preResult) {
        hookScope.activatePersistentHooks(preHooks)
      }
      throwIfHookHalt(
        "PreToolUse",
        preResult,
        `MCP tool ${tool.toolId} was stopped by a PreToolUse hook`
      )
      if (preResult?.blocked || preResult?.decision === "block") {
        throw new Error(
          preResult.reason ||
            preResult.stopReason ||
            preResult.stdout ||
            preResult.stderr ||
            `MCP tool ${tool.toolId} was blocked by a hook`
        )
      }

      const effectiveArgs = mergeUpdatedInput(args, preResult?.updatedInput)

      const tabsTool =
        tool.toolName === "browser_tabs"
          ? tool
          : snapshot.tools.find(
              (candidate) =>
                candidate.providerKey === tool.providerKey && candidate.toolName === "browser_tabs"
            ) ?? null

      await autoSelectPlaywrightInAppBrowserTab({
        tool,
        tabsTool,
        capabilityService: service,
        workspacePath: baseContext.workspacePath,
        threadId: baseContext.threadId
      })

      if (pluginId) hookScope.activatePlugin(pluginId)
      const result = await invokeMcpToolWithPlaywrightInAppBrowserSupport({
        tool,
        workspacePath: baseContext.workspacePath,
        threadId: baseContext.threadId,
        args: effectiveArgs,
        prepareBeforeInvoke: false,
        invoke: async () => {
          try {
            return await service.invoke(tool.capabilityId, effectiveArgs)
          } catch (error) {
            const fallbackTool = shouldFallbackMcpError(error)
              ? findFallbackTool(tool, snapshot.tools)
              : null
            if (!fallbackTool) throw error
            return appendFallbackNotice(
              await service.invoke(fallbackTool.capabilityId, effectiveArgs),
              tool,
              fallbackTool
            )
          }
        }
      })
      const postContext: HookContext = {
        ...hookContext,
        toolArgs: effectiveArgs,
        toolResult: result.text
      }
      const postHooks = resolveHooksForContext("PostToolUse", postContext)
      const postResult = await runHooksEnriched(postHooks, "PostToolUse", postContext, onHookResult)
      if (postResult) {
        hookScope.activatePersistentHooks(postHooks)
      }
      throwIfHookHalt(
        "PostToolUse",
        postResult,
        `MCP tool ${tool.toolId} was stopped by a PostToolUse hook`
      )
      const failureFuseDecision = buildMcpFailureFuseDecision(tool, effectiveArgs, result)
      if (shouldSendFailureFuseNotice(failureFuseDecision)) {
        onFailureFuseNotice?.(failureFuseDecision)
      }
      // PR-12 follow-up — MCP tools surface failure via `result.isError` rather
      // than a throw or a `success: false` shape, so `detectToolFailure` (which
      // looks at common ad-hoc shapes) doesn't see them. Translate isError →
      // PostToolUseFailure here so OMC-style security/observability hooks see
      // MCP failures on the same channel as the rest.
      if (result.isError === true) {
        const failureContext: HookContext = {
          ...postContext,
          toolResult: JSON.stringify({
            error: result.text || `MCP tool ${tool.toolId} returned isError`,
            error_type: "unknown",
            failure_kind: "explicit-error",
            is_interrupt: false,
            is_timeout: false
          })
        }
        const failureHooks = resolveHooksForContext("PostToolUseFailure", failureContext)
        runHooksEnriched(failureHooks, "PostToolUseFailure", failureContext, onHookResult).catch(
          (e) => console.warn("[Hooks] PostToolUseFailure(MCP isError) hook error:", e)
        )
      }
      if (failureFuseDecision) throwIfFailureFuseHalt(failureFuseDecision)
      const hookFeedback = formatPostHookFeedback(postResult)
      const failureFuseFeedback = shouldAttachFailureFuseFeedback(failureFuseDecision)
        ? formatFailureFuseWarning(failureFuseDecision)
        : null
      const feedback = [hookFeedback, failureFuseFeedback].filter(Boolean).join("\n\n")
      const isError =
        result.isError || postResult?.decision === "block" || postResult?.continue === false
      return {
        ...result,
        isError,
        text: feedback ? `${result.text}\n\n${feedback}` : result.text,
        contentBlocks:
          feedback && result.contentBlocks
            ? [...result.contentBlocks, { type: "text", text: feedback }]
            : result.contentBlocks
      }
    },
    invalidate: async (reason) => {
      scopedSnapshotCache = null
      baseSnapshotCache = null
      await service.invalidate(reason)
    },
    close: async () => {
      scopedSnapshotCache = null
      baseSnapshotCache = null
      await service.close()
    }
  }
}

const TASK_TOOL_PROMPT = `## \`task\` (subagent spawner)

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
  const reminder = getOutputStyleTurnReminder(outputStyle)
  const reminderContent = reminder ? `<system-reminder>\n${reminder}\n</system-reminder>` : null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appendReminder = (content: any): any =>
    typeof content === "string"
      ? `${content}\n\n${reminderContent}`
      : [...content, { type: "text" as const, text: reminderContent }]

  return createMiddleware({
    name: "outputStyleTurnReminder",
    // Mirror Claude Code's output-style attachment normalization without
    // persisting the reminder: merge into the current user turn, or smoosh into
    // the last tool result. Never append a standalone HumanMessage after a tool
    // result — compatible models can interpret that as a fresh user turn and
    // stop the agent loop. Unexpected message shapes use an ephemeral system
    // fallback so the reminder remains model-visible without changing history.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapModelCall: (request: any, handler: any) => {
      if (!reminderContent) return handler(request)
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

export function createConciseOutputStyleTurnReminderMiddleware(): ReturnType<
  typeof createMiddleware
> {
  return createOutputStyleTurnReminderMiddleware("concise")
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
 * Tool-access guard for a Solo task subagent (registry agents with a non-default
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
        // This guards a Solo registry subagent that SHARES the main agent's
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
export function wrapTaskToolWithOwnerMetadata(
  taskTool: DynamicStructuredTool,
  soloTaskTraceManager?: SoloTaskTraceManager
): DynamicStructuredTool {
  return tool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (input: Record<string, unknown>, config: any) => {
      const invocationOwner = taskInvocationOwnerId(config)
      const ownerId = invocationOwner.explicit
      const patchedConfig = {
        ...config,
        // Only a real tool-call id may be exposed as renderer attribution.
        // The generated fallback exists solely inside configurable so an
        // id-less invocation receives its own stationarity scope without
        // pretending to be a UI task id.
        ...(ownerId
          ? {
              metadata: {
                ...(config?.metadata ?? {}),
                [SUBAGENT_OWNER_METADATA_KEY]: ownerId
              }
            }
          : {}),
        configurable: {
          ...(config?.configurable ?? {}),
          [ACTION_STATIONARITY_OWNER_CONFIG_KEY]: invocationOwner.stationarity,
          [SUBAGENT_SUMMARIZATION_OWNER_CONFIG_KEY]: invocationOwner.stationarity,
          ...(ownerId ? { [SUBAGENT_OWNER_METADATA_KEY]: ownerId } : {})
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
        const result = await taskTool.invoke(config?.toolCall ?? input, patchedConfig)
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
  soloTaskTraceManager?: SoloTaskTraceManager
): T {
  const mw = middleware as { tools?: DynamicStructuredTool[] }
  if (Array.isArray(mw.tools) && mw.tools.length > 0) {
    mw.tools = mw.tools.map((t) =>
      t?.name === "task" ? wrapTaskToolWithOwnerMetadata(t, soloTaskTraceManager) : t
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDeepAgent(params: Record<string, any> = {}): ReactAgent<any> {
  const {
    model = "claude-sonnet-4-5-20250929",
    summarizationModel = model,
    summarizationFallbackModel,
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
    trimTokensToSummarize,
    summarizationMaxInputTokens,
    summarizationPostCompactionInputBudgetTokens,
    summarizationSummaryPrompt,
    summarizationHistoryPathPrefix,
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
    registrySubagentSpecs = [],
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
    soloTaskTraceManager,
    actionStationarityTurnId,
    // PR-12 — optional callback fired-and-forgotten by toolErrorMiddleware
    // when a tool throws. Closed-over context (threadId / workspace /
    // hookScope / onHookResult) lives at the createAgentRuntime layer; this
    // adapter keeps createDeepAgent oblivious to that wiring.
    onToolFailureSignal,
    onFinalSystemPrompt,
    onFailureFuseNotice,
    outputStyle,
    conciseModeEnabled = false
  }: {
    onFinalSystemPrompt?: (prompt: string) => void
    onTaskSubagentPromptsResolved?: (prompts: Array<{ name: string; systemPrompt: string }>) => void
    onToolFailureSignal?: (input: {
      toolName: string | undefined
      toolCallId: string | undefined
      toolArgs: unknown
      signal: ToolFailureSignal
    }) => FailureFuseDecision | void
    onFailureFuseNotice?: FailureFuseNoticeCallback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any
  } = params

  const loopGuardsEnabled = areAgentLoopGuardsEnabled()

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
  // the CmbCowork summarization middleware compute them from the model profile.
  const summarizationBaseOptions = {
    backend: filesystemBackend,
    historyPathPrefix: summarizationHistoryPathPrefix ?? "/conversation_history",
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

  // Create filesystem middleware and patch upstream tool defaults/descriptions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createFsMiddleware = (fsSystemPrompt = filesystemSystemPrompt): any => {
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
      ...(effectiveFsPrompt && { systemPrompt: effectiveFsPrompt }),
      ...(toolTokenLimitBeforeEvict != null && { toolTokenLimitBeforeEvict })
    })
    markFilesystemWriteToolAsUserInitiated(mw)
    patchRuntimeReadFileTool({ middleware: mw, filesystemBackend, toolTokenLimitBeforeEvict })

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
                "Set to true to run the command in the background. Returns a task ID immediately. " +
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

  const gradedToolConcurrencyMiddleware =
    createGradedToolConcurrencyMiddleware(toolConcurrencyQueueId)
  const subagentToolConcurrencyMiddleware = createGradedToolConcurrencyMiddleware(
    `${toolConcurrencyQueueId}:subagent`
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subagentMiddleware: any[] = [
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
    createPatchToolCallsMiddleware()
  ]

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

  const availableSubagents = includeGeneralPurposeSubagent
    ? [generalPurposeSubagent, ...processedSubagents, ...registrySubagents]
    : [...processedSubagents, ...registrySubagents]

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
  // Solo Level-2 path already gets this via createAgentToolGuardMiddleware; this
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

  return createAgent({
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
      ...(mainTodosEnabled ? [todoListMiddleware()] : []),
      ...(mainFilesystemEnabled ? [createFsMiddleware("\n")] : []),
      ...postFsToolDocStripMiddleware,
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
                subagents: availableSubagents,
                generalPurposeAgent: false,
                systemPrompt: taskSystemPrompt
              } as Parameters<typeof createSubAgentMiddleware>[0]),
              soloTaskTraceManager
            )
          ]
        : []),
      // Inject user messages steered into the running turn. Placed BEFORE
      // summarization (injected turns should participate in context management)
      // and BEFORE humanInTheLoop (a steered message must never race a pending
      // tool-approval interrupt). See createCurrentRunMessageQueueMiddleware.
      createCurrentRunMessageQueueMiddleware(currentRunMessageQueueOwnerToken),
      createCmbSummarizationMiddleware(mainSummarizationOptions),
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
      ...systemPromptPreviewCaptureMiddleware
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
function getShellInfo(windowsSandbox?: "none" | "unelevated" | "readonly" | "elevated"): {
  name: string
  isBashLike: boolean
  isPowerShell: boolean
} {
  const isSandboxed =
    process.platform === "win32" &&
    (windowsSandbox === "unelevated" ||
      windowsSandbox === "readonly" ||
      windowsSandbox === "elevated")
  const resolved = isSandboxed
    ? LocalSandbox.resolvedWindowsSandboxShell()
    : LocalSandbox.resolvedShell()
  const base = path
    .basename(resolved)
    .replace(/\.exe$/i, "")
    .toLowerCase()
  const isBashLike = ["bash", "sh", "zsh"].includes(base)
  const isPowerShell = ["pwsh", "powershell"].includes(base)
  return { name: base, isBashLike, isPowerShell }
}

/** Format a Date as local ISO-8601 with UTC offset, e.g. 2026-03-08T23:01:26+08:00 */
function formatLocalISO(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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

function getRuntimeTimeContext(date: Date = new Date()): {
  timezone: string
  currentTime: string
} {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const currentTime = formatLocalISO(date, timezone)
  return {
    timezone,
    currentTime
  }
}

function renderRuntimeTimeContextLines(
  timeContext: ReturnType<typeof getRuntimeTimeContext>,
  options: { includeCurrentTime?: boolean; includeTimestampRule?: boolean } = {}
): string {
  const includeCurrentTime = options.includeCurrentTime ?? true
  const includeTimestampRule = includeCurrentTime && options.includeTimestampRule === true
  return [
    `- Timezone: ${timeContext.timezone}`,
    ...(includeCurrentTime ? [`- Current time: ${timeContext.currentTime}`] : []),
    ...(includeTimestampRule
      ? [
          "- Timestamp rule: Do not invent dates or timestamps. If a timestamp is useful, use the current time above; otherwise omit it."
        ]
      : [])
  ].join("\n")
}

function normalizeInjectedMarkdownHeadings(content: string, minLevel = 3): string {
  let inFence = false
  let fenceChar: "`" | "~" | null = null
  let fenceLength = 0

  return content
    .split("\n")
    .map((line) => {
      const fenceMatch = line.match(/^( {0,3})(`{3,}|~{3,})/)
      if (fenceMatch) {
        const marker = fenceMatch[2]
        const markerChar = marker[0] as "`" | "~"
        if (!inFence) {
          inFence = true
          fenceChar = markerChar
          fenceLength = marker.length
        } else if (markerChar === fenceChar && marker.length >= fenceLength) {
          inFence = false
          fenceChar = null
          fenceLength = 0
        }
        return line
      }

      if (inFence) return line

      return line.replace(
        /^( {0,3})(#{1,6})([ \t]+.+)$/,
        (_match: string, indent: string, hashes: string, rest: string) => {
          const normalizedLevel = Math.max(hashes.length, minLevel)
          return `${indent}${"#".repeat(normalizedLevel)}${rest}`
        }
      )
    })
    .join("\n")
}

function renderAgentsInstructionsPrompt(content: string): string {
  const normalizedContent = normalizeInjectedMarkdownHeadings(content).trim()
  if (!normalizedContent) return ""
  return `## AGENTS.md instructions\n\n<AGENTS_INSTRUCTIONS>\n${normalizedContent}\n</AGENTS_INSTRUCTIONS>`
}

function renderPluginPromptInject(content?: string): string | undefined {
  const normalizedContent = content?.trim()
  if (!normalizedContent) return undefined
  return `## Skills Runtime Context\n\n${normalizedContent}`
}

export function getSystemPrompt(
  workspacePath: string,
  windowsSandbox?: "none" | "unelevated" | "readonly" | "elevated",
  options: {
    includeBackgroundExec?: boolean
    includeSubagents?: boolean
    includeMemory?: boolean
    includeCurrentTime?: boolean
  } = {}
): string {
  const includeBackgroundExec = options.includeBackgroundExec ?? true
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

  const timeContext = getRuntimeTimeContext()
  const timeContextLines = renderRuntimeTimeContextLines(timeContext, {
    includeCurrentTime: options.includeCurrentTime
  })
  const workingDirSection = `
### System Environment
- Operating system: ${platform} (${process.arch})
- Default shell: ${shell}
${timeContextLines}
${shellGuidance}

### File System and Paths

**IMPORTANT - Path Handling:**
- All file paths use fully qualified absolute system paths
- The workspace root is: \`${workspacePath}\`
- Example: \`${examplePath}\`
- To list the workspace root, use \`ls("${workspacePath}")\`
- Always use full absolute paths for all file operations
`

  // The background-exec guidance documents running builds/installs/tests through
  // execute (run_in_background). Omit it for runtimes whose execute tool has been
  // removed (shellAccess "none" registry agents, scoped write workers) — otherwise
  // the prompt tells the agent to call a tool it doesn't have, contradicting its
  // tool list and the worker's own access note. Omit it for read_only too:
  // execute is present, but isReadOnlyShellCommand rejects builds/installs/tests.
  const backgroundExecSection = !includeBackgroundExec
    ? ""
    : `
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

  const sandboxSection =
    windowsSandbox === "readonly"
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

  const memorySection = options.includeMemory !== false ? MEMORY_SYSTEM_PROMPT : ""
  return (
    workingDirSection +
    backgroundExecSection +
    sandboxSection +
    renderBaseSystemPrompt({ includeSubagents: options.includeSubagents }) +
    memorySection
  )
}

// Per-thread checkpointer cache (LRU-bounded).
//
// sql.js loads each thread's whole DB into WASM memory, so an unbounded cache
// grew main-process memory monotonically as the user visited threads (measured:
// hundreds of MB across a few hundred threads). We keep the most-recently-used N
// and evict the rest by closing them — close() flushes to disk and frees the
// WASM heap. An evicted thread transparently reloads from disk on next access.
//
// Two safety rules:
//  - Recency: getCheckpointer re-inserts on access, so an actively-used thread is
//    always most-recently-used and never the eviction victim.
//  - Busy guard: a thread with a live agent run is never evicted. Closing a
//    checkpointer a run still holds could leave two SqlJsSaver instances writing
//    the same DB file. The guard is injected by the IPC layer (which owns the
//    activeRuns registry) to avoid a circular import.
const checkpointers = new Map<string, SqlJsSaver>()
const MAX_CACHED_CHECKPOINTERS = 12
const MAIN_THREAD_MAX_ROOT_CHECKPOINTS = 3
const MAIN_THREAD_MAX_FORK_BOUNDARY_CHECKPOINTS = 30
const MAIN_THREAD_MAX_FORK_BOUNDARY_BYTES = 48 * 1024 * 1024
// In-flight eviction closes, so getCheckpointer can wait one out before
// recreating an instance for the same thread (avoids reading a half-written DB).
const closingCheckpointers = new Map<string, Promise<void>>()
// Instance mirror of closingCheckpointers: a thread retirement must be able to
// POISON (retire()) an instance whose detached evict-close is still settling —
// the promise alone can't reach the object, and a held reference could
// otherwise re-initialize it after the close settles.
const closingInstances = new Map<string, SqlJsSaver>()
// Retires (thread deletion) get their OWN wait channel, separate from reusable
// closes: the pinned-skip in getCheckpointerInternal exists because a reusable
// close WAITS for pins (pin holder waiting for it would deadlock) — but a
// retire never waits for pins, so waiting on it is deadlock-free and MANDATORY
// even for pinned callers. Heartbeat pins before it fetches its checkpointer;
// with retires only in closingCheckpointers, its revive-then-get skipped the
// wait and could grab/create a saver alongside the old one's in-flight teardown.
const retiringCheckpointers = new Map<string, Promise<void>>()
const checkpointerPins = new Map<string, number>()
const checkpointerPinWaiters = new Map<string, Set<() => void>>()

// Threads deleted this process (tombstones). A retired thread must never get a
// NEW checkpointer: SqlJsSaver.setup() persists an empty snapshot, so even a
// late read path would resurrect the just-deleted .sqlite as an orphan.
// Prefix-aware — a dead parent buries its __worker__/__wf_ sub-threads too.
// Entries stay for the process lifetime (tiny, bounded); late writers cannot
// survive a restart, so in-memory-only is sufficient.
//
// CONTRACT for reused thread ids: user threads are uuids (never reused), but
// fixed-id service threads exist (heartbeat). Any code that legitimately
// RE-CREATES a thread record under a previously-deleted id MUST call
// reviveRetiredThread(threadId) first — otherwise the new incarnation is
// refused checkpointers until the app restarts.
const retiredThreadIds = new Set<string>()

// Retire epochs (mirrors run-store's disposal epochs): a saver that began
// initialize() BEFORE a delete is in no registry, so retire can't poison it —
// and if a revive (fixed-id recreation) lands before initialize() returns, the
// tombstone re-check alone passes and the PRE-DELETION-born saver would be
// cached as the new incarnation. The epoch captured before creation changes
// exactly when a retire happened in between, revive-immune. Prefix-aware via
// summation over dead ancestors.
const retiredThreadEpochs = new Map<string, number>()

function retireEpochOf(threadId: string): number {
  let epoch = 0
  for (const [dead, count] of retiredThreadEpochs) {
    if (threadId === dead || threadId.startsWith(`${dead}__`)) epoch += count
  }
  return epoch
}

/**
 * Lift the deletion tombstone for a thread id that is being legitimately
 * re-created (fixed-id service threads like heartbeat, or a future
 * id-preserving restore). The tombstone's job is to kill LATE writers of the
 * DELETED incarnation; a caller deliberately making a new DB record for the
 * same id supersedes it. Old poisoned saver instances stay poisoned (they
 * belong to the dead incarnation) — the revived id simply gets fresh ones.
 */
export function reviveRetiredThread(threadId: string): void {
  retiredThreadIds.delete(threadId)
}

function isRetiredThreadId(threadId: string): boolean {
  if (retiredThreadIds.has(threadId)) return true
  for (const dead of retiredThreadIds) {
    if (threadId.startsWith(`${dead}__`)) return true
  }
  return false
}

let isCheckpointerThreadBusy: (threadId: string) => boolean = () => false
/** Wire the "is this thread mid-run" predicate (from the IPC layer's activeRuns). */
export function setCheckpointerBusyGuard(fn: (threadId: string) => boolean): void {
  isCheckpointerThreadBusy = fn
}

function isCheckpointerPinned(threadId: string): boolean {
  return (checkpointerPins.get(threadId) ?? 0) > 0
}

/**
 * Keep a checkpointer resident for a multi-step operation. This complements the
 * active-run guard for background services that do not participate in activeRuns.
 */
export function pinCheckpointer(threadId: string): () => void {
  checkpointerPins.set(threadId, (checkpointerPins.get(threadId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (checkpointerPins.get(threadId) ?? 1) - 1
    if (next > 0) {
      checkpointerPins.set(threadId, next)
      return
    }
    checkpointerPins.delete(threadId)
    const waiters = checkpointerPinWaiters.get(threadId)
    checkpointerPinWaiters.delete(threadId)
    waiters?.forEach((resolve) => resolve())
    evictIdleCheckpointers()
  }
}

function waitForCheckpointerPins(threadId: string): Promise<void> {
  if (!isCheckpointerPinned(threadId)) return Promise.resolve()
  return new Promise((resolve) => {
    const waiters = checkpointerPinWaiters.get(threadId) ?? new Set<() => void>()
    waiters.add(resolve)
    checkpointerPinWaiters.set(threadId, waiters)
  })
}

async function waitForCheckpointerClose(threadId: string): Promise<void> {
  for (;;) {
    const pendingClose = closingCheckpointers.get(threadId)
    if (!pendingClose) return
    try {
      await pendingClose
    } catch {
      // best-effort; a following iteration can observe any replacement close
    }
  }
}

async function waitForCheckpointerRetire(threadId: string): Promise<void> {
  for (;;) {
    const pendingRetire = retiringCheckpointers.get(threadId)
    if (!pendingRetire) return
    try {
      await pendingRetire
    } catch {
      // best-effort; a following iteration can observe any replacement retire
    }
  }
}

/** Close least-recently-used checkpointers beyond the cap, skipping busy threads. */
function evictIdleCheckpointers(): void {
  if (checkpointers.size <= MAX_CACHED_CHECKPOINTERS) return
  // Map iterates in insertion order; getCheckpointer re-inserts on access, so the
  // front entries are the least-recently-used.
  for (const [threadId, checkpointer] of checkpointers) {
    if (checkpointers.size <= MAX_CACHED_CHECKPOINTERS) break
    if (isCheckpointerThreadBusy(threadId)) continue
    if (isCheckpointerPinned(threadId)) continue
    // RULE, not a name list: NO sub-thread (coordinator `__worker__`, workflow
    // `__wf_`, any future `<parent>__<role>` id) participates in LRU. Sub-agents
    // hold their saver instance for the whole run WITHOUT registering in the IPC
    // busy guard, so evicting one mid-run orphans a live writer: the held
    // instance re-initializes on its next put() and keeps writing untracked by
    // this map — its own cleanup then closes nothing, and a late debounced save
    // resurrects the just-deleted file. Sub-threads are transient and closed by
    // their explicit per-run cleanup instead. (The old `__worker__`-only special
    // case missed `__wf_` and produced exactly that bug.)
    if (threadId.includes("__")) continue
    checkpointers.delete(threadId)
    // NOTE: only free the checkpointer here. Unlike closeCheckpointer (thread
    // deletion), eviction is pure cache management — the thread still exists, so
    // sibling state like approvalStores (a pending approval on an idle thread)
    // must NOT be dropped.
    // Detached so the run that triggered eviction isn't blocked on disk flushes;
    // tracked in closingCheckpointers so a re-fetch waits it out.
    const closing = checkpointer
      .close()
      .catch((e) => console.warn(`[Runtime] evict checkpointer close failed for ${threadId}:`, e))
      .finally(() => {
        if (closingCheckpointers.get(threadId) === closing) closingCheckpointers.delete(threadId)
        if (closingInstances.get(threadId) === checkpointer) closingInstances.delete(threadId)
      })
    closingCheckpointers.set(threadId, closing)
    closingInstances.set(threadId, checkpointer)
  }
}

// ─────────────────────────────────────────────────────────
// Tool-call counter: track how many tool calls have been made
// in each thread during the current session. Used to trigger
// the skill-evolution nudge after SKILL_EVOLUTION_THRESHOLD calls.
// ─────────────────────────────────────────────────────────

/** Returns the current skill-evolution threshold from persistent storage. */
export function getSkillEvolutionThreshold(): number {
  return getStoredSkillEvolutionThreshold()
}

/** Returns the current skill-evolution conversation-turn threshold from persistent storage. */
export function getSkillEvolutionTurnThreshold(): number {
  return getStoredSkillEvolutionTurnThreshold()
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

async function getCheckpointerInternal(
  threadId: string,
  waitForPendingClose: boolean
): Promise<SqlJsSaver> {
  // Tombstone gate: never create (or hand out) a checkpointer for a deleted
  // thread — SqlJsSaver.setup() persists an empty snapshot, so a late caller
  // would materialize an orphan .sqlite for a thread that no longer exists.
  if (isRetiredThreadId(threadId)) {
    throw new Error(`[Runtime] Thread is deleted; checkpointer refused: ${threadId}`)
  }
  // An in-flight retire must be waited out UNCONDITIONALLY — pinned callers
  // included (see retiringCheckpointers: retire never waits pins, so this
  // cannot deadlock). Only reachable for a revived id (the tombstone check
  // above throws otherwise), i.e. heartbeat's pin-then-get sequence.
  await waitForCheckpointerRetire(threadId)
  if (waitForPendingClose && !isCheckpointerPinned(threadId)) {
    await waitForCheckpointerClose(threadId)
  }
  const cached = checkpointers.get(threadId)
  if (cached) {
    // Refresh LRU recency: move to the most-recently-used (end) position.
    checkpointers.delete(threadId)
    checkpointers.set(threadId, cached)
    return cached
  }
  const dbPath = getThreadCheckpointPath(threadId)
  const bornRetireEpoch = retireEpochOf(threadId)
  const isSubThreadCheckpoint = threadId.includes("__")
  const checkpointer = new SqlJsSaver(dbPath, undefined, {
    maxRootCheckpoints: isSubThreadCheckpoint ? 1 : MAIN_THREAD_MAX_ROOT_CHECKPOINTS,
    maxRootForkBoundaryCheckpoints: isSubThreadCheckpoint
      ? 0
      : MAIN_THREAD_MAX_FORK_BOUNDARY_CHECKPOINTS,
    maxRootForkBoundaryBytes: isSubThreadCheckpoint ? 0 : MAIN_THREAD_MAX_FORK_BOUNDARY_BYTES,
    maxNonRootCheckpoints: 1
  })
  await checkpointer.initialize()
  // Re-check AFTER the awaits above: a deletion landing while this instance
  // was initializing scans the three registries, but this instance is in none
  // of them yet — caching it would hand a live, writable saver for a deleted
  // thread (setup() has already queued an async persist). The tombstone check
  // alone is NOT enough: a revive (fixed-id recreation) landing before
  // initialize() returned clears it, yet this saver was born of the PREVIOUS
  // incarnation — the retire epoch catches that, revive-immune.
  if (isRetiredThreadId(threadId) || retireEpochOf(threadId) !== bornRetireEpoch) {
    await checkpointer.retire()
    // initialize() may itself have WRITTEN to disk before this check:
    // openRecoveredSqliteDatabase persists a recovered .bak/.tmp back to the
    // live .sqlite, and the deletion's purge has already swept. retire() only
    // gates FUTURE writes — re-sweep the recovery's write here, so the dead
    // incarnation's transcript can't bleed into a revived id across a crash.
    //
    // BEST-EFFORT MITIGATION, not an ownership proof (accepted residual): a
    // cached entry does mean a revived saver owns the file (skip), but the
    // converse is heuristic — a revived saver can itself be mid-initialize and
    // not cached yet, and this sweep could then eat its files. That residual
    // is bounded: during its own init the new incarnation can hold NO user
    // data on disk (post-purge there is nothing to recover, and new content
    // only arrives via put() after init; its in-memory db is authoritative and
    // any next write rewrites the whole file). Strictly closing the window
    // needs an init-in-flight lease — declined per ROI for a five-condition
    // race with bounded, self-healing fallout.
    if (isRetiredThreadId(threadId) || !checkpointers.has(threadId)) {
      try {
        deleteThreadCheckpoint(threadId)
      } catch (e) {
        console.warn(`[Runtime] post-refusal checkpoint re-sweep failed for ${threadId}:`, e)
      }
    }
    throw new Error(`[Runtime] Thread was deleted during checkpointer init; refused: ${threadId}`)
  }
  checkpointers.set(threadId, checkpointer)
  evictIdleCheckpointers()
  return checkpointer
}

export async function getCheckpointer(threadId: string): Promise<SqlJsSaver> {
  return getCheckpointerInternal(threadId, true)
}

export async function withCheckpointer<T>(
  threadId: string,
  operation: (checkpointer: SqlJsSaver) => Promise<T>
): Promise<T> {
  await waitForCheckpointerClose(threadId)

  // No await between the close check and pin acquisition: an explicit close
  // either precedes us (and was awaited) or observes this pin and waits for it.
  const release = pinCheckpointer(threadId)
  try {
    const checkpointer = await getCheckpointerInternal(threadId, false)
    return await operation(checkpointer)
  } finally {
    release()
  }
}

export async function closeCheckpointer(threadId: string): Promise<void> {
  const previousClose = closingCheckpointers.get(threadId)
  // Mirror the instance SYNCHRONOUSLY (like the evict path): a thread
  // retirement arriving while this close is still waiting (previous close,
  // pins) must be able to poison the instance — the async body only removes it
  // from `checkpointers` after those waits, and once the close settles the
  // mirror entry is gone again, so registering any later would leave a window
  // where retire can reach it through neither map. The map entry cannot be
  // swapped under us meanwhile: getCheckpointer waits out the pending close we
  // register below before creating a replacement.
  const instanceAtCall = checkpointers.get(threadId)
  if (instanceAtCall) closingInstances.set(threadId, instanceAtCall)
  const closing = (async () => {
    if (previousClose) await previousClose
    await waitForCheckpointerPins(threadId)
    const checkpointer = checkpointers.get(threadId)
    if (checkpointer) {
      checkpointers.delete(threadId)
      await checkpointer.close()
    }
    approvalStores.delete(threadId)
  })().finally(() => {
    const stillOwnsClose = closingCheckpointers.get(threadId) === closing
    if (stillOwnsClose) closingCheckpointers.delete(threadId)
    // Mirror cleanup must ALSO verify close ownership, not just the instance:
    // two overlapping closes of the SAME saver register the same instance
    // value, and the first to settle would otherwise remove the mirror entry
    // the still-in-flight second close (and a concurrent retire's poisoning)
    // depends on. Complementary case: when WE own the channel but started with
    // instanceAtCall undefined (the predecessor had already emptied the map),
    // the predecessor deferred its mirror cleanup to us — sweep the stale
    // entry, or the closed saver object is retained for the process lifetime.
    // (Only close-deferred entries can be present here: evict and retire both
    // clean their own mirror registrations on settle.)
    if (stillOwnsClose && (!instanceAtCall || closingInstances.get(threadId) === instanceAtCall)) {
      closingInstances.delete(threadId)
    }
  })
  closingCheckpointers.set(threadId, closing)
  await closing
}

/**
 * THE deletion primitive for checkpointer lifecycle: permanently retire the
 * thread's checkpointer AND every sub-thread's (`__worker__`, `__wf_`, any
 * future `<parent>__<role>` id). Must run BEFORE the disk sweeps — a writer
 * that outlived its cancellation (hung subagent past cancelAndWait's timeout)
 * could otherwise flush a late snapshot and resurrect the just-deleted files.
 *
 * Unlike closeCheckpointer (reusable close for a still-existing thread), this:
 *  - tombstones FIRST (synchronously), so no interleaved caller can create a
 *    fresh instance while we await the teardown;
 *  - poisons instances via retire() — a held reference (the compiled graph
 *    keeps its saver for the whole run) can never re-initialize and write again;
 *  - also poisons instances whose detached LRU-evict close is still settling
 *    (closingInstances), then awaits those closes so no in-flight rename can
 *    land after the sweep;
 *  - deliberately does NOT wait for pins ITSELF: retire() makes a late
 *    operation fail fast instead of resurrecting, and "error on a deleted
 *    thread" is the correct semantics — waiting could hang deletion behind a
 *    wedged writer. (Precise caveat: awaiting an in-flight reusable close CAN
 *    transitively wait on that close's own pin wait — bounded by the pinned
 *    operation's duration, and safe either way: the instance is mirrored in
 *    closingInstances at close start, so it gets poisoned when we resume.)
 */
export async function retireThreadCheckpointers(threadId: string): Promise<void> {
  retiredThreadIds.add(threadId)
  retiredThreadEpochs.set(threadId, (retiredThreadEpochs.get(threadId) ?? 0) + 1)
  const prefix = `${threadId}__`
  const matches = (id: string): boolean => id === threadId || id.startsWith(prefix)
  const ids = new Set<string>(
    [...checkpointers.keys(), ...closingCheckpointers.keys(), ...closingInstances.keys()].filter(
      matches
    )
  )
  // The exact parent id ALWAYS gets a retiring entry — even with nothing
  // cached. A fixed-id reviver (heartbeat) synchronizes on this channel, and
  // its post-revive getCheckpointer resumes the moment the per-id chain
  // settles — BEFORE the caller's own continuation gets to sweep the disk. An
  // empty registry would leave no entry at all, and a warm-wasm, sync-fs init
  // could then load the dead incarnation's bytes from the not-yet-swept file.
  // The chain therefore hot-sweeps the parent's durable files itself before
  // settling (deep purge for quarantine archives still runs in threads:delete).
  ids.add(threadId)
  // allSettled, NOT all: one rejecting retire() must not make this resolve
  // early while sibling teardowns are still in flight — the caller sweeps the
  // disk right after, and an unsettled sibling's in-flight close could late-
  // rename a file back AFTER the sweep. Every id must settle before we return.
  const settled = await Promise.allSettled(
    Array.from(ids).map((id) => {
      // Grab the evict-closing instance BEFORE awaiting its close settles (the
      // settle handler removes it from the map), so it can still be poisoned.
      const previousClose = closingCheckpointers.get(id)
      const closingInstance = closingInstances.get(id)
      const retiring = (async () => {
        // Poison FIRST — retire() sets the write-gate flag synchronously at
        // call, so even while we wait out an in-flight close, no NEW write
        // iteration can start on that instance. Handled at creation: a fast
        // rejection must not become an unhandled rejection while we're still
        // awaiting the previous close below.
        const closingInstanceRetire = closingInstance
          ? closingInstance
              .retire()
              .catch((e) => console.warn(`[Runtime] closing-instance retire failed for ${id}:`, e))
          : null
        // A rejected prior close must NOT skip the poisoning below — log and
        // keep going; the sweep ordering only needs the close's in-flight
        // WRITE to have settled, which awaiting the (settled-or-rejected)
        // promise provides either way.
        if (previousClose) {
          await previousClose.catch((e) =>
            console.warn(`[Runtime] prior close failed during retire of ${id}:`, e)
          )
        }
        if (closingInstanceRetire) await closingInstanceRetire
        const checkpointer = checkpointers.get(id)
        if (checkpointer) {
          checkpointers.delete(id)
          await checkpointer.retire()
        }
        if (id === threadId) {
          // Writers above are drained/poisoned — sweep the parent's durable
          // files BEFORE this entry settles, so anyone waiting on the retiring
          // channel resumes to a clean disk.
          try {
            deleteThreadCheckpoint(id)
          } catch (e) {
            console.warn(`[Runtime] in-retire checkpoint sweep failed for ${id}:`, e)
          }
        }
      })().finally(() => {
        if (closingCheckpointers.get(id) === retiring) closingCheckpointers.delete(id)
        if (retiringCheckpointers.get(id) === retiring) retiringCheckpointers.delete(id)
        // The superseded close's finally deliberately skips mirror cleanup
        // once we took close ownership — so the mirror entry is OURS to clear,
        // or the closed saver object leaks in closingInstances for the process
        // lifetime.
        if (closingInstance && closingInstances.get(id) === closingInstance) {
          closingInstances.delete(id)
        }
      })
      // Register synchronously, before any await, in BOTH channels: the
      // closing map keeps ordinary close/getCheckpointer chaining intact, and
      // the retiring map is the pin-immune wait a revived fixed-id caller
      // (heartbeat pins BEFORE fetching) is required to honor.
      closingCheckpointers.set(id, retiring)
      retiringCheckpointers.set(id, retiring)
      return retiring
    })
  )
  for (const result of settled) {
    if (result.status === "rejected") {
      console.warn(
        `[Runtime] a checkpointer retire failed during thread retirement:`,
        result.reason
      )
    }
  }
  // Independent of checkpointer presence: an approval store can exist for a
  // thread whose checkpointer was already evicted/never cached.
  for (const id of Array.from(approvalStores.keys()).filter(matches)) {
    approvalStores.delete(id)
  }
}

// Get the model instance from custom model configuration
// ─── Custom fetch with unified retry ────────────────────────────────────────
// Single source of truth for same-model retry logic. SDK-level retry is
// disabled (maxRetries: 0) so this is the only layer that retries.

/** Specific non-5xx status codes that should trigger a retry on the SAME model/endpoint.
 *  All 5xx are also retryable (handled by isRetryableStatus below). */
const RETRYABLE_NON_5XX_STATUS = new Set([408, 409, 429, 432, 433])

function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_NON_5XX_STATUS.has(status)
}

const DEFAULT_RETRY_MAX_ATTEMPTS = 6 // 1 initial + 5 retries (used when caller does not specify)
const RETRY_BASE_DELAY_MS = 1000 // exponential: 1s, 2s, 4s, 8s
/** Per-attempt timeout — guards against half-open / stalled connections
 *  (cases where TCP stays up but no bytes flow). Each attempt gets its own
 *  AbortController so a timeout on attempt N doesn't poison attempt N+1. */
const PER_ATTEMPT_TIMEOUT_MS = 60_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function computeBackoffDelay(attempt: number): number {
  // attempt is 1-based (1 = before first retry). 1s,2s,4s,8s with jitter 1x-2x.
  const base = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
  return Math.round(base * (1 + Math.random()))
}

/** Info emitted to the UI before each retry wait. */
export interface ModelRetryInfo {
  /** 1-based attempt counter about to be retried (1 = first retry). */
  attempt: number
  /** Maximum number of retries that can occur. */
  maxRetries: number
  /** Human-readable reason (HTTP status or network error message). */
  reason: string
  /** Wait duration before the next attempt, in ms. */
  delayMs: number
}

/** Raw error response captured at the fetch layer, before the SDK parses it. */
export interface FetchErrorInfo {
  /** HTTP status of the failing response (485, 432, …). */
  status: number
  /** Upstream request id (x-request-id), when present. */
  requestId?: string
  /** Raw response body text — the only schema-independent source of the real
   *  reason. Surfaced even when the SDK drops a non-OpenAI error envelope. */
  rawBody?: string
}

/** Hooks invoked by the retrying fetch wrapper so the UI can display/clear status. */
export interface ModelRetryHooks {
  onRetry?: (info: ModelRetryInfo) => void
  /** Called when a retry attempt succeeds (fetch returns a non-retryable response).
   *  The UI should clear the retry indicator immediately on this callback. */
  onRetrySuccess?: () => void
  /** Called when a non-retryable error HTTP response (>= 400) is about to be
   *  handed back to the SDK. Carries the raw body so the upper layer can show
   *  the real reason regardless of the body schema. */
  onFetchError?: (info: FetchErrorInfo) => void
}

/**
 * Build a retrying fetch wrapper. Retries on:
 *   - Network errors thrown by fetch
 *   - HTTP status in RETRYABLE_NON_5XX_STATUS (or >= 500)
 *   - Per-attempt timeout (half-open / stalled connection guard)
 * Does NOT retry on:
 *   - Parent signal abort (user cancelled) — propagated immediately
 *   - 2xx (including streaming 200 — returned immediately)
 *   - Non-retryable 4xx (400/401/403/404/...) — bubbled up to failover layer
 *
 * Each attempt creates its own AbortController so a timeout on one attempt
 * does not poison the next one (avoids the "stuck signal" pitfall that
 * happens when SDK-level timeout aborts the shared signal).
 */
function createRetryingFetch(
  hooks?: ModelRetryHooks,
  maxAttempts: number = DEFAULT_RETRY_MAX_ATTEMPTS
): typeof fetch {
  const totalAttempts = Math.max(1, maxAttempts)
  const maxRetries = totalAttempts - 1
  return async (input, init) => {
    const parentSignal = (init?.signal ?? undefined) as AbortSignal | undefined
    let lastError: unknown = undefined

    // Capture the raw error body before the SDK consumes it. The OpenAI SDK only
    // preserves a body that matches the `{error:{…}}` envelope, so for custom
    // gateway codes (480/485/…) or non-OpenAI bodies this clone is the only place
    // the real reason survives. Called both for non-retryable statuses and when
    // the retry budget is exhausted on a retryable status (432/433/429/5xx).
    const captureFetchError = async (res: Response): Promise<void> => {
      if (res.status < 400 || !hooks?.onFetchError) return
      const requestId = res.headers.get("x-request-id") ?? undefined
      try {
        const rawBody = await res.clone().text()
        hooks.onFetchError({ status: res.status, requestId, rawBody })
      } catch {
        // Body capture is best-effort — never block the real response.
        hooks.onFetchError({ status: res.status, requestId })
      }
    }

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (parentSignal?.aborted) throw new DOMException("Aborted", "AbortError")

      // Per-attempt controller: fresh each iteration so a timeout on attempt N
      // does not leak into attempt N+1. Parent (user cancel) is forwarded in
      // one direction only: parent -> attempt. Attempt abort never touches parent.
      const attemptCtrl = new AbortController()
      const onParentAbort = (): void => {
        attemptCtrl.abort(parentSignal?.reason ?? new DOMException("Aborted", "AbortError"))
      }
      parentSignal?.addEventListener("abort", onParentAbort, { once: true })

      const timeoutHandle = setTimeout(() => {
        attemptCtrl.abort(new DOMException("Per-attempt timeout", "TimeoutError"))
      }, PER_ATTEMPT_TIMEOUT_MS)

      const cleanup = (): void => {
        clearTimeout(timeoutHandle)
        parentSignal?.removeEventListener("abort", onParentAbort)
      }

      try {
        const requestedStream =
          typeof init?.body === "string" && init.body.includes('"stream":true')
        const attemptStartedAt = Date.now()
        const res = await fetch(input, { ...init, signal: attemptCtrl.signal })

        // IMPORTANT: do not cancel the per-attempt timeout yet for streaming
        // responses — we want the timeout to cover only the time up to the
        // first byte. Once the response headers are in, we cancel the timer
        // because downstream (SDK / LangChain) owns the stream lifetime from
        // here and should not be interrupted mid-stream by our timer.
        cleanup()

        // Ground truth for the streaming path: an SSE response announces itself as
        // content-type text/event-stream; application/json means the gateway buffered
        // the whole completion — long generations on that path will hit the 60s
        // first-byte watchdog above.
        console.log(
          `[Runtime] fetch headers in ${Date.now() - attemptStartedAt}ms: status=${res.status}, stream requested=${requestedStream}, content-type=${res.headers.get("content-type") ?? "unknown"}`
        )

        // Success or non-retryable error — return as-is.
        if (!isRetryableStatus(res.status)) {
          await captureFetchError(res)
          // If this is a successful retry (not the first attempt), notify the UI
          // so the retry indicator can be cleared immediately.
          if (attempt > 1) hooks?.onRetrySuccess?.()
          return res
        }

        // Retryable HTTP status.
        if (attempt >= totalAttempts) {
          // Retry budget exhausted — capture the body so the real reason still
          // reaches the UI, then return so the caller sees the real status.
          await captureFetchError(res)
          return res
        }

        // Drain body to free the connection before retrying.
        try {
          await res.arrayBuffer()
        } catch {
          /* ignore */
        }

        const delay = computeBackoffDelay(attempt)
        console.warn(
          `[Runtime] fetch HTTP ${res.status}, retry ${attempt}/${maxRetries} after ${delay}ms`
        )
        hooks?.onRetry?.({
          attempt,
          maxRetries,
          reason: `HTTP ${res.status}`,
          delayMs: delay
        })
        await sleep(delay, parentSignal)
        continue
      } catch (err) {
        cleanup()

        // Parent signal aborted (user cancel) — propagate immediately, no retry.
        if (parentSignal?.aborted) throw err

        // Distinguish per-attempt timeout from generic network errors for logging;
        // both are retryable.
        const isTimeout = err instanceof Error && err.name === "TimeoutError"
        const rawMsg = err instanceof Error ? err.message : String(err)
        const reason = isTimeout ? `timeout after ${PER_ATTEMPT_TIMEOUT_MS}ms` : rawMsg

        lastError = err
        if (attempt >= totalAttempts) throw err

        const delay = computeBackoffDelay(attempt)
        console.warn(
          `[Runtime] fetch ${isTimeout ? "timeout" : "network error"} "${reason}", retry ${attempt}/${maxRetries} after ${delay}ms`
        )
        hooks?.onRetry?.({
          attempt,
          maxRetries,
          reason: reason || "network error",
          delayMs: delay
        })
        await sleep(delay, parentSignal)
        continue
      }
    }

    // Unreachable — loop always returns or throws.
    throw lastError ?? new Error("retryingFetch: unexpected loop exit")
  }
}

const MAX_WORKER_STOP_HOOK_REVISIONS = 2
const WORKER_STOP_HOOK_REVISION_PROMPT_PREFIX = "[[CMBDEVCLAW_STOP_HOOK_REVISION]]"

function getWorkerStopHookBlockReason(result: HookResult): string {
  return (
    result.reason ||
    result.stopReason ||
    result.stdout ||
    result.stderr ||
    "Stop hook requested revision"
  )
}

function buildWorkerStopRevisionPrompt(result: HookResult, attempt: number): string {
  const parts = [
    `${WORKER_STOP_HOOK_REVISION_PROMPT_PREFIX} Internal revision request. Do not mention this marker.`,
    "A completion hook reviewed your previous worker result and requested a revision.",
    "Revise the work now. Address the issue directly, run any checks that are needed, and then provide an updated final handoff.",
    `Revision attempt: ${attempt}/${MAX_WORKER_STOP_HOOK_REVISIONS}`,
    `Hook reason:\n${getWorkerStopHookBlockReason(result)}`
  ]
  if (result.additionalContext) {
    parts.push(`Additional hook context:\n${result.additionalContext}`)
  }
  if (result.systemMessage) {
    parts.push(`Hook message:\n${result.systemMessage}`)
  }
  return parts.join("\n\n")
}

async function applyWorkerPromptSubmitHooks({
  prompt,
  sessionId,
  agentId,
  workspacePath,
  onHookResult,
  metadata,
  isolatedHookContext
}: {
  prompt: string
  sessionId: string
  agentId: string
  workspacePath: string
  onHookResult?: HookResultCallback
  metadata?: Record<string, unknown>
  isolatedHookContext?: Pick<HookContext, "workspaceHookCwd" | "forceSyncWorkspaceHooks">
}): Promise<string> {
  let effectivePrompt = prompt
  const promptSubmitResult = await runHooksEnriched(
    getEnabledHooks(workspacePath),
    "UserPromptSubmit",
    {
      toolArgs: { message: prompt, ...(metadata ?? {}) },
      userPrompt: prompt,
      workspacePath,
      sessionId,
      agentId,
      ...isolatedHookContext
    },
    onHookResult
  )
  if (promptSubmitResult?.blocked || promptSubmitResult?.continue === false) {
    const reason =
      promptSubmitResult.stopReason ||
      promptSubmitResult.stderr ||
      promptSubmitResult.stdout ||
      "Worker prompt was blocked by hook policy."
    throw new Error(reason)
  }
  const updatedPrompt =
    promptSubmitResult?.updatedInput?.message ??
    promptSubmitResult?.updatedInput?.prompt ??
    promptSubmitResult?.updatedInput?.userPrompt
  if (typeof updatedPrompt === "string" && updatedPrompt.length > 0) {
    effectivePrompt = updatedPrompt
  }
  if (promptSubmitResult?.additionalContext) {
    effectivePrompt = `${promptSubmitResult.additionalContext}\n\n${effectivePrompt}`
  }
  if (promptSubmitResult?.systemMessage) {
    console.log("[CoordinatorWorker][UserPromptSubmit]", promptSubmitResult.systemMessage)
  }
  return effectivePrompt
}

function observeWorkerSkillUsage(
  mode: string,
  payload: unknown,
  detector: SkillUsageDetector,
  valuesContext?: WorkerValuesSnapshotContext
): boolean {
  return observeSkillUsageFromStream(mode, payload, detector, valuesContext)
}

async function runWorkerStopHooksWithRevision({
  sessionId,
  agentId,
  workspacePath,
  abortSignal,
  getStopContext,
  runRevision,
  sendNotice,
  sendError,
  onHookResult,
  isolatedHookContext
}: {
  sessionId: string
  agentId: string
  workspacePath: string
  abortSignal: AbortSignal
  getStopContext: () => {
    userMessage?: string
    assistantResponse?: string
    toolCalls?: string[]
    usedSkills?: string[]
  }
  runRevision: (prompt: string) => Promise<void>
  sendNotice: (message: string) => void
  sendError: (message: string) => void
  onHookResult?: HookResultCallback
  isolatedHookContext?: Pick<HookContext, "workspaceHookCwd" | "forceSyncWorkspaceHooks">
}): Promise<boolean> {
  let revisionCount = 0
  while (!abortSignal.aborted) {
    const stopResult = await runHooksEnriched(
      getEnabledHooks(workspacePath),
      "Stop",
      {
        workspacePath,
        sessionId,
        agentId,
        stopContext: getStopContext(),
        ...isolatedHookContext
      },
      onHookResult
    ).catch((error) => {
      console.warn("[Hooks] Worker Stop hook error:", error)
      return null
    })

    if (stopResult?.decision !== "block") return true
    if (stopResult.systemMessage) sendNotice(stopResult.systemMessage)

    const reason = getWorkerStopHookBlockReason(stopResult)
    if (revisionCount >= MAX_WORKER_STOP_HOOK_REVISIONS) {
      sendError(
        `Stop hook blocked worker completion after ${MAX_WORKER_STOP_HOOK_REVISIONS} revision attempts: ${reason}`
      )
      return false
    }

    revisionCount += 1
    sendNotice(
      `Stop hook requested worker revision (${revisionCount}/${MAX_WORKER_STOP_HOOK_REVISIONS}): ${reason}`
    )
    await runRevision(buildWorkerStopRevisionPrompt(stopResult, revisionCount))
  }
  return false
}

/** Default fetch (no UI hooks) for model instances without a UI context (e.g. skill generation). */
const defaultRetryingFetch = createRetryingFetch()

type ModelInstancePurpose = "agent" | "context-compaction"

function localCompactionTokenCount(content: unknown): number {
  let text: string
  if (typeof content === "string") {
    text = content
  } else {
    try {
      text = JSON.stringify(content) ?? ""
    } catch {
      text = String(content ?? "")
    }
  }
  return Math.ceil(text.length / 4)
}

function configureLocalCompactionTokenEstimation(model: ChatOpenAI): ChatOpenAI {
  const completions = (
    model as unknown as {
      completions?: { getNumTokens: (content: unknown) => Promise<number> }
    }
  ).completions
  if (!completions) return model

  // LangChain's streaming invoke() estimates usage after the SSE completes and
  // otherwise downloads a Tiktoken vocabulary. Compaction does not consume
  // that estimate, so keep this bookkeeping local, deterministic, and offline.
  completions.getNumTokens = async (content: unknown): Promise<number> =>
    localCompactionTokenCount(content)
  return model
}

/** @internal Exported for protocol-level tests. */
export function getModelInstance(
  customConfig: {
    id: string
    model: string
    baseUrl: string
    apiKey?: string
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    interleavedThinking?: boolean
    enableThinking?: boolean
    enableThinkingEffort?: boolean
    thinkingEffort?: "high" | "max"
  },
  retryHooks?: ModelRetryHooks,
  maxRetryAttempts?: number,
  purpose: ModelInstancePurpose = "agent"
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
  const configuredMaxOutputTokens = customConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const maxOutputTokens =
    purpose === "context-compaction"
      ? Math.min(configuredMaxOutputTokens, CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS)
      : configuredMaxOutputTokens
  const temperature = customConfig.temperature ?? DEFAULT_TEMPERATURE
  const topP = customConfig.topP ?? DEFAULT_TOP_P
  const topK = customConfig.topK ?? DEFAULT_TOP_K
  const thinkingEffort = customConfig.thinkingEffort ?? DEFAULT_THINKING_EFFORT
  const thinkingConfigured = customConfig.enableThinking === true
  // Compaction needs a final-text handoff, not a reasoning trace. Allowing a
  // thinking model here can spend the entire output budget on reasoning and
  // return empty content, so keep thinking exclusive to normal agent calls.
  const enableThinking = purpose === "agent" && thinkingConfigured
  const enableThinkingEffort = enableThinking && customConfig.enableThinkingEffort === true

  const baseFields = {
    model: resolvedModel,
    apiKey,
    // Keep the established agent protocol unchanged. Context compaction uses a
    // separate model instance because its invoke() must consume SSE internally.
    ...(purpose === "context-compaction" ? { streaming: true } : {}),
    maxTokens: maxOutputTokens,
    temperature,
    topP,
    // SDK-level retry AND timeout disabled — unified retry + per-attempt
    // timeout live in retryingFetch below. Setting SDK timeout here would
    // create a shared AbortSignal that, once fired, permanently blocks all
    // subsequent retry attempts at the fetch layer.
    maxRetries: 0,
    modelKwargs: {
      parallel_tool_calls: true,
      ...(topK > 0 ? { top_k: topK } : {}),
      chat_template_kwargs: {
        enable_thinking: enableThinking,
        ...(enableThinkingEffort ? { reasoning_effort: thinkingEffort } : {})
      },
      ...(enableThinking ? { thinking: { type: "enabled" } } : {})
    },
    configuration: {
      baseURL: customConfig.baseUrl,
      fetch:
        retryHooks || maxRetryAttempts !== undefined
          ? createRetryingFetch(retryHooks, maxRetryAttempts)
          : defaultRetryingFetch
    }
  }

  let model: ChatOpenAI
  if (enableThinking && customConfig.interleavedThinking) {
    model = new ChatOpenAI({
      ...baseFields,
      completions: new InterleavedThinkingChatOpenAICompletions(baseFields, {
        exposeReasoning: enableThinking
      })
    } as never)
  } else if (enableThinking) {
    model = new ChatOpenAI({
      ...baseFields,
      completions: new ReasoningDisplayChatOpenAICompletions(baseFields)
    } as never)
  } else if (purpose === "context-compaction") {
    // ChatOpenAI.withConfig() rebuilds the wrapper from its original fields.
    // Keep the compaction completions explicit so the local token counter below
    // survives the tags/callback binding applied by configureContextCompactionModel().
    model = new ChatOpenAI({
      ...baseFields,
      completions: new ChatOpenAICompletions(baseFields)
    } as never)
  } else {
    model = new ChatOpenAI(baseFields)
  }

  return purpose === "context-compaction" ? configureLocalCompactionTokenEstimation(model) : model
}

type AgentsPromptLoader = "plugin" | "cmbdevclaw"

interface AgentsPromptLoadStatusPayload {
  items: HarnessAgentmdLoadStatusItem[]
  loader: AgentsPromptLoader
  promptPreview?: string
}

function applyDeployUnitMappingsToAgentmdLoadStatus(
  items: HarnessAgentmdLoadStatusItem[],
  mappings: HarnessDeployUnitMapping[] | undefined
): HarnessAgentmdLoadStatusItem[] {
  if (!Array.isArray(mappings) || mappings.length === 0) return items

  const deployUnitByRepoPath = new Map<string, string>()
  for (const mapping of mappings) {
    const localRepoPath = mapping.localRepoPath.trim()
    const deployUnitId = mapping.deployUnitId.trim()
    if (!localRepoPath || !deployUnitId) continue
    deployUnitByRepoPath.set(resolve(localRepoPath), deployUnitId)
  }
  if (deployUnitByRepoPath.size === 0) return items

  return items.map((item) => {
    if (!path.isAbsolute(item.deployUnitId)) return item
    const deployUnitId = deployUnitByRepoPath.get(resolve(item.deployUnitId))
    return deployUnitId ? { ...item, deployUnitId: deployUnitId } : item
  })
}

export interface CreateAgentRuntimeOptions {
  /** Thread ID - REQUIRED for per-thread checkpointing */
  threadId: string
  /** Per-thread output style. Applied only to the foreground normal-mode main agent. */
  outputStyle?: AgentOutputStyle
  /** Legacy compatibility for threads created before outputStyle was introduced. */
  conciseModeEnabled?: boolean
  /** Stable identity exposed to hooks for subagent/worker attribution. */
  agentId?: string
  /** Physical foreground run token allowed to drain the current-run steer queue. */
  currentRunMessageQueueOwnerToken?: string
  /** Optional UI thread ID for approval prompts. Async worker runtimes keep their own checkpoint thread but surface approvals on the parent thread UI. */
  approvalThreadId?: string
  /** Optional model ID from thread/runtime config */
  modelId?: string
  /** Workspace path - REQUIRED for agent to operate on files */
  workspacePath: string
  /** Immutable checkout/git boundary for a dynamic-workflow worktree agent.
   * Its workspaceRoot moves only the agent's file view; workspacePath remains
   * the host identity for hooks, thread data, memory and the agent registry. */
  worktreeIsolation?: WorkflowWorktreeIsolationBoundary
  /** Extra content appended to the system prompt (e.g. HEARTBEAT.md context) */
  extraSystemPrompt?: string
  /** Plugin-provided runtime context for skill artifact paths and feature bindings. */
  pluginPromptInject?: string
  /** Optional plugin output directory exposed to hook commands as PLUGIN_OUTPUT_DIR. */
  pluginOutputDir?: string
  /** Optional system identifier exposed to child processes and hooks as SYSTEM_ID. */
  systemId?: string
  /** Harness plugin root exposed to child processes as PLUGIN_ROOT. */
  pluginRoot?: string
  /** Harness plugin identifier exposed to child processes as PLUGIN_ID. */
  pluginId?: string
  /** Harness plugin display name exposed to child processes as PLUGIN_NAME. */
  pluginName?: string
  /** Harness plugin workspace exposed to child processes as PLUGIN_WORKSPACE. */
  pluginWorkspace?: string
  /** Harness feature identifier exposed to child processes as FEATURE_ID. */
  featureId?: string
  /** Project-level Harness sessions use the same runtime prompt/tool policy as project mode. */
  isHarnessProjectSession?: boolean
  /** Harness project stable id exposed to child processes as HARNESS_PROJECT_ID. */
  harnessProjectId?: string
  /** Bound adapter name exposed to child processes as HARNESS_ADAPTER_NAME. */
  harnessAdapterName?: string
  /** Bound adapter version exposed to child processes as HARNESS_ADAPTER_VERSION. */
  harnessAdapterVersion?: string
  /** Current harness workflow node/stage name exposed to child processes as HARNESS_NODE_NAME. */
  harnessNodeName?: string
  /** Current harness workflow node/stage status exposed to child processes as HARNESS_NODE_STATUS. */
  harnessNodeStatus?: string
  /** Harness project code exposed to child processes as PROJECT_CODE. */
  projectCode?: string
  /** Harness project directory exposed to child processes as PROJECT_DIR. */
  projectDir?: string
  /** Skip the manage_scheduler tool (used by scheduled task / heartbeat execution to prevent recursive scheduling) */
  noSchedulerTool?: boolean
  /** Skip the manage_skill tool (disable skill evolution for scheduled/heartbeat agents) */
  noSkillEvolutionTool?: boolean
  /** Enable the interactive user-input tool. Only foreground, user-invoked runs should set this. */
  enableRequestUserInput?: boolean
  /** Frozen request_user_input policy for a Harness project feature session. */
  requestUserInputConfig?: HarnessRequestUserInputConfig
  /** Load workspace AGENTS.md hierarchy into the main system prompt. */
  enableAgentsPrompt?: boolean
  /** Project-mode Solo selection of bundled and explicit user-format subagents. */
  subagentConfig?: HarnessProjectModeSubagentConfig
  /** Optional Harness project AGENTS.md prompt appended without changing workspace AGENTS.md loading. */
  harnessAgentsPrompt?: string
  /** Optional Harness project AGENTS.md load status returned by the plugin. */
  agentmdLoadStatus?: HarnessAgentmdLoadStatusItem[]
  /** Additional project-mode workspace roots whose AGENTS.md files should be loaded by framework fallback. */
  additionalAgentsWorkspacePaths?: string[]
  /** Project-mode deploy unit metadata for additional workspace AGENTS.md load status display. */
  additionalAgentsWorkspaceMappings?: HarnessDeployUnitMapping[]
  /** Project-mode callback for reporting final AGENTS.md load status and preview. */
  onAgentsPromptLoadStatus?: (payload: AgentsPromptLoadStatusPayload) => void
  /** Test/debug hook: captures the final system prompt passed to LangChain. */
  onFinalSystemPrompt?: (prompt: string) => void
  /** Skip injecting MEMORY.md into the system prompt (the memory_search/memory_get
   * tools stay available). Used by read-only agentType leaves (Explore/Plan) —
   * mirrors Claude Code, whose Explore/Plan omitClaudeMd and whose built-in agents
   * inject no memory (it's per-agent opt-in via frontmatter, which they don't set). */
  disableMemoryInjection?: boolean
  /** Effective per-session memory switch. Child runtimes inherit this because
   * worker thread ids may not have persisted thread metadata. */
  memoryEnabled?: boolean
  /** Turn-scoped internal coordinator context injected only into the main coordinator prompt. */
  coordinatorTurnPrompt?: string
  /** Explicit /skill selection parsed from the current coordinator turn, if any. */
  coordinatorSelectedSkill?: CoordinatorSelectedSkill
  /** Explicit user-selected /skill preserved for notification-driven worker follow-ups. */
  coordinatorExplicitSelectedSkill?: CoordinatorSelectedSkill
  /** notification_id -> selected skill map for the current coordinator notification turn. */
  coordinatorNotificationSelectedSkills?: Record<string, CoordinatorSelectedSkill | undefined>
  /** Shared per-turn worker planning counters, reused across failover runtime rebuilds. */
  coordinatorWorkerTurnPlanning?: CoordinatorWorkerTurnPlanningState
  /** Runtime mode. "normal" preserves the existing agent; "coordinator" enables async worker orchestration. */
  agentMode?: AgentMode
  /** Parent/root trace context used to link async worker and workflow subagent traces. */
  traceContext?: TraceContext
  /** Solo-mode sidecar that records each synchronous task subagent as its own linked trace. */
  soloTaskTraceManager?: SoloTaskTraceManager
  /** Disable the synchronous deepagents task tool for leaf runtimes such as coordinator async workers. */
  disableSubagents?: boolean
  /** Optional filesystem access limits for leaf runtimes: coordinator async
   * workers (workload/ownedFiles) or registry agents (disallowedTools/shellAccess). */
  filesystemAccess?: CoordinatorWorkerFilesystemAccess
  /** AbortSignal — when signalled, any running child process is killed immediately. */
  abortSignal?: AbortSignal
  /** Optional hooks invoked when the model fetch layer retries / resolves. */
  retryHooks?: ModelRetryHooks
  /** Max fetch attempts (1 initial + N-1 retries). Caller may vary this based
   *  on routing mode — pinned mode benefits from more retries since there is
   *  no failover fallback, while auto-routing can retry less and failover more. */
  maxRetryAttempts?: number
  /** Callback invoked after each hook executes — used to emit results to the renderer. */
  onHookResult?: HookResultCallback
  /** Callback invoked when repeated tool failures should be shown to the user. */
  onFailureFuseNotice?: FailureFuseNoticeCallback
  /** Foreground-only callback for the main agent's context compaction lifecycle. */
  onContextCompaction?: ContextCompactionLifecycleCallback
  /**
   * Hook-result sink for coordinator workers. Workers run detached/async so
   * their hooks must be delivered on a durable channel rather than the spawning
   * turn's run stream (which `onHookResult` targets and which closes when the
   * turn ends). When set, coordinator workers use this instead of `onHookResult`
   * for all hook records; falls back to `onHookResult` when unset.
   */
  onCoordinatorWorkerHookResult?: HookResultCallback
  /** Coordinator async worker updates for renderer/UI observability. */
  onCoordinatorWorkerEvent?: (event: {
    worker: CoordinatorWorkerSnapshot
    workers?: CoordinatorWorkerSnapshot[]
    notification?: string
    stream?: { mode: "messages" | "values"; data: unknown }
    suppressNotificationAutoRun?: boolean
  }) => void
  onCoordinatorNotificationAction?: (notificationIds: string[]) => void
  /** Renderer user message id that owns this chat turn, used to group hook logs. */
  hookTurnId?: string
  /**
   * Tool-loop state lifecycle. Foreground runtimes default to hookTurnId;
   * detached workers and workflow leaves supply an independently owned id.
   */
  actionStationarityTurnId?: string
  /** Factory for diagnostic "matched but scope-filtered" hook rows. */
  onHookSkippedFactory?: (event: HookEvent) => ScopeSkipCallback | undefined
  /** Run-scoped plugin/skill activation state for hook resolution. */
  hookScope?: HookScopeController
  /** Shared run-scoped set used to avoid firing skill lifecycle hooks twice. */
  skillHookKeys?: Set<string>
  /** Run-scoped tracker for skills used this turn. */
  skillUseTracker?: SkillUseTracker
  /** Callback invoked after successful write/edit/upload filesystem operations. */
  onFileMutation?: (filePath: string, kind: AgentFileMutationKind) => void
  /** Extra tools appended to the runtime tool list (e.g. a workflow subagent's structured_output). */
  additionalTools?: DynamicStructuredTool[]
  /**
   * Overrides the tool-concurrency queue id. Tools sharing a queue serialize
   * their EXCLUSIVE operations (write_file/edit_file/writing execute) via a
   * module-level lock. Workflow subagents pass the parent thread id so their
   * file writes serialize across the whole run — parallel agents can't clobber
   * the same file — while reads still run concurrently. Defaults to the
   * runtime's own thread id (per-runtime isolation, the original behavior).
   */
  toolConcurrencyQueueId?: string
  /**
   * Auto-approve file edits (write_file/edit_file) without per-file prompts,
   * while still gating shell execution. Dynamic-workflow subagents set this:
   * the user approved the whole workflow at launch, so its background agents
   * editing many files must not re-prompt per file (official acceptEdits).
   */
  autoApproveFileEdits?: boolean
}

// Create agent runtime with configured model and checkpointer
export type AgentRuntime = ReturnType<typeof createAgent>

export async function createAgentRuntime(options: CreateAgentRuntimeOptions): Promise<DeepAgent> {
  const {
    threadId,
    agentId,
    approvalThreadId: requestedApprovalThreadId,
    workspacePath,
    modelId,
    extraSystemPrompt,
    coordinatorTurnPrompt,
    pluginPromptInject,
    pluginOutputDir,
    systemId,
    pluginRoot,
    pluginId,
    pluginName,
    pluginWorkspace,
    featureId,
    isHarnessProjectSession,
    harnessProjectId,
    harnessAdapterName,
    harnessAdapterVersion,
    harnessNodeName,
    harnessNodeStatus,
    projectCode,
    projectDir,
    retryHooks,
    maxRetryAttempts,
    coordinatorWorkerTurnPlanning,
    enableAgentsPrompt = true,
    subagentConfig,
    harnessAgentsPrompt,
    agentmdLoadStatus,
    additionalAgentsWorkspacePaths,
    additionalAgentsWorkspaceMappings,
    onAgentsPromptLoadStatus,
    onFinalSystemPrompt,
    disableMemoryInjection = false,
    memoryEnabled: inheritedMemoryEnabled,
    agentMode = "normal",
    traceContext,
    soloTaskTraceManager,
    disableSubagents = false,
    onHookResult,
    onFailureFuseNotice,
    onContextCompaction,
    onCoordinatorWorkerHookResult,
    onCoordinatorWorkerEvent,
    onCoordinatorNotificationAction,
    hookTurnId,
    actionStationarityTurnId = hookTurnId,
    onHookSkippedFactory,
    hookScope: providedHookScope,
    skillHookKeys,
    skillUseTracker,
    onFileMutation
  } = options
  const approvalThreadId = requestedApprovalThreadId ?? threadId
  const isCoordinatorMode = agentMode === "coordinator"
  const isWorkflowMode = agentMode === "workflow"
  const outputStyle =
    agentMode === "normal"
      ? resolveAgentOutputStyle(options.outputStyle, options.conciseModeEnabled === true)
      : DEFAULT_AGENT_OUTPUT_STYLE
  const mainSubagentsEnabled = !isCoordinatorMode && !disableSubagents

  if (!threadId) {
    throw new Error("Thread ID is required for checkpointing.")
  }

  if (!workspacePath) {
    throw new Error(
      "Workspace path is required. Please select a workspace folder before running the agent."
    )
  }

  // The directory this agent's FILE TOOLS are rooted at. Equal to workspacePath for
  // every ordinary runtime; a private git worktree for an isolated workflow agent.
  // Host-side derivations (hooks, thread data, memory, registry, adoption) keep
  // using workspacePath; the validated isolation boundary owns the file root.
  const fileRoot = options.worktreeIsolation?.workspaceRoot ?? workspacePath
  if (options.worktreeIsolation) {
    console.log("[Runtime] Isolated file root:", fileRoot, "(host workspace:", workspacePath + ")")
  }

  const runtimeThreadMetadata: Record<string, unknown> = (() => {
    try {
      const threadRow = getThread(threadId)
      return threadRow?.metadata ? (JSON.parse(threadRow.metadata) as Record<string, unknown>) : {}
    } catch {
      console.warn("[Runtime] Failed to parse thread metadata for memory settings")
      return {}
    }
  })()
  const memoryEnabledForThread =
    inheritedMemoryEnabled ?? isThreadMemoryEnabled(runtimeThreadMetadata)
  const runtimePolicy = createRuntimePromptToolPolicy({
    featureId,
    isHarnessProjectSession,
    agentMode,
    memoryEnabled: memoryEnabledForThread
  })
  const projectModeSoloSubagentConfig =
    runtimePolicy.isProjectMode && agentMode === "normal" ? subagentConfig : undefined

  console.log("[Runtime] Creating agent runtime...")
  console.log("[Runtime] Thread ID:", threadId)
  console.log("[Runtime] Workspace path:", workspacePath)
  console.log("[Runtime] Agent mode:", agentMode)
  if (runtimePolicy.isProjectMode) {
    console.log(`[Runtime] Project mode subagents enabled: ${mainSubagentsEnabled}`)
    const memoryEnvValue =
      (import.meta.env[PROJECT_MODE_MEMORY_ENV] as string | undefined) ?? "<unset>"
    console.log(
      `[Runtime] Project mode memory enabled: ${isProjectModeMemoryEnabled()} (${PROJECT_MODE_MEMORY_ENV}=${memoryEnvValue})`
    )
  }
  const hookScope = providedHookScope ?? createHookScope()
  // Coordinator mode: the coordinator never "uses" a skill itself (it has no
  // filesystem/tools and only delegates to workers), so a user's explicit
  // slash-selected skill would otherwise never activate any scope. Treat that
  // explicit selection as a main-agent activation here — activating the skill
  // (and its owning plugin, when it has one) on the coordinator's hookScope so
  // every worker spawned this turn inherits it via createInheritedHookScope.
  // Only the explicit slash selection counts, not auto-routed skills.
  if (isCoordinatorMode && options.coordinatorExplicitSelectedSkill) {
    const sel = options.coordinatorExplicitSelectedSkill
    const ownerPluginId = resolvePluginIdForSkillPath(sel.skillPath)
    hookScope.activateSkill(sel.skillName, ownerPluginId, sel.skillPath)
  }
  const resolveHooksForContext = (event: HookEvent, context: HookContext) =>
    resolveEnabledHooksForRun(
      workspacePath,
      event,
      context,
      hookScope,
      onHookSkippedFactory?.(event)
    )

  const customConfig = modelId ? getModelConfigByRef(modelId) : getAvailableModelConfigOrDefault()
  if (!customConfig) {
    throw new Error("Custom model not configured. Please configure a model in Settings.")
  }

  const model = getModelInstance(customConfig, retryHooks, maxRetryAttempts)
  const contextCompactionModel = getModelInstance(
    customConfig,
    retryHooks,
    maxRetryAttempts,
    "context-compaction"
  )
  const projectThreadDataDirectory = await getProjectThreadDataDirectory(workspacePath, threadId)
  const conversationHistoryPathPrefix = path.join(
    projectThreadDataDirectory,
    "conversation_history"
  )
  const legacyConversationHistoryPathPrefix = path.join(
    workspacePath,
    ".cmbdevclaw",
    "conversation_history"
  )
  const largeToolResultsDir = path.join(projectThreadDataDirectory, "large_tool_results")
  console.log("[Runtime] Model instance created")
  console.log("[Runtime] Conversation history directory:", conversationHistoryPathPrefix)
  console.log("[Runtime] Large tool results directory:", largeToolResultsDir)

  // Open agent-type registry → deepagents task-tool subagents for the Solo main
  // agent. Gated to the Solo main agent ONLY: coordinator (agentMode
  // "coordinator") and the workflow orchestrator (agentMode "workflow") are
  // excluded, as is every leaf runtime (workflow/coordinator subagents run with
  // disableSubagents=true). This keeps requirement-2 (coordinator untouched) and
  // routes workflow agent-types through their own Level-1 path, not here.
  const resolveRegistryModelInstance = (
    profileModel?: string
  ): ReturnType<typeof getModelInstance> | undefined => {
    if (!profileModel) return undefined
    // Normalize the `custom:` prefix the same way the main model (selectedModelId
    // above) and the workflow agentType path (workflow/subagent.ts prepends
    // `custom:`, then the runtime slices it) do. Without this, a profile
    // `model: custom:foo` resolves fine under a workflow agentType but SILENTLY
    // inherits the main model for a Solo task subagent.
    const lookup = stripCustomModelPrefix(profileModel)
    const cfg = getModelConfigByRef(profileModel) ?? getModelConfigByRef(lookup)
    if (!cfg) {
      console.warn(
        `[Runtime] Registry agent model "${profileModel}" not found in model configs; inheriting main model.`
      )
      return undefined
    }
    try {
      return getModelInstance(cfg, retryHooks, maxRetryAttempts)
    } catch (error) {
      console.warn(
        `[Runtime] Registry agent model "${profileModel}" failed to init; inheriting main model:`,
        error
      )
      return undefined
    }
  }
  const registrySubagentSpecs =
    agentMode === "normal" && !disableSubagents
      ? loadAgentProfiles(workspacePath, projectModeSoloSubagentConfig).map((profile) => ({
          name: profile.name,
          description: profile.description,
          systemPrompt: profile.systemPrompt,
          disallowedTools: profile.disallowedTools,
          shellAccess: profile.shellAccess,
          model: resolveRegistryModelInstance(profile.model)
        }))
      : []

  const checkpointer = await getCheckpointer(threadId)
  console.log("[Runtime] Checkpointer ready for thread:", threadId)

  const maxTokens = customConfig?.maxTokens ?? DEFAULT_MAX_TOKENS
  const configuredMaxOutputTokens = customConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
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
      join(app.getAppPath(), "..", "resources")
    ]
    const matches = await Promise.all(
      candidates.map(async (candidate) =>
        (await pathExists(join(candidate, "bin"))) ? candidate : null
      )
    )
    resourceBase =
      matches.find((candidate): candidate is string => Boolean(candidate)) ??
      resolve(__dirname, "../../resources")
  }
  const rgDir = join(resourceBase, "bin", process.platform)
  const rgBin = join(rgDir, process.platform === "win32" ? "rg.exe" : "rg")
  const rgExists = await pathExists(rgBin)
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
  const codexExists = process.platform === "win32" && (await pathExists(codexExePath))
  // Worktrees follow the user's normal sandbox setting. The independent checkout,
  // file root and Git guard remain active when it is "none"; a configured Codex
  // sandbox adds defense in depth but is not required to use worktree isolation.
  const windowsSandbox = process.platform === "win32" ? getWindowsSandboxMode() : "none"
  console.log(
    `[Runtime] codex.exe: ${codexExePath}, exists: ${codexExists}, sandboxMode: ${windowsSandbox}`
  )

  const baseHooks = getEnabledHooks(workspacePath)
  console.log(`[Runtime] Loaded ${baseHooks.length} base enabled hooks`)

  const backend = new LocalSandbox({
    // File tools are rooted in the independent checkout. Shell starts there and
    // keeps the worktree Git guard; the user's configured OS sandbox, if any,
    // remains an additional execution policy rather than a worktree prerequisite.
    rootDir: fileRoot,
    agentId,
    worktreeIsolation: options.worktreeIsolation,
    virtualMode: false,
    // Native Git in an isolated worktree runs through the normal shell path.
    // Reuse the existing worktree operation timeout so large adds, filters and
    // repository hooks do not regress to the ordinary agent's 60-second limit.
    timeout: options.worktreeIsolation ? getWorkflowWorktreeTimeoutMs() : 60_000,
    maxOutputBytes,
    windowsSandbox,
    codexExePath: codexExists ? codexExePath : undefined,
    hookResolver: resolveHooksForContext,
    hookScope,
    onHookResult,
    onFailureFuseNotice,
    hookTurnId,
    pluginOutputDir,
    systemId,
    pluginRoot,
    pluginId,
    pluginName,
    pluginWorkspace,
    featureId,
    harnessProjectId,
    harnessAdapterName,
    harnessAdapterVersion,
    harnessNodeName,
    harnessNodeStatus,
    projectCode,
    projectDir,
    onFileMutation,
    abortSignal: options.abortSignal,
    runId: threadId,
    largeToolResultsDir,
    internalArtifactRoots: [conversationHistoryPathPrefix, largeToolResultsDir],
    skillHookKeys,
    skillUseTracker
  })
  const isolatedWorkspaceHookContext: Pick<
    HookContext,
    "workspaceHookCwd" | "forceSyncWorkspaceHooks"
  > = options.worktreeIsolation
    ? {
        workspaceHookCwd: fileRoot,
        forceSyncWorkspaceHooks: true
      }
    : {}

  // Read-only runtimes (registry shellAccess "read_only" OR coordinator workload
  // "read_only") gate execute per-command via isReadOnlyShellCommand. The tool
  // layer checks the agent-issued command, but a PreToolUse hook can rewrite it
  // after that check — so also enforce on the EFFECTIVE command inside the
  // sandbox. (Same predicate as the customExecute gate above.)
  if (
    options.filesystemAccess?.shellAccess === "read_only" ||
    options.filesystemAccess?.workload === "read_only"
  ) {
    backend.setReadOnlyShellEnforced(true)
  }

  // ── Wire up the approval orchestrator ──
  const yoloMode = getYoloMode()
  // Keep approval IPC available even in YOLO mode. YOLO skips the initial shell/file
  // approval, but escaping the sandbox after a sandbox denial still needs explicit
  // one-shot user approval, matching Codex's retry-without-sandbox flow.
  // Approval requests are a human safety gate: they should not auto-reject just
  // because the user stepped away. They are resolved by an explicit user
  // decision, or by the run abort signal when the user stops/cancels the turn.
  const APPROVAL_TIMEOUT_MS: number | null = null
  const requestApproval = (req: ApprovalRequest): Promise<ApprovalDecision> => {
    // IPC fires immediately; the renderer owns the queue (pendingApprovals[]).
    // Multiple concurrent tool calls each register their own resolver here —
    // the renderer shows them one at a time, but the events are not serialized
    // back-end side. This matches how Codex surfaces ExecApprovalRequest events.
    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false
      let attentionRaised = false
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const rejectDecision = (): ApprovalDecision => ({
        type: "reject",
        tool_call_id: req.tool_call?.id ?? req.id
      })
      const cleanup = (): void => {
        if (timeoutId) clearTimeout(timeoutId)
        options.abortSignal?.removeEventListener("abort", onAbort)
      }
      const resolveOnce = (decision: ApprovalDecision): void => {
        if (settled) return
        settled = true
        cleanup()
        pendingApprovals.delete(req.id)
        if (attentionRaised) {
          attentionRaised = false
          emitAppAttention({
            action: "resolve",
            kind: "approval",
            threadId: approvalThreadId,
            key: `approval:${req.id}`
          })
        }
        resolve(decision)
      }
      const rejectPending = (reason: "timeout" | "abort"): void => {
        if (pendingApprovals.has(req.id)) {
          console.warn(`[Orchestrator] approval request ${reason}: reqId=${req.id}`)
          const channel =
            reason === "timeout"
              ? `approval:timeout:${approvalThreadId}`
              : `approval:cancel:${approvalThreadId}`
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(channel, { requestId: req.id, reason })
          }
          resolveOnce(rejectDecision())
        }
      }

      const onAbort = (): void => {
        rejectPending("abort")
      }

      if (options.abortSignal?.aborted) {
        resolve({ type: "reject", tool_call_id: req.tool_call?.id ?? req.id })
        return
      }

      if (APPROVAL_TIMEOUT_MS !== null) {
        timeoutId = setTimeout(() => rejectPending("timeout"), APPROVAL_TIMEOUT_MS)
      }

      pendingApprovals.set(req.id, {
        resolve: (decision: ApprovalDecision) => {
          resolveOnce(decision)
        },
        request: req,
        threadId: approvalThreadId,
        // The runtime's own thread (subagent `__wf_…` for a workflow leaf), so
        // hasPendingWorkflowApproval can tell which workflow run is blocked.
        runtimeThreadId: threadId,
        targetWebContentsIds: BrowserWindow.getAllWindows().map((w) => w.webContents.id)
      })
      options.abortSignal?.addEventListener("abort", onAbort, { once: true })
      if (options.abortSignal?.aborted) {
        onAbort()
        return
      }
      console.log(
        `[Orchestrator] sending approval request on channel: approval:request:${approvalThreadId}, reqId=${req.id}, runtimeThreadId=${threadId}, command=${req.command}`
      )
      attentionRaised = true
      emitAppAttention({
        kind: "approval",
        threadId: approvalThreadId,
        key: `approval:${req.id}`
      })
      // Fire Notification hook — agent is now waiting on user input.
      // Fire-and-forget so it doesn't delay the UI prompt.
      const notificationContext: HookContext = {
        toolName: req.tool_call?.name,
        toolArgs: { command: req.command, reason: req.reason, filePath: req.filePath },
        workspacePath,
        sessionId: approvalThreadId,
        agentId,
        turnId: hookTurnId,
        pluginOutputDir,
        systemId,
        pluginWorkspace,
        featureId,
        harnessProjectId,
        harnessAdapterName,
        harnessAdapterVersion,
        harnessNodeName,
        harnessNodeStatus,
        projectCode,
        projectDir,
        ...isolatedWorkspaceHookContext,
        // PR-01: exposed to hooks as PERMISSION_MODE env / permission_mode JSON.
        // Lets a Notification hook know whether the user is in YOLO mode (where
        // approvals only fire for sandbox-escape) vs the default approve flow.
        permissionMode: yoloMode ? "yolo" : "approve",
        // PR-16 follow-up — CC matcher target for Notification is
        // `notification_type`. The approval queue is the only Notification
        // fire path today, so the value is always "permission_prompt".
        notificationType: "permission_prompt"
      }
      runHooks(
        resolveHooksForContext("Notification", notificationContext),
        "Notification",
        notificationContext,
        onHookResult
      ).catch((e) => console.warn("[Hooks] Notification hook error:", e))
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(`approval:request:${approvalThreadId}`, req)
      }
    })
  }

  const approvalStore = getOrCreateApprovalStore(approvalThreadId)

  const rawExecute = (
    command: string,
    sandboxMode?: string,
    cwd?: string
  ): Promise<import("deepagents").ExecuteResponse> => {
    return backend.executeRaw(command, sandboxMode, undefined, undefined, { cwd })
  }

  const orchestrator = new ToolOrchestrator(
    approvalStore,
    rawExecute,
    requestApproval,
    yoloMode,
    options.autoApproveFileEdits === true,
    !options.worktreeIsolation,
    workspacePath
  )
  backend.setOrchestrator(orchestrator)

  // The background-exec guidance ("use run_in_background for builds/installs/
  // tests/codegen") must only be injected when the runtime can ACTUALLY run those:
  //  - execute removed (shellAccess "none" registry agents, scoped write workers)
  //    → it would document a tool they don't have; AND
  //  - read_only runtimes → they KEEP execute but isReadOnlyShellCommand BLOCKS
  //    builds/installs/tests, so the guidance would steer the agent into commands
  //    the gate rejects (contradicting its access prompt). Suppress it there too.
  // The main agent (no filesystemAccess), verify, and whole-workspace write keep it.
  const executeToolAvailable = options.filesystemAccess
    ? !blockedToolNamesForAccess(options.filesystemAccess).has("execute")
    : true
  const isReadOnlyRuntime =
    options.filesystemAccess?.shellAccess === "read_only" ||
    options.filesystemAccess?.workload === "read_only"
  // The prompt must name the directory the agent actually works in, or an isolated
  // agent would be told the host workspace is its root and write outside its
  // worktree (the sandbox would refuse, so it would just fail confusingly).
  let systemPrompt = getSystemPrompt(fileRoot, windowsSandbox, {
    includeBackgroundExec: executeToolAvailable && !isReadOnlyRuntime,
    includeSubagents: mainSubagentsEnabled,
    includeMemory: runtimePolicy.includeMemory,
    includeCurrentTime: runtimePolicy.includeCurrentTime
  })
  let agentsPrompt: AgentsPromptRuntimeResult = {
    type: "workspace",
    prompt: null,
    projectRoot: fileRoot,
    loadedPaths: [],
    truncated: false
  }
  const normalizedHarnessAgentsPrompt = harnessAgentsPrompt?.trim()
  const normalizedHarnessAgentmdLoadStatus = Array.isArray(agentmdLoadStatus)
    ? agentmdLoadStatus
    : []
  const shouldLoadWorkspaceAgentsPrompt = enableAgentsPrompt && !normalizedHarnessAgentsPrompt
  let agentsPromptLoader: AgentsPromptLoader | undefined
  let agentsPromptLoadStatusItems: HarnessAgentmdLoadStatusItem[] = []
  if (shouldLoadWorkspaceAgentsPrompt) {
    const frameworkAdditionalAgentsWorkspacePaths = additionalAgentsWorkspacePaths ?? []
    agentsPrompt =
      frameworkAdditionalAgentsWorkspacePaths.length > 0 || onAgentsPromptLoadStatus
        ? await loadAgentsPromptForWorkspaces(
            {
              // AGENTS.md is tracked content, so an isolated agent reads the copy
              // on ITS branch — the conventions that apply to the code it edits.
              primaryWorkspacePath: fileRoot,
              additionalWorkspacePaths: frameworkAdditionalAgentsWorkspacePaths,
              includeGlobal: true
            },
            {
              globalMaxBytes: DEFAULT_GLOBAL_AGENTS_MAX_BYTES,
              projectMaxBytes: DEFAULT_AGENTS_MAX_BYTES,
              totalMaxBytes: DEFAULT_AGENTS_MAX_BYTES
            }
          )
        : await loadAgentsPromptForWorkspace(fileRoot, {
            globalMaxBytes: DEFAULT_GLOBAL_AGENTS_MAX_BYTES,
            projectMaxBytes: DEFAULT_AGENTS_MAX_BYTES,
            totalMaxBytes: DEFAULT_AGENTS_MAX_BYTES
          })
    agentsPromptLoader = "cmbdevclaw"
    agentsPromptLoadStatusItems = applyDeployUnitMappingsToAgentmdLoadStatus(
      buildAgentsPromptLoadStatusItems(agentsPrompt),
      additionalAgentsWorkspaceMappings
    )
    if (agentsPrompt.prompt) {
      console.log("[Runtime] Loaded AGENTS.md files:", agentsPrompt.loadedPaths)
      if (agentsPrompt.truncated) {
        console.warn("[Runtime] AGENTS.md content exceeded prompt budget and was truncated:", {
          globalMaxBytes: DEFAULT_GLOBAL_AGENTS_MAX_BYTES,
          projectMaxBytes: DEFAULT_AGENTS_MAX_BYTES,
          totalMaxBytes: DEFAULT_AGENTS_MAX_BYTES
        })
      }
    } else {
      console.log("[Runtime] No AGENTS.md files discovered for workspace:", fileRoot)
    }
  } else if (enableAgentsPrompt && normalizedHarnessAgentsPrompt) {
    console.log(
      "[Runtime] Workspace AGENTS.md prompt injection suppressed by Harness AGENTS.md prompt"
    )
  } else {
    console.log("[Runtime] AGENTS.md prompt injection disabled for this runtime")
  }
  if (normalizedHarnessAgentsPrompt) {
    agentsPromptLoader = "plugin"
    agentsPromptLoadStatusItems = normalizedHarnessAgentmdLoadStatus
    console.log("[Runtime] Loaded Harness AGENTS.md prompt")
  }
  const rawCombinedAgentsPrompt =
    [agentsPrompt.prompt, normalizedHarnessAgentsPrompt].filter(Boolean).join("\n\n") || undefined
  const renderedPluginPromptInject = renderPluginPromptInject(pluginPromptInject)
  const combinedAgentsPrompt = rawCombinedAgentsPrompt
    ? renderAgentsInstructionsPrompt(rawCombinedAgentsPrompt)
    : undefined
  if (renderedPluginPromptInject) {
    systemPrompt += "\n\n" + renderedPluginPromptInject
  }
  if (combinedAgentsPrompt) {
    systemPrompt += "\n\n" + combinedAgentsPrompt
  }
  const resolvedProjectContextPrompt =
    [renderedPluginPromptInject, combinedAgentsPrompt].filter(Boolean).join("\n\n") || undefined
  if (
    onAgentsPromptLoadStatus &&
    agentsPromptLoader &&
    (agentsPromptLoadStatusItems.length > 0 || resolvedProjectContextPrompt)
  ) {
    onAgentsPromptLoadStatus({
      items: agentsPromptLoadStatusItems,
      loader: agentsPromptLoader,
      promptPreview: resolvedProjectContextPrompt
    })
  }
  if (extraSystemPrompt) {
    systemPrompt += "\n\n" + extraSystemPrompt
  }

  const isWindows = process.platform === "win32"
  const platform = isWindows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"
  const { name: shell, isBashLike, isPowerShell } = getShellInfo(windowsSandbox)
  const timeContext = getRuntimeTimeContext()
  const userInfo = getUserInfo()
  const userInfoPrompt = `## Current user's employee identity information
- sap编号、员工编号:${userInfo?.sapId}
- yst编号、一事通编号: ${userInfo?.ystId}
- userName、员工姓名: ${userInfo?.userName}
- originOrgId、员工机构号: ${userInfo?.originOrgId}
- orgName、员机构号名称: ${userInfo?.orgName}
- ystCode、一事通code: ${userInfo?.ystCode}`
  const filesystemTimeContextLines = renderRuntimeTimeContextLines(timeContext, {
    includeCurrentTime: runtimePolicy.includeCurrentTime,
    includeTimestampRule: runtimePolicy.includeTimestampRule
  })
  const subagentShellGuidance = isBashLike
    ? "- Use Unix/bash commands for shell operations (ls, cat, grep, etc.)"
    : isPowerShell
      ? `- **CRITICAL: Commands run in PowerShell (not bash).** Use \`; \` instead of \`&&\`, \`$env:VAR\` instead of \`$VAR\`, \`-and\`/\`-or\` instead of \`&&\`/\`||\`. NEVER use bash syntax.`
      : "- Use cmd.exe syntax for shell commands (e.g., dir instead of ls, type instead of cat)\n- Use && to chain commands, use ^ for line continuation, use %VAR% for environment variables"

  const filesystemSystemPrompt = `\n\nYou have access to a filesystem. All file paths use fully qualified absolute system paths.
### System Environment
- Operating system: ${platform} (${process.arch})
- Default shell: ${shell}
${filesystemTimeContextLines}
${subagentShellGuidance}

### Available Tools
- ls: list files in a directory (e.g., ls("${fileRoot}"))
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem
- glob: find files matching a pattern (e.g., "**/*.py")
- grep: search for literal text within files (NOT regex). Do NOT use "|", ".*" or other regex syntax — call grep once per term instead.
The workspace root is: ${fileRoot}`

  const skillLifecycleRootSources = await getEnabledSkillsSources()
  const skillsSources = await getEnabledSkillMiddlewareSources()
  console.log(
    "[Runtime] Raw skills sources from getEnabledSkillsSources():",
    skillLifecycleRootSources
  )
  console.log("[Runtime] Raw skills sources count:", skillLifecycleRootSources.length)
  console.log(
    "[Runtime] Raw skills sources content:",
    JSON.stringify(skillLifecycleRootSources, null, 2)
  )
  console.log("[Runtime] Skill middleware sources:", skillsSources)

  // Merge plugin skills sources
  const pluginSkillSourceMetadata = getEnabledPluginSkillSourceMetadata()
  const pluginSkillsSources = await getEnabledPluginSkillMiddlewareSources()
  console.log("[Runtime] Plugin skills sources:", pluginSkillsSources)
  console.log("[Runtime] Plugin skills sources count:", pluginSkillsSources.length)

  const allSkillsSources = combineSkillMiddlewareSources(skillsSources, pluginSkillsSources)
  const skillLifecycleSources = [...skillLifecycleRootSources, ...pluginSkillSourceMetadata]
  backend.setHiddenSkillDirs(getDisabledSkillDirs())
  backend.setSkillLifecycleRegistry(
    skillLifecycleSources.length > 0 ? new SkillLifecycleRegistry(skillLifecycleSources) : undefined
  )
  console.log("[Runtime] All skills sources combined:", allSkillsSources)
  console.log("[Runtime] All skills sources count:", allSkillsSources.length)
  console.log("[Runtime] Skills sources:", skillsSources, "Plugin skills:", pluginSkillsSources)

  // Initialize memory system (gated by global setting + current thread opt-in)
  let memoryTools: ReturnType<typeof createMemorySearchTool | typeof createMemoryGetTool>[] = []
  let memorySources: string[] | undefined
  if (runtimePolicy.includeMemory) {
    const memoryDirs = resolveWorkspaceMemoryDirs(workspacePath)
    const globalStore = await getMemoryStore(memoryDirs.global.dir)
    const projectStore = memoryDirs.project ? await getMemoryStore(memoryDirs.project.dir) : null
    const storesForSearch = projectStore ? [projectStore, globalStore] : [globalStore]
    memoryTools = [createMemorySearchTool(storesForSearch), createMemoryGetTool(storesForSearch)]
    memorySources = [
      join(memoryDirs.global.dir, "MEMORY.md"),
      ...(memoryDirs.project ? [join(memoryDirs.project.dir, "MEMORY.md")] : [])
    ]
    console.log("[Runtime] Memory initialized:", {
      globalDir: memoryDirs.global.dir,
      projectDir: memoryDirs.project?.dir ?? null,
      projectId: memoryDirs.project?.projectId ?? null
    })
  } else if (runtimePolicy.isProjectMode) {
    console.log("[Runtime] Memory disabled for project mode feature:", featureId)
  } else {
    console.log("[Runtime] Memory disabled for this session")
  }

  const capabilityService = createScopedMcpCapabilityService(
    getGlobalMcpCapabilityService(),
    hookScope,
    resolveHooksForContext,
    onHookResult,
    onFailureFuseNotice,
    {
      workspacePath,
      threadId,
      agentId,
      pluginOutputDir,
      systemId,
      pluginWorkspace,
      featureId,
      harnessProjectId,
      harnessAdapterName,
      harnessAdapterVersion,
      harnessNodeName,
      harnessNodeStatus,
      projectCode,
      projectDir,
      turnId: hookTurnId,
      ...isolatedWorkspaceHookContext
    }
  )
  // "Constrained" coordinator workers = the workload-based read_only/verify/scoped
  // workers. They keep EAGER MCP but withhold the deferred bridge + code_exec (see
  // the branch below). The whole-workspace write worker and registry agents
  // (explicit denylist/shell mode — workflow agentTypes) are NOT constrained and
  // keep everything. MCP discovery is app-level cached (one shared connect), so
  // keeping eager MCP costs only the eager tools' schema tokens, not fan-out
  // latency — matching CC subagents (which inherit MCP) and the Solo/workflow
  // read-only baseline (eager MCP kept, deferred bridge cut).
  const isConstrainedCoordinatorWorker =
    Boolean(options.filesystemAccess) &&
    !isExplicitToolAccess(options.filesystemAccess) &&
    (options.filesystemAccess?.workload === "read_only" ||
      options.filesystemAccess?.workload === "verify" ||
      (options.filesystemAccess?.ownedFiles?.length ?? 0) > 0)
  const codeExecEnabled = isCodeExecEnabled()
  let allMcpTools: McpCapabilityTool[] = []
  let codeExecRouteEnabled = false
  let eagerMcpMetadata: McpCapabilityTool[] = []
  let lazyMcpMetadata: McpCapabilityTool[] = []
  const deferredSavedTools =
    !isConstrainedCoordinatorWorker && codeExecEnabled && runtimePolicy.includeSavedCodeExecTools
      ? listSavedCodeExecTools()
      : []
  let mcpTools: ReturnType<typeof createEagerMcpTools> = []
  let toolSearchTools: unknown[] = []

  if (isConstrainedCoordinatorWorker) {
    // Keep EAGER MCP (a structured single tool call, bounded by the MCP server's
    // own permissions — safe for a restricted worker, and matching CC subagents +
    // the Solo/workflow read-only baseline which both keep eager MCP). WITHHOLD the
    // deferred bridge (search_tool/inspect_tool/invoke_deferred_tool — the last can
    // run saved code) and ad-hoc code_exec (arbitrary execution), which would
    // defeat the read-only/verify/scoped restriction. So: discover + eager only —
    // no lazy catalogue, no toolSearchTools, codeExecRouteEnabled stays false.
    allMcpTools = await capabilityService.listTools()
    eagerMcpMetadata = allMcpTools.filter((tool) => tool.visibility === "eager")
    mcpTools = createEagerMcpTools(capabilityService, eagerMcpMetadata, {
      workspacePath,
      threadId: options.threadId
    })
    console.log(
      "[Runtime] Constrained coordinator worker: keeping",
      eagerMcpMetadata.length,
      "eager MCP tools (deferred bridge + code_exec withheld)"
    )
  } else {
    allMcpTools = await capabilityService.listTools()
    // Disable ad hoc code_exec authoring in Agent Team and project mode. Saved tools remain
    // available through the deferred-tool bridge when code exec is enabled.
    codeExecRouteEnabled =
      codeExecEnabled && allMcpTools.length > 0 && runtimePolicy.includeCodeExecRoute
    eagerMcpMetadata = allMcpTools.filter((tool) => tool.visibility === "eager")
    lazyMcpMetadata = allMcpTools.filter((tool) => tool.visibility === "lazy")
    mcpTools = createEagerMcpTools(capabilityService, eagerMcpMetadata, {
      workspacePath,
      threadId: options.threadId
    })
    toolSearchTools = await createToolSearchTools(
      capabilityService,
      { workspacePath, threadId: options.threadId },
      {
        codeExecRouteEnabled,
        savedToolsEnabled: codeExecEnabled
      }
    )

    if (allMcpTools.length > 0) {
      console.log(
        "[Runtime] MCP tools loaded, eager:",
        eagerMcpMetadata.length,
        "lazy:",
        lazyMcpMetadata.length
      )
    } else {
      console.log("[Runtime] No MCP tools available in capability service")
    }
  }

  type RuntimeTool = {
    name?: string
    func?: unknown
    invoke?: unknown
  }
  const extraTools: RuntimeTool[] = []
  if (options.enableRequestUserInput) {
    extraTools.push(
      createRequestUserInputTool({
        threadId: options.threadId,
        abortSignal: options.abortSignal,
        requestUserInputConfig: options.requestUserInputConfig
      })
    )
  }
  if (!options.noSchedulerTool && !runtimePolicy.isProjectMode) {
    let chatxRobotChatId: string | null = null
    if (options.threadId) {
      try {
        const threadRow = getThread(options.threadId)
        if (threadRow?.metadata) {
          const meta = JSON.parse(threadRow.metadata)
          chatxRobotChatId = (meta.chatxRobotChatId as string) || null
        }
      } catch {
        /* ignore */
      }
    }
    extraTools.push(
      createSchedulerTool({
        workspacePath,
        modelId: options.modelId,
        threadId: options.threadId,
        chatxRobotChatId
      })
    )
  }
  if (!options.noSkillEvolutionTool) {
    extraTools.push(createSkillEvolutionTool({ threadId: options.threadId }))
  }

  // Conditionally inject Java LSP tool
  try {
    const lspConfig = getLspConfig()
    // LSP indexes the sources the agent edits, so it follows the file root.
    if (lspConfig.enabled && detectJavaProject(fileRoot)) {
      extraTools.push(createLspTool({ workspacePath: fileRoot }))
      console.log("[Runtime] Java LSP tool injected for:", fileRoot)
    }
  } catch (e) {
    console.warn("[Runtime] Failed to check LSP config:", e)
  }

  // Wrap extra tools so that errors are returned as strings instead of throwing
  function wrapToolErrors(tools: RuntimeTool[]): void {
    for (const t of tools) {
      if (typeof t.func === "function") {
        const originalFunc = t.func
        t.func = async (...args: unknown[]) => {
          try {
            return await Reflect.apply(originalFunc, t, args)
          } catch (e: unknown) {
            if (isWorkflowStructuredOutputFatalError(e)) throw e
            const msg = e instanceof Error ? e.message : String(e)
            const level = e instanceof TypeError || e instanceof ReferenceError ? "error" : "warn"
            console[level](`[Runtime] Tool "${t.name}" error (non-fatal):`, msg)
            return msg
          }
        }
      }
      if (typeof t.invoke === "function") {
        const originalInvoke = t.invoke
        t.invoke = async (...args: unknown[]) => {
          try {
            return await Reflect.apply(originalInvoke, t, args)
          } catch (e: unknown) {
            if (
              isHookHaltError(e) ||
              isFailureFuseHaltError(e) ||
              isWorkflowStructuredOutputFatalError(e)
            )
              throw e
            const msg = e instanceof Error ? e.message : String(e)
            const level = e instanceof TypeError || e instanceof ReferenceError ? "error" : "warn"
            console[level](`[Runtime] Tool "${t.name}" error (non-fatal):`, msg)
            return msg
          }
        }
      }
    }
  }
  if (options.additionalTools?.length) {
    extraTools.push(...(options.additionalTools as unknown as RuntimeTool[]))
  }

  if (isWorkflowMode) {
    const worktreeSubagentThreads = new Set<string>()
    // Dynamic Workflows: the model writes a JS orchestration script; the run
    // executes in the BACKGROUND (detached from this turn — the manager owns
    // its abort), each agent() runs as a one-shot leaf runtime on its own
    // checkpoint thread, and approvals surface on this (parent) thread's UI
    // via approvalThreadId — mirroring coordinator async workers.
    extraTools.push(
      createWorkflowTool({
        threadId,
        workspacePath,
        modelId,
        // Run-before approval gate (aligns with Claude Code's "Review dynamic
        // workflow before running"): the model writing a workflow can fan out
        // many file-editing subagents and spend real tokens, so the user
        // confirms once (Approve / Approve-session / Reject) before launch.
        yoloMode,
        approvalStore,
        requestApproval,
        // Run-level exclusive file-write lock keyed on this (parent) threadId — the
        // SAME lock the run's subagent tool writes use (toolConcurrencyQueueId =
        // threadId). Injected so a script writeFile() and a concurrent agent()'s
        // tool write serialize TOGETHER, not each in its own silo. (#2)
        runExclusiveFileWrite: <T>(fn: () => Promise<T>): Promise<T> =>
          getToolConcurrencyLock(threadId).write(fn),
        subagentDeps: {
          traceContext,
          createRuntime: async (subagentOptions): Promise<WorkflowSubagentRuntime> => {
            // read_only AND none are both restricted roles → skip AGENTS.md +
            // MEMORY.md (CC omitClaudeMd parity). Only full (write/verify) keeps
            // them; `none` (a no-shell CC-style agent, e.g. tools: Read) must not
            // get MORE context than read_only. undefined ⇒ full (filesystemAccess
            // defaults `?? "full"` below), so it still keeps them.
            const restrictedRole =
              subagentOptions.shellAccess === "read_only" || subagentOptions.shellAccess === "none"
            // An `isolation: "worktree"` agent works inside a private checkout. Only
            // its FILE ROOT moves — `workspacePath` below stays the run's workspace
            // so hook configuration, thread data, memory, and registries keep the
            // same project identity. The hook scripts needed by relative workspace
            // hook commands are materialized into the private checkout at creation.
            const worktreeIsolation = subagentOptions.worktreeIsolation
            const subagentFileRoot = worktreeIsolation?.workspaceRoot ?? workspacePath
            const subagentRuntime = await createAgentRuntime({
              threadId: subagentOptions.threadId,
              agentId: subagentOptions.agentId,
              actionStationarityTurnId: subagentOptions.threadId,
              approvalThreadId: threadId,
              workspacePath,
              ...(worktreeIsolation ? { worktreeIsolation } : {}),
              modelId: subagentOptions.modelId,
              extraSystemPrompt: subagentOptions.extraSystemPrompt,
              noSchedulerTool: true,
              noSkillEvolutionTool: true,
              // agentType leaves keep skills (CC subagents can invoke project/user
              // skills via the Skill tool — here that's the injected skill catalogue
              // + read_file). read-only roles (Explore/Plan) skip BOTH AGENTS.md and
              // MEMORY.md — this mirrors CC's omitClaudeMd, which drops the whole
              // claudeMd channel (CLAUDE.md + the user's auto-MEMORY.md ride together
              // in userContext.claudeMd by default, tengu_moth_copse off). Write/
              // verify (full shell) keep both: a write-capable subagent inherits
              // claudeMd in CC. memory_search/memory_get tools stay available either way.
              enableAgentsPrompt: !restrictedRole,
              disableMemoryInjection: restrictedRole,
              memoryEnabled: memoryEnabledForThread,
              agentMode: "normal",
              disableSubagents: true,
              // agentType-resolved tool policy. Cuts the disallowed tools and
              // enforces the shell policy via the same filesystemAccess path
              // coordinator workers use (explicit denylist mode) — the workflow
              // Level-1 hard tool cut. read_only shell is gated per-command in
              // createFsMiddleware's execute via isReadOnlyShellCommand.
              ...(subagentOptions.disallowedTools !== undefined ||
              subagentOptions.shellAccess !== undefined
                ? {
                    filesystemAccess: {
                      disallowedTools: subagentOptions.disallowedTools ?? [],
                      shellAccess: subagentOptions.shellAccess ?? "full",
                      // The access boundary must be the agent's OWN root, not the
                      // host workspace: for an isolated agent the two differ, and
                      // using the host here would widen the boundary to a tree the
                      // agent is not supposed to touch.
                      workspacePath: subagentFileRoot
                    }
                  }
                : {}),
              abortSignal: subagentOptions.abortSignal,
              retryHooks,
              maxRetryAttempts,
              hookScope: createInheritedHookScope(hookScope),
              onHookResult,
              onFailureFuseNotice,
              hookTurnId,
              additionalTools: subagentOptions.additionalTools,
              // Subagents SHARING the workspace share the parent thread's tool-
              // concurrency queue so their file writes serialize across the run (no
              // two parallel agents clobber the same file); reads still run
              // concurrently. Also serializes with any foreground edit the user
              // makes on this thread while the run is in flight.
              //
              // An ISOLATED agent gets its own queue, keyed on its worktree. Its
              // writes cannot collide with anything outside that directory, so
              // holding the shared lock would serialize a fan-out that is safe to
              // run in parallel — which is the entire point of asking for a
              // worktree. Writes WITHIN one worktree stay serialized, because the
              // key is the worktree and one worktree hosts exactly one agent.
              toolConcurrencyQueueId: worktreeIsolation?.workspaceRoot ?? threadId,
              // acceptEdits: the user approved the whole workflow at launch, so
              // its background subagents must not re-prompt per file edit
              // (shell execution stays gated).
              autoApproveFileEdits: true
            })
            if (worktreeIsolation) worktreeSubagentThreads.add(subagentOptions.threadId)
            return subagentRuntime as unknown as WorkflowSubagentRuntime
          },
          cleanupThread: async (workflowThreadId: string): Promise<void> => {
            clearActionStationarityTurn(workflowThreadId, workflowThreadId)
            // Kill any run_in_background tasks the subagent started so they don't
            // outlive the run (coordinator workers cancel theirs the same way via
            // cancelBackgroundTasks — without this a backgrounded process leaks
            // CPU/memory/file writes after the workflow completes or is cancelled).
            const processCleanupResults = worktreeSubagentThreads.delete(workflowThreadId)
              ? await Promise.allSettled([
                  LocalSandbox.cancelBackgroundTasksAndWait(workflowThreadId)
                ])
              : (LocalSandbox.cancelBackgroundTasks(workflowThreadId), [])
            for (const result of processCleanupResults) {
              if (result.status === "rejected") {
                console.warn("[Workflow] Subagent process cleanup error:", result.reason)
              }
            }
            // Release resources after any worktree-specific process drain.
            const resourceCleanupResults = await Promise.allSettled([
              LocalSandbox.revokeGrantedAclsForRun(workflowThreadId),
              closeCheckpointer(workflowThreadId)
            ])
            for (const result of resourceCleanupResults) {
              if (result.status === "rejected") {
                console.warn("[Workflow] Subagent cleanup error:", result.reason)
              }
            }
            // Workflow subagent threads are one-shot (retries use a fresh id);
            // drop the checkpoint sqlite so a 1000-agent run doesn't leave a
            // thousand dead files in the threads directory.
            try {
              deleteThreadCheckpoint(workflowThreadId)
            } catch (error) {
              console.warn("[Workflow] Subagent checkpoint delete failed:", error)
            }
          },
          isRetryableApiError,
          // A run is "awaiting approval" while any of its subagent threads has a
          // pending approval. Matches on the subagent's runtime thread (the entry's
          // routing threadId is the PARENT, which is why the earlier threadId-prefix
          // check was always false). The engine passes its own runId so the check is
          // scoped to THIS run (two concurrent runs on one parent thread must not
          // share watchdog state). The engine's inactivity watchdog uses this to NOT
          // abort a run merely waiting for an absent user to answer a prompt.
          hasPendingApproval: (runId?: string): boolean =>
            hasPendingWorkflowApproval(threadId, runId)
        }
      }) as unknown as RuntimeTool
    )
  }

  wrapToolErrors(extraTools)
  wrapToolErrors(memoryTools as RuntimeTool[])

  if (toolSearchTools.length > 0) {
    wrapToolErrors(toolSearchTools as RuntimeTool[])
  }

  if (codeExecRouteEnabled) {
    extraTools.push(
      createCodeExecTool({
        workspacePath,
        threadId: options.threadId,
        modelId: options.modelId,
        yoloMode,
        capabilityService,
        approvalStore,
        requestApproval
      })
    )
  }

  const toolHookExclusions = new Set<string>([
    "ls",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
    "execute",
    "task_output",
    "search_tool",
    "inspect_tool",
    "invoke_deferred_tool",
    ...eagerMcpMetadata.map((tool) => tool.toolId)
  ])
  const toolHookMiddleware = createToolHookMiddleware({
    workspacePath,
    threadId: options.threadId,
    agentId,
    hookScope,
    resolveHooksForContext,
    onHookResult,
    onFailureFuseNotice,
    hookTurnId,
    systemId,
    pluginWorkspace,
    featureId,
    harnessProjectId,
    harnessAdapterName,
    harnessAdapterVersion,
    harnessNodeName,
    harnessNodeStatus,
    projectCode,
    projectDir,
    ...isolatedWorkspaceHookContext,
    skipToolNames: toolHookExclusions,
    onToolFailureDecision: hookTurnId
      ? ({ toolName, toolCallId, toolArgs, signal }) =>
          recordToolFailure({
            threadId: options.threadId,
            turnId: hookTurnId,
            toolName,
            toolCallId,
            toolArgs,
            signal,
            mode: getFailureFuseMode()
          })
      : undefined,
    onToolSuccess: hookTurnId
      ? ({ toolName, toolArgs }) =>
          recordToolSuccess({
            threadId: options.threadId,
            turnId: hookTurnId,
            toolName,
            toolArgs
          })
      : undefined
  })

  const deferredToolIds = [
    ...lazyMcpMetadata.map((tool) => tool.toolId),
    ...deferredSavedTools.map((tool) => tool.toolId)
  ]

  const finalTools = filterCoordinatorWorkerFinalTools(
    [...mcpTools, ...memoryTools, ...extraTools, ...toolSearchTools],
    options.filesystemAccess
  )
  const hasNamedTool = (name: string): boolean => {
    return finalTools.some((tool) => (tool as { name?: string }).name === name)
  }
  const hasSearchTool = hasNamedTool("search_tool")
  const hasInspectTool = hasNamedTool("inspect_tool")
  const hasInvokeDeferredTool = hasNamedTool("invoke_deferred_tool")
  const hasCodeExecTool = hasNamedTool("code_exec")

  if (hasSearchTool && hasInspectTool && hasInvokeDeferredTool) {
    console.log("[Runtime] Added deferred tool workflow prompt")
  } else if (hasInspectTool) {
    console.log("[Runtime] Added inspect_tool prompt")
  }
  if (hasCodeExecTool) {
    console.log("[Runtime] Added code_exec prompt")
  }

  const coordinatorPluginPromptInject = pluginPromptInject?.trim()
  const coordinatorProjectInstructions = [combinedAgentsPrompt, extraSystemPrompt]
    .filter(Boolean)
    .join("\n\n")
  const coordinatorWorkerProjectInstructions = runtimePolicy.isProjectMode
    ? [resolvedProjectContextPrompt, extraSystemPrompt].filter(Boolean).join("\n\n")
    : [
        combinedAgentsPrompt,
        coordinatorPluginPromptInject
          ? `### Skills Runtime Context\n\n${coordinatorPluginPromptInject}`
          : "",
        extraSystemPrompt
      ]
        .filter(Boolean)
        .join("\n\n")

  const emitCoordinatorWorkerEvent = (event: CoordinatorWorkerUpdateEvent): void => {
    if (!isCoordinatorMode || !onCoordinatorWorkerEvent) return
    onCoordinatorWorkerEvent({
      worker: event.worker,
      notification: event.notification,
      stream: event.stream,
      suppressNotificationAutoRun: event.suppressNotificationAutoRun
    })
  }

  const mergeCoordinatorWorkerUsage = (
    previous: CoordinatorWorkerTokenUsage | undefined,
    next: CoordinatorWorkerTokenUsage | undefined
  ): CoordinatorWorkerTokenUsage | undefined => {
    if (!next) return previous
    const merged: CoordinatorWorkerTokenUsage = { ...(previous ?? {}) }
    for (const key of [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "cache_read_tokens",
      "cache_creation_tokens"
    ] as const) {
      const value = next[key]
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        merged[key] = Math.max(merged[key] ?? 0, value)
      }
    }
    return Object.keys(merged).length > 0 ? merged : undefined
  }

  const coordinatorWorkerRunner: CoordinatorWorkerRunner = async (workerInput) => {
    const workerActionStationarityTurnId = `${workerInput.workerThreadId}:turn:${workerInput.workerTurn}`
    const workerSubagent = buildCoordinatorWorkerSubagents(
      coordinatorWorkerProjectInstructions || undefined,
      undefined,
      threadId,
      timeContext
    ).find((agentConfig) => agentConfig.name === workerInput.role)
    const workerRolePrompt =
      typeof workerSubagent?.systemPrompt === "string"
        ? workerSubagent.systemPrompt
        : `You are the ${workerInput.role} worker in CmbCowork Coordinator Mode.`
    const ownedFilesLine =
      workerInput.ownedFiles.length > 0
        ? `- owned_files: ${workerInput.ownedFiles.join(", ")}\n`
        : ""
    const scratchpadDir = getCoordinatorScratchpadDir(workerInput.parentThreadId)
    const workerAccessPrompt = (() => {
      if (workerInput.workload === "read_only") {
        return "Access limits: read-only worker. You can inspect files, search, and run read-only shell commands via execute (e.g. ls, git log, git diff, find, cat, head, tail). The execute tool has a safety gate that blocks clearly-dangerous and unrecognized commands, but do NOT rely on it to catch everything — restrict yourself to read-only inspection: never use the shell for writes — no mkdir/touch/rm/cp/mv, no git add/commit/push, no package installs (npm/pip/etc.), no builds, and no redirect operators (>, >>, |) or heredocs. write_file, edit_file, and the deferred-tool bridge (search/inspect/invoke_deferred) are unavailable. Eager MCP tools (if any are connected) ARE available for direct single-tool calls."
      }
      if (workerInput.workload === "verify") {
        return "Access limits: verifier worker. You can inspect files, run validation commands, and use available browser automation skills/tools for UI/runtime verification when present, but write_file, edit_file, and the deferred-tool bridge (search/inspect/invoke_deferred) are unavailable. Eager MCP tools (if any are connected) ARE available for direct single-tool calls. Do not create, modify, or delete files in the project workspace. If a temporary script or harness is necessary, write it only under /tmp or $TMPDIR and clean it up."
      }
      if (workerInput.ownedFiles.length > 0) {
        return `Access limits: scoped write worker. write_file and edit_file are limited to owned_files (${workerInput.ownedFiles.join(", ")}). execute, task_output, and the deferred-tool bridge (search/inspect/invoke_deferred) are unavailable, so do not claim to have run shell or deferred-tool checks. Eager MCP tools (if any are connected) ARE available for direct single-tool calls. File edits may still require explicit user approval; if write_file or edit_file is denied/blocked, do not loop the same call and instead report the blocking file/action back to the coordinator.`
      }
      return "Access limits: write worker. You may edit workspace files as needed for the assigned implementation. File edits may still require explicit user approval; if write_file or edit_file is denied/blocked, do not loop the same call and instead report the blocking file/action back to the coordinator."
    })()
    const scratchpadGuidance =
      workerInput.workload === "write"
        ? "For long-running work, you may write concise durable notes under scratchpad_dir when future workers need shared context. Treat scratchpad_dir like any other workspace artifact: normal tool availability, approval, hook, and access limits still apply."
        : "If the coordinator points you to scratchpad_dir, you may inspect it with available read tools. Do not write scratchpad notes unless your available tools and access policy explicitly allow it."
    const workerMetadataPrompt = `Async coordinator worker metadata:
- parent_thread_id: ${workerInput.parentThreadId}
- worker_id: ${workerInput.workerId}
- worker_thread_id: ${workerInput.workerThreadId}
- worker_role: ${workerInput.role}
- worker_workload: ${workerInput.workload}
${ownedFilesLine.trimEnd()}
- worker_description: ${workerInput.description}
- scratchpad_dir: ${scratchpadDir}

${workerAccessPrompt}

Use the same worker thread context for follow-up instructions. ${scratchpadGuidance} Return a concise handoff with output files, commands run, evidence, risks, and verifier notes when applicable.`

    console.log("[CoordinatorWorker] run turn", {
      parentThreadId: workerInput.parentThreadId,
      workerId: workerInput.workerId,
      workerThreadId: workerInput.workerThreadId,
      role: workerInput.role,
      workload: workerInput.workload,
      ownedFiles: workerInput.ownedFiles
    })

    const MAX_WORKER_RAW_TEXT_CHARS = 200_000
    const truncateWorkerRawText = (text: string): string => {
      if (text.length <= MAX_WORKER_RAW_TEXT_CHARS) return text
      return `${text.slice(0, MAX_WORKER_RAW_TEXT_CHARS)}\n...(raw worker output truncated)`
    }
    let finalText = ""
    let messageModeFinalText = ""
    let messageModeAssistantText = ""
    let messageModeAssistantTextTruncated = false
    let workerReasoning = ""
    let tokenUsage: CoordinatorWorkerTokenUsage | undefined
    const seenWorkerToolCallKeys = new Set<string>()
    const workerToolNames = new Set<string>()
    let workerToolCallCount = 0
    const workerSkillUsageDetector = new SkillUsageDetector()
    let workerTracer: TraceCollector | undefined
    let workerTraceTerminalRecorded = false
    let workerTraceOutcome: TraceOutcome = "success"
    let workerTraceError: string | undefined
    const syncWorkerSkillAttribution = (): void => {
      if (!workerTracer) return
      const usedSkills = workerSkillUsageDetector.getUsedSkillNames()
      const skillSource = workerSkillUsageDetector.getUsedSkillSourceRefs()
      workerTracer.setUsedSkills(usedSkills)
      workerTracer.setSkillSource(skillSource)
      workerTracer.setEvolvedSkills(workerSkillUsageDetector.getUsedEvolvedSkillNames())
      setAdoptionContext(workerInput.workerThreadId, { usedSkills, skillSource })
    }
    const cancelWorkerBackgroundTasks = (): void => {
      LocalSandbox.cancelBackgroundTasks(workerInput.workerThreadId)
    }
    workerInput.abortSignal.addEventListener("abort", cancelWorkerBackgroundTasks, { once: true })
    // Workers run detached/async; route their hook records through the durable
    // worker-hook sink so they survive past the spawning turn's run stream
    // (which `onHookResult` targets). Falls back to `onHookResult` when no
    // durable sink was provided.
    const baseWorkerOnHookResult = onCoordinatorWorkerHookResult ?? onHookResult
    const workerOnHookResult: HookResultCallback | undefined = baseWorkerOnHookResult
      ? (event, hook, result) => {
          const hookWithWorkerContext = {
            ...hook,
            parentThreadId: workerInput.parentThreadId,
            workerId: workerInput.workerId,
            workerThreadId: workerInput.workerThreadId,
            workerTurn: workerInput.workerTurn
          } as typeof hook & {
            parentThreadId: string
            workerId: string
            workerThreadId: string
            workerTurn: number
          }
          baseWorkerOnHookResult(event, hookWithWorkerContext, result)
        }
      : undefined
    // Coordinator harness identity inherited by every worker runtime below, so
    // worker hooks AND execute child-process env match the main session (both
    // derive from these LocalSandbox/runtime options). SESSION_ID intentionally
    // stays the worker thread id and is not part of this bundle.
    const workerHarnessContext = {
      agentId: workerInput.workerId,
      systemId,
      pluginRoot,
      pluginId,
      pluginName,
      pluginWorkspace,
      featureId,
      isHarnessProjectSession,
      harnessProjectId,
      harnessAdapterName,
      harnessAdapterVersion,
      harnessNodeName,
      harnessNodeStatus,
      projectCode,
      projectDir,
      pluginOutputDir,
      hookTurnId
    }

    try {
      if (workerInput.abortSignal.aborted) {
        throw new DOMException("Coordinator worker aborted before runtime creation", "AbortError")
      }
      const effectiveWorkerPrompt = await applyWorkerPromptSubmitHooks({
        prompt: workerInput.prompt,
        sessionId: workerInput.workerThreadId,
        agentId: workerInput.workerId,
        workspacePath,
        onHookResult: workerOnHookResult,
        isolatedHookContext: isolatedWorkspaceHookContext,
        metadata: {
          coordinatorWorkerId: workerInput.workerId,
          coordinatorWorkerRole: workerInput.role,
          coordinatorWorkerThreadId: workerInput.workerThreadId
        }
      })
      const workerRoutingResult = await resolveModel({
        taskSource: "chat",
        message: effectiveWorkerPrompt,
        threadId: workerInput.workerThreadId,
        requestedModelId: modelId,
        routingMode: getGlobalRoutingMode()
      }).catch(() => null)
      const workerOrderedChain = buildOrderedChain(
        workerRoutingResult?.resolvedModelId ?? modelId,
        workerRoutingResult?.fallbackChain,
        workerRoutingResult?.resolvedTier ?? "premium",
        workerRoutingResult?.layer !== "pinned"
      )
      if (traceContext) {
        workerTracer = createTraceCollectorSafely(
          workerInput.workerThreadId,
          effectiveWorkerPrompt,
          workerRoutingResult?.resolvedModelId ?? modelId ?? "unknown",
          {
            traceKind: "subagent",
            executionMode: "coordinator",
            rootTraceId: traceContext.rootTraceId,
            rootThreadId: traceContext.rootThreadId,
            parentTraceId: traceContext.traceId,
            parentThreadId: traceContext.threadId,
            parentSpanId: traceContext.rootNodeId,
            linkType: "async_span_link",
            subagentKind: "coordinator_worker",
            subagentRunId: `${workerInput.workerId}:turn:${workerInput.workerTurn}`,
            subagentThreadId: workerInput.workerThreadId,
            handoffAction: workerInput.workerTurn > 1 ? "continue_worker" : "start_worker",
            handoffSourceAgent: "coordinator",
            handoffTargetAgent: workerInput.role,
            coordinatorWorkerId: workerInput.workerId,
            coordinatorWorkerTurn: workerInput.workerTurn,
            coordinatorWorkerRole: workerInput.role,
            coordinatorWorkerWorkload: workerInput.workload,
            harnessFeature: traceContext.harnessFeature,
            includeSkillEval: false
          },
          "CoordinatorWorker"
        )
      }
      const streamConfig = {
        configurable: { thread_id: workerInput.workerThreadId },
        callbacks: [],
        signal: workerInput.abortSignal,
        streamMode: ["messages", "values"] as ("messages" | "values")[],
        recursionLimit: getAgentGraphRecursionLimit()
      }
      const consumeWorkerStream = async (stream: AsyncIterable<unknown>): Promise<void> => {
        for await (const chunk of stream) {
          if (workerInput.abortSignal.aborted) break
          const [mode, data] = chunk as unknown as [string, unknown]
          if (mode === "messages" || mode === "values") {
            workerInput.onProgress({
              type: "stream",
              stream: { mode: mode as "messages" | "values", data }
            })
          }
          const valuesContext = createWorkerValuesSnapshotContext(mode, data, effectiveWorkerPrompt)
          runTraceSideEffect("CoordinatorWorker Skill observer", () => {
            if (observeWorkerSkillUsage(mode, data, workerSkillUsageDetector, valuesContext)) {
              syncWorkerSkillAttribution()
            }
          })
          observeWorkerProgress(
            mode,
            data,
            seenWorkerToolCallKeys,
            (event) => {
              if (event.type === "tool_call") {
                workerToolCallCount += 1
                if (event.toolName) {
                  workerToolNames.add(event.toolName)
                }
              }
              workerInput.onProgress(event)
            },
            effectiveWorkerPrompt,
            valuesContext
          )
          tokenUsage = mergeCoordinatorWorkerUsage(
            tokenUsage,
            extractWorkerUsage(mode, data, effectiveWorkerPrompt, valuesContext)
          )
          if (workerTracer) {
            runTraceSideEffect("CoordinatorWorker reasoning observer", () => {
              const reasoning = extractWorkerVisibleReasoning(
                mode,
                data,
                effectiveWorkerPrompt,
                valuesContext
              )
              if (reasoning?.text) {
                if (reasoning.isDelta && isTraceReasoningTruncated(workerReasoning)) return
                workerReasoning = truncateReasoningForTrace(
                  reasoning.isDelta
                    ? mergeStreamingReasoning(workerReasoning, reasoning.text)
                    : reasoning.text
                )
              }
            })
          }
          const extracted = extractWorkerFinalText(mode, data, effectiveWorkerPrompt, valuesContext)
          if (shouldClearWorkerFinalText(mode, data, effectiveWorkerPrompt, valuesContext)) {
            messageModeAssistantText = ""
            messageModeFinalText = ""
            messageModeAssistantTextTruncated = false
            finalText = ""
          }
          if (extracted) {
            if (isWorkerFinalTextDelta(mode, data)) {
              if (!messageModeAssistantTextTruncated) {
                const nextAssistantText = `${messageModeAssistantText}${extracted}`
                messageModeAssistantText = truncateWorkerRawText(nextAssistantText)
                messageModeAssistantTextTruncated =
                  nextAssistantText.length > MAX_WORKER_RAW_TEXT_CHARS
              }
              messageModeFinalText = messageModeAssistantText
              finalText = messageModeFinalText
            } else {
              finalText = truncateWorkerRawText(extracted)
              if (mode === "messages") {
                messageModeAssistantText = finalText
                messageModeFinalText = finalText
                messageModeAssistantTextTruncated = extracted.length > MAX_WORKER_RAW_TEXT_CHARS
              }
            }
          }
        }
      }

      let workerAgent: DeepAgent | null = null
      let workerStream: AsyncIterable<unknown> | null = null
      let usedWorkerModelId = workerRoutingResult?.resolvedModelId ?? modelId

      // Inherit the coordinator's plugin/skill activation scope so plugin- and
      // skill-scoped hooks (e.g. a plugin's edit_file PreToolUse) fire inside
      // the worker the same way they see the parent's activations in a task-tool
      // subagent. Workers can run in parallel, so we snapshot the coordinator
      // scope at spawn time into a fresh per-worker scope rather than sharing the
      // mutable instance — that keeps concurrent workers from cross-contaminating
      // each other's activations while still seeing what was active when they
      // launched. Trade-off: activations a worker makes during its run stay local
      // to that worker and are not reflected back to the coordinator.
      const workerHookScope = createInheritedHookScope(hookScope)

      for (const candidateId of workerOrderedChain) {
        if (workerInput.abortSignal.aborted) break
        try {
          workerAgent = await createAgentRuntime({
            threadId: workerInput.workerThreadId,
            actionStationarityTurnId: workerActionStationarityTurnId,
            approvalThreadId: workerInput.parentThreadId,
            workspacePath,
            modelId: candidateId,
            extraSystemPrompt: `${workerRolePrompt}\n\n${workerMetadataPrompt}`,
            noSchedulerTool: true,
            noSkillEvolutionTool: true,
            enableAgentsPrompt: false,
            agentMode: "normal",
            disableSubagents: true,
            filesystemAccess: {
              workload: workerInput.workload,
              ownedFiles: workerInput.ownedFiles,
              workspacePath
            },
            abortSignal: workerInput.abortSignal,
            retryHooks,
            maxRetryAttempts,
            hookScope: workerHookScope,
            memoryEnabled: memoryEnabledForThread,
            ...workerHarnessContext,
            onHookResult: workerOnHookResult,
            onFailureFuseNotice
          })

          workerStream = await workerAgent.stream(
            { messages: [new HumanMessage(effectiveWorkerPrompt)] },
            streamConfig
          )
          usedWorkerModelId = candidateId
          runTraceSideEffect("CoordinatorWorker", () => workerTracer?.setModelId(candidateId))
          break
        } catch (error) {
          if (!isRetryableApiError(error)) throw error
          console.warn(`[CoordinatorWorker][Failover] ${candidateId} failed:`, error)
          if (!workerInput.abortSignal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
      }

      if (workerInput.abortSignal.aborted) {
        throw new DOMException("Coordinator worker aborted before stream start", "AbortError")
      }
      if (!workerAgent || !workerStream) {
        throw new Error("All worker model candidates failed before streaming started.")
      }

      const remainingWorkerCandidates = workerOrderedChain.slice(
        usedWorkerModelId
          ? workerOrderedChain.indexOf(usedWorkerModelId) + 1
          : workerOrderedChain.length
      )
      let activeWorkerStream = workerStream
      while (true) {
        try {
          await consumeWorkerStream(activeWorkerStream)
          break
        } catch (error) {
          if (!isRetryableApiError(error) || remainingWorkerCandidates.length === 0) {
            throw error
          }
          if (workerInput.abortSignal.aborted) throw error

          const failedModelId = usedWorkerModelId ?? "unknown"
          console.warn(`[CoordinatorWorker][Failover] Mid-stream ${failedModelId} failed:`, error)
          if (!workerInput.abortSignal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 500))
          }

          const nextCandidate = remainingWorkerCandidates.shift()!
          workerAgent = await createAgentRuntime({
            threadId: workerInput.workerThreadId,
            actionStationarityTurnId: workerActionStationarityTurnId,
            approvalThreadId: workerInput.parentThreadId,
            workspacePath,
            modelId: nextCandidate,
            extraSystemPrompt: `${workerRolePrompt}\n\n${workerMetadataPrompt}`,
            noSchedulerTool: true,
            noSkillEvolutionTool: true,
            enableAgentsPrompt: false,
            agentMode: "normal",
            disableSubagents: true,
            filesystemAccess: {
              workload: workerInput.workload,
              ownedFiles: workerInput.ownedFiles,
              workspacePath
            },
            abortSignal: workerInput.abortSignal,
            retryHooks,
            maxRetryAttempts,
            hookScope: workerHookScope,
            memoryEnabled: memoryEnabledForThread,
            ...workerHarnessContext,
            onHookResult: workerOnHookResult,
            onFailureFuseNotice
          })
          activeWorkerStream = await workerAgent.stream(null, streamConfig)
          usedWorkerModelId = nextCandidate
          runTraceSideEffect("CoordinatorWorker", () => workerTracer?.setModelId(nextCandidate))
        }
      }

      if (workerInput.abortSignal.aborted) {
        throw new DOMException("Coordinator worker aborted", "AbortError")
      }

      if (!finalText.trim() && workerToolNames.size > 0 && workerAgent) {
        console.log("[CoordinatorWorker] requesting missing final handoff", {
          parentThreadId: workerInput.parentThreadId,
          workerId: workerInput.workerId,
          toolCalls: Array.from(workerToolNames)
        })
        try {
          const handoffMetadataPrompt = `Async coordinator worker handoff metadata:
- parent_thread_id: ${workerInput.parentThreadId}
- worker_id: ${workerInput.workerId}
- worker_thread_id: ${workerInput.workerThreadId}
- worker_role: ${workerInput.role}
- original_worker_workload: ${workerInput.workload}
- handoff_workload: read_only
- worker_description: ${workerInput.description}
- scratchpad_dir: ${scratchpadDir}

Access limits: read-only handoff continuation. Do not modify files, run commands, or call tools. Return only the concise final handoff covering files changed or inspected, commands run and results, remaining risks, and any verification still needed.`
          const handoffAgent = await createAgentRuntime({
            threadId: workerInput.workerThreadId,
            actionStationarityTurnId: workerActionStationarityTurnId,
            approvalThreadId: workerInput.parentThreadId,
            workspacePath,
            modelId: usedWorkerModelId ?? modelId,
            extraSystemPrompt: `${workerRolePrompt}\n\n${handoffMetadataPrompt}`,
            noSchedulerTool: true,
            noSkillEvolutionTool: true,
            enableAgentsPrompt: false,
            agentMode: "normal",
            disableSubagents: true,
            filesystemAccess: {
              workload: "read_only",
              ownedFiles: [],
              workspacePath
            },
            abortSignal: workerInput.abortSignal,
            retryHooks,
            maxRetryAttempts,
            hookScope: workerHookScope,
            memoryEnabled: memoryEnabledForThread,
            ...workerHarnessContext,
            onHookResult: workerOnHookResult,
            onFailureFuseNotice
          })
          const handoffStream = await handoffAgent.stream(
            {
              messages: [
                new HumanMessage(
                  "The previous worker turn completed tool activity but did not provide a final handoff. Do not modify files, run commands, or call tools for this handoff. Reply only with a concise final handoff covering: files changed or inspected, commands run and results, remaining risks, and any verification still needed."
                )
              ]
            },
            streamConfig
          )
          await consumeWorkerStream(handoffStream)
        } catch (error) {
          if (workerInput.abortSignal.aborted || isAbortError(error)) throw error
          const message = describeToolError(error)
          console.warn("[CoordinatorWorker] Missing final handoff request failed:", error)
          finalText = truncateWorkerRawText(
            `Worker completed tool activity but did not provide a final handoff. A follow-up handoff request failed: ${message}. Open the worker tool stream to inspect tool results and changed files.`
          )
        }
      }

      let workerStopHookFailure: string | undefined
      const stopPassed = await runWorkerStopHooksWithRevision({
        sessionId: workerInput.workerThreadId,
        agentId: workerInput.workerId,
        workspacePath,
        abortSignal: workerInput.abortSignal,
        getStopContext: () => ({
          userMessage: effectiveWorkerPrompt,
          assistantResponse: finalText.trim(),
          toolCalls: Array.from(workerToolNames),
          usedSkills: workerSkillUsageDetector.getUsedSkillNames()
        }),
        runRevision: async (revisionPrompt) => {
          if (!workerAgent) {
            throw new Error("Worker runtime is unavailable for Stop hook revision.")
          }
          const revisionStream = await workerAgent.stream(
            { messages: [new HumanMessage(revisionPrompt)] },
            streamConfig
          )
          await consumeWorkerStream(revisionStream)
        },
        sendNotice: (message) => {
          console.log("[CoordinatorWorker][StopHook]", message)
        },
        sendError: (message) => {
          workerStopHookFailure = message
          console.warn("[CoordinatorWorker][StopHook]", message)
        },
        onHookResult: workerOnHookResult,
        isolatedHookContext: isolatedWorkspaceHookContext
      })
      if (!stopPassed) {
        throw new Error(workerStopHookFailure ?? "Stop hook blocked worker completion.")
      }

      const summary = summarizeWorkerText(finalText)
      runTraceSideEffect("CoordinatorWorker", () => {
        if (!workerTracer) return
        workerTracer.addTerminalNode({
          type: "message",
          output: summary,
          metadata: {
            tokenUsage,
            toolNames: Array.from(workerToolNames),
            toolCallCount: workerToolCallCount,
            ...(workerReasoning ? { reasoning: workerReasoning } : {})
          }
        })
        workerTraceTerminalRecorded = true
      })
      return {
        summary,
        rawText: finalText,
        tokenUsage
      }
    } catch (error) {
      workerTraceOutcome =
        workerInput.abortSignal.aborted || isAbortError(error) ? "cancelled" : "error"
      workerTraceError = describeToolError(error)
      throw error
    } finally {
      clearActionStationarityTurn(workerInput.workerThreadId, workerActionStationarityTurnId)
      if (workerTracer) {
        const tracerToFinish = workerTracer
        runTraceSideEffect("CoordinatorWorker", () => {
          if (!workerTraceTerminalRecorded && workerToolCallCount > 0) {
            tracerToFinish.addTerminalNode({
              type: workerTraceOutcome === "cancelled" ? "cancel" : "error",
              output: workerTraceError,
              metadata: {
                tokenUsage,
                toolNames: Array.from(workerToolNames),
                toolCallCount: workerToolCallCount
              }
            })
            workerTraceTerminalRecorded = true
          }
        })
        finishTraceInBackground(
          tracerToFinish,
          workerTraceOutcome,
          workerTraceError,
          "CoordinatorWorker"
        )
      }
      workerInput.abortSignal.removeEventListener("abort", cancelWorkerBackgroundTasks)
      const cleanupResults = await Promise.allSettled([
        Promise.resolve().then(cancelWorkerBackgroundTasks),
        LocalSandbox.revokeGrantedAclsForRun(workerInput.workerThreadId),
        closeCheckpointer(workerInput.workerThreadId)
      ])
      for (const result of cleanupResults) {
        if (result.status === "rejected") {
          console.warn("[CoordinatorWorker] Worker cleanup error:", result.reason)
        }
      }
    }
  }

  const coordinatorWorkerTools = isCoordinatorMode
    ? {
        startWorker: async (input: {
          role: CoordinatorWorkerRole
          workload?: CoordinatorWorkerWorkload
          ownedFiles?: string[]
          description: string
          prompt: string
          selectedSkill?: CoordinatorSelectedSkill
        }) =>
          coordinatorWorkerManager.startWorkerAndPersist({
            parentThreadId: threadId,
            workspacePath,
            role: input.role,
            workload: input.workload,
            ownedFiles: input.ownedFiles,
            description: input.description,
            prompt: injectSelectedSkillIntoWorkerPrompt(input.prompt, input.selectedSkill),
            selectedSkill: input.selectedSkill,
            runner: coordinatorWorkerRunner,
            onUpdate: emitCoordinatorWorkerEvent,
            onUpdateKey: `runtime:${threadId}`
          }),
        continueWorker: async (input: {
          workerId: string
          continuationIntent?: CoordinatorWorkerContinuationIntent
          workload?: CoordinatorWorkerWorkload
          ownedFiles?: string[]
          prompt: string
          selectedSkill?: CoordinatorSelectedSkill
        }) => {
          const selectedSkill =
            input.selectedSkill ??
            (await coordinatorWorkerManager.getWorkerSelectedSkill(threadId, input.workerId))
          return await coordinatorWorkerManager.continueWorkerAndPersist({
            parentThreadId: threadId,
            workerId: input.workerId,
            continuationIntent: input.continuationIntent,
            workload: input.workload,
            ownedFiles: input.ownedFiles,
            prompt: injectSelectedSkillIntoWorkerPrompt(input.prompt, selectedSkill),
            selectedSkill,
            runner: coordinatorWorkerRunner,
            onUpdate: emitCoordinatorWorkerEvent,
            onUpdateKey: `runtime:${threadId}`
          })
        },
        cancelWorker: async (input: { workerId?: string; reason?: string }) => {
          const cancelledWorkers = input.workerId
            ? [
                await coordinatorWorkerManager.cancelWorker(
                  threadId,
                  input.workerId,
                  input.reason,
                  {
                    suppressNotificationAutoRun: true,
                    dismissNotificationOnTerminalPersist: true
                  }
                )
              ]
            : coordinatorWorkerManager.cancelWorkersForThread(
                threadId,
                input.reason ?? "Coordinator requested worker cancellation.",
                {
                  suppressNotificationAutoRun: true,
                  dismissNotificationOnTerminalPersist: true
                }
              )
          await Promise.allSettled(
            cancelledWorkers.map((worker) =>
              coordinatorWorkerManager.waitForWorkers(threadId, {
                workerId: worker.worker_id,
                timeoutMs: 5_000,
                pollIntervalMs: 50,
                waitForCleanup: true
              })
            )
          )
          const workers = coordinatorWorkerManager.readWorkers(threadId)
          const returnedWorkers = input.workerId
            ? workers.filter((worker) => worker.worker_id === input.workerId)
            : workers
          if (onCoordinatorWorkerEvent) {
            const worker = input.workerId
              ? workers.find((item) => item.worker_id === input.workerId)
              : (cancelledWorkers.find((item) => item.status === "cancelled") ??
                cancelledWorkers[0])
            if (worker) {
              onCoordinatorWorkerEvent({
                worker,
                workers
              })
            }
          }
          return returnedWorkers
        }
      }
    : undefined

  const coordinatorWorkerToolsForMain = isCoordinatorMode
    ? createCoordinatorWorkerTools({
        workspacePath,
        threadId,
        workerTools: coordinatorWorkerTools,
        onNotificationsConsumed: onCoordinatorNotificationAction,
        selectedSkill: options.coordinatorSelectedSkill,
        explicitSelectedSkill: options.coordinatorExplicitSelectedSkill,
        notificationSelectedSkills: options.coordinatorNotificationSelectedSkills,
        turnPlanning: coordinatorWorkerTurnPlanning
      })
    : []
  if (coordinatorWorkerToolsForMain.length > 0) {
    wrapToolErrors(coordinatorWorkerToolsForMain as RuntimeTool[])
  }

  if (isCoordinatorMode) {
    systemPrompt = buildCoordinatorSystemPrompt({
      threadId,
      workspacePath,
      platform,
      shell,
      timezone: timeContext.timezone,
      currentTime: timeContext.currentTime,
      includeCurrentTime: runtimePolicy.includeCurrentTime,
      includeTimestampRule: runtimePolicy.includeTimestampRule,
      projectModeAdapterInstructions: coordinatorPluginPromptInject,
      projectInstructions: coordinatorProjectInstructions,
      turnContext: coordinatorTurnPrompt,
      hasCodeExecTool,
      deferredToolIds
    })
  } else {
    if (runtimePolicy.includeInjectedToolUsagePrompt) {
      systemPrompt += renderInjectedToolUsagePrompt({
        hasSearchTool,
        hasInspectTool,
        hasInvokeDeferredTool,
        hasCodeExecTool
      })
    }
    // Only advertise the deferred-tool inventory when the invoke bridge is
    // actually present. A restricted leaf (read_only/none registry agent — e.g. a
    // workflow Explore/Plan) has search/inspect/invoke_deferred removed, yet it is
    // NOT an isConstrainedCoordinatorWorker, so lazy MCP / saved tools still fill
    // deferredToolIds. Listing IDs it can't invoke is misleading noise, so gate on
    // the invoke capability (the bridge tools are cut as a set for read_only/none).
    if (runtimePolicy.includeDeferredToolInventoryPrompt && hasInvokeDeferredTool) {
      systemPrompt += renderAvailableDeferredToolsPrompt(deferredToolIds)
    }
    if (isWorkflowMode) {
      systemPrompt += WORKFLOW_MODE_SYSTEM_PROMPT
    }
  }
  systemPrompt += "\n\n" + userInfoPrompt
  console.log("[Runtime] System prompt summary:", {
    chars: systemPrompt.length,
    hasAgentsPrompt: Boolean(agentsPrompt.prompt),
    agentsFilesLoaded: agentsPrompt.loadedPaths.length,
    hasExtraSystemPrompt: Boolean(extraSystemPrompt),
    hasCoordinatorTurnPrompt: Boolean(coordinatorTurnPrompt),
    agentMode,
    deferredToolIds: deferredToolIds.length
  })
  const triggerTokens = calculateSummarizationTriggerTokens(maxTokens, configuredMaxOutputTokens)
  const mainModelInputBudget = calculateModelInputBudgetTokens(maxTokens, configuredMaxOutputTokens)
  const summaryMaxOutputTokens = Math.min(
    configuredMaxOutputTokens,
    CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS
  )
  const summaryInputBudget = calculateModelInputBudgetTokens(maxTokens, summaryMaxOutputTokens)
  const keepTokens = calculateSummarizationKeepTokens(maxTokens)
  const toolEvictLimit = Math.min(20_000, Math.max(Math.floor(maxTokens * 0.08), 6_000))
  const summaryOverflowRetryTarget = calculateSummaryOverflowRetryTargetTokens(
    maxTokens,
    summaryMaxOutputTokens
  )
  console.log(
    "[Runtime] Context window:",
    maxTokens,
    "→ summarization trigger:",
    triggerTokens,
    "→ reserved model output:",
    configuredMaxOutputTokens,
    "→ model input budget:",
    mainModelInputBudget,
    "→ summary max output:",
    summaryMaxOutputTokens,
    "→ summary input budget:",
    summaryInputBudget,
    "→ keep:",
    keepTokens,
    "→ tool evict limit:",
    toolEvictLimit,
    "→ summary overflow retry target:",
    summaryOverflowRetryTarget,
    "→ max output bytes:",
    maxOutputBytes
  )

  backend.setGitWorkflowCommitOnly(false)
  const mainTools = isCoordinatorMode ? coordinatorWorkerToolsForMain : finalTools
  // Task-tool subagents must not orchestrate workflows of their own.
  const workerTools = finalTools.filter(
    (runtimeTool) => (runtimeTool as { name?: string }).name !== "workflow"
  )
  const coordinatorSubagents: ReturnType<typeof buildCoordinatorWorkerSubagents> = []

  console.log(
    "[Runtime] Final tool list:",
    mainTools.map((t) => (t as { name?: string }).name ?? "(unnamed)")
  )
  if (isCoordinatorMode) {
    console.log(
      "[Runtime] Coordinator worker tool list:",
      workerTools.map((t) => (t as { name?: string }).name ?? "(unnamed)")
    )
    console.log("[CoordinatorMode] runtime configured", {
      threadId,
      mainTools: mainTools.map((t) => (t as { name?: string }).name ?? "(unnamed)"),
      workerToolCount: workerTools.length,
      subagents: coordinatorSubagents.map((agent) => agent.name),
      mainSubagentsEnabled: false,
      mainTodosEnabled: false,
      mainFilesystemEnabled: false,
      mainSkillsEnabled: false,
      mainMemoryEnabled: !disableMemoryInjection && Boolean(memorySources?.length)
    })
  }
  const mainSkillSources =
    !isCoordinatorMode && allSkillsSources.length > 0 ? allSkillsSources : undefined
  // memory is NOT gated by coordinator mode (unlike todos/fs/skills above, which are
  // "doing-work" capabilities a pure orchestrator shouldn't have). The coordinator
  // main agent is the ONLY agent that talks directly to the user, so user-collaboration
  // preferences in MEMORY.md (e.g. "always reply in Chinese") must reach it. This mirrors
  // CC: its coordinator main still carries the user's auto-MEMORY.md via
  // userContext.claudeMd (coordinator only swaps the system prompt, not the user context).
  // Same memory middleware as a normal main agent — injects content only, no tool changes.
  const mainMemorySources =
    !disableMemoryInjection && memorySources?.length ? memorySources : undefined
  const projectModeTaskSubagentsInheritFullContext =
    runtimePolicy.isProjectMode && agentMode === "normal" && !disableSubagents
  const taskSubagentExtraSystemPrompt = projectModeTaskSubagentsInheritFullContext
    ? resolvedProjectContextPrompt
    : combinedAgentsPrompt

  const agent = createDeepAgent({
    model,
    summarizationModel: contextCompactionModel,
    tools: mainTools,
    subagentDefaultTools: workerTools,
    subagents: coordinatorSubagents,
    checkpointer,
    backend,
    systemPrompt,
    outputStyle,
    onFinalSystemPrompt,
    filesystemSystemPrompt,
    subagentExtraSystemPrompt: taskSubagentExtraSystemPrompt,
    subagentExtraSystemPromptForRestrictedRoles: projectModeTaskSubagentsInheritFullContext,
    mainTodosEnabled: !isCoordinatorMode,
    mainFilesystemEnabled: !isCoordinatorMode,
    mainSubagentsEnabled,
    filesystemAccess: options.filesystemAccess,
    registrySubagentSpecs,
    // The runtime's commands execute via the sandbox; on Windows with a sandbox
    // that's PowerShell. Pass that to the read-only execute gate so PS read-only
    // cmdlets aren't false-blocked (matches the shellKind LocalSandbox uses for
    // assessCommandSafety). Off Windows / no sandbox → "unknown" (strict).
    windowsShellKind:
      process.platform === "win32" && windowsSandbox !== "none" ? "powershell" : "unknown",
    taskSystemPrompt: isCoordinatorMode ? buildCoordinatorTaskPrompt(threadId) : TASK_TOOL_PROMPT,
    includeGeneralPurposeSubagent:
      !isCoordinatorMode && isGeneralPurposeSubagentEnabled(projectModeSoloSubagentConfig),
    skills: mainSkillSources,
    memory: mainMemorySources,
    // The orchestrator handles execute/file approval internally via IPC. In YOLO
    // mode it skips initial approvals but still prompts before sandbox escape.
    // If this is ever set to a real interruptOn map, re-check the current-run
    // steer queue: a native LangGraph interrupt ends the invoke handler's stream
    // loop (hits its finally, clearCurrentRunMessageQueue fires) while the run is
    // still awaiting resume, unlike the IPC-based approval above which keeps the
    // run's promise chain alive and doesn't touch the queue.
    interruptOn: undefined,
    summarizationTrigger: { type: "tokens", value: triggerTokens },
    summarizationKeep: { type: "tokens", value: keepTokens },
    toolTokenLimitBeforeEvict: toolEvictLimit,
    trimTokensToSummarize: summaryOverflowRetryTarget,
    summarizationMaxInputTokens: maxTokens,
    summarizationPostCompactionInputBudgetTokens: mainModelInputBudget,
    summarizationSummaryPrompt: CMB_COWORK_SUMMARY_PROMPT,
    summarizationHistoryPathPrefix: conversationHistoryPathPrefix,
    summarizationLegacyHistoryPathPrefix: legacyConversationHistoryPathPrefix,
    summarizationTruncateArgsSettings: {
      trigger: { type: "tokens", value: triggerTokens },
      keep: { type: "tokens", value: keepTokens },
      maxLength: 2000
    },
    threadId: options.threadId,
    currentRunMessageQueueOwnerToken: options.currentRunMessageQueueOwnerToken,
    soloTaskTraceManager,
    actionStationarityTurnId,
    toolConcurrencyQueueId: options.toolConcurrencyQueueId ?? options.threadId ?? workspacePath,
    toolHookMiddleware,
    onFailureFuseNotice,
    onContextCompaction,
    // PR-12 — closure captures threadId / workspacePath / hookScope so
    // createDeepAgent's middleware can fire-and-forget the PostToolUseFailure
    // hook chain without knowing per-thread context.
    onToolFailureSignal: (input: {
      toolName: string | undefined
      toolCallId: string | undefined
      toolArgs: unknown
      signal: ToolFailureSignal
    }): FailureFuseDecision | void => {
      const failureFuseDecision = hookTurnId
        ? recordToolFailure({
            threadId,
            turnId: hookTurnId,
            toolName: input.toolName,
            toolCallId: input.toolCallId,
            toolArgs: input.toolArgs,
            signal: input.signal,
            mode: getFailureFuseMode()
          })
        : undefined
      const context: HookContext = {
        workspacePath,
        sessionId: threadId,
        agentId,
        turnId: hookTurnId,
        pluginOutputDir,
        systemId,
        pluginWorkspace,
        featureId,
        harnessProjectId,
        harnessAdapterName,
        harnessAdapterVersion,
        harnessNodeName,
        harnessNodeStatus,
        projectCode,
        projectDir,
        ...isolatedWorkspaceHookContext,
        toolName: input.toolName,
        toolArgs:
          input.toolArgs && typeof input.toolArgs === "object" && !Array.isArray(input.toolArgs)
            ? (input.toolArgs as Record<string, unknown>)
            : undefined,
        toolResult: JSON.stringify({
          error: input.signal.message,
          error_type: input.signal.errorType,
          failure_kind: input.signal.kind,
          is_interrupt: input.signal.isInterrupt,
          is_timeout: input.signal.isTimeout,
          tool_use_id: input.toolCallId
        })
      }
      runHooks(
        resolveHooksForContext("PostToolUseFailure", context),
        "PostToolUseFailure",
        context,
        onHookResult
      ).catch((e) => console.warn("[Hooks] PostToolUseFailure hook error:", e))
      return failureFuseDecision
    }
  })

  console.log("[Runtime] Agent created with skills parameter:", mainSkillSources)
  console.log(
    "[Runtime] Final skills passed to createDeepAgent:",
    JSON.stringify(mainSkillSources, null, 2)
  )
  console.log("[Runtime] Agent created with LocalSandbox at:", fileRoot)
  return agent
}

// Clean up all checkpointer, MCP client, and memory store resources
export async function closeRuntime(): Promise<void> {
  await Promise.all(Array.from(checkpointers.keys()).map(waitForCheckpointerPins))
  const closePromises: Promise<void>[] = Array.from(checkpointers.values()).map((cp) => cp.close())
  // Also wait out any in-flight eviction closes so their flushes land before quit.
  closePromises.push(...closingCheckpointers.values())
  closePromises.push(closeGlobalMcpCapabilityService())
  closePromises.push(closeMemoryStore())
  await Promise.all(closePromises)
  checkpointers.clear()
  closingCheckpointers.clear()
  checkpointerPins.clear()
  checkpointerPinWaiters.clear()
}
