import {
  extractOutputTokens,
  type MessageLike,
  snapshotMessages,
  isAiMessage,
  isToolMessage,
  messageToolCalls,
  toolCallId,
  toolMessageToolCallId
} from "./message-values"
export { extractOutputTokens } from "./message-values"
import {
  createStructuredOutputTool,
  structuredOutputToolInputExampleJson,
  structuredOutputFailureError,
  isPlainRecord
} from "./structured-output"
export {
  createStructuredOutputTool,
  structuredOutputToolInputExampleJson,
  exampleStructuredOutputToolInput,
  buildStructuredOutputRepairErrors
} from "./structured-output"
import { randomUUID } from "crypto"
import { TurnTraceRecorder } from "../trace/turn-trace-recorder"
import {
  withSubagentSessionCapture,
  subagentSessionCallbacks
} from "../../services/subagent-session-capture"
import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { DynamicStructuredTool } from "@langchain/core/tools"
import type { AgentShellAccess } from "../agent-registry"
import {
  extractTextFromUnknownContent,
  observeSkillUsageFromStream,
  WorkerValuesSnapshotAccumulator
} from "../coordinator-worker-stream"
import { SkillUsageDetector } from "../skill-evolution/usage-detector"
import {
  createTraceCollectorSafely,
  finishTraceInBackground,
  runTraceSideEffect,
  type TraceCollector
} from "../trace/collector"
import type { TraceContext, TraceNodeStatus, TraceOutcome } from "../trace/types"
import { syncSubagentSkillAttribution } from "../turn-attribution"
import { validateJsonSchemaValue } from "./json-schema"
import {
  WORKFLOW_SUBAGENT_MAX_RUNS,
  WorkflowAbortError,
  getWorkflowAgentTimeoutMs,
  isWorkflowAbortError,
  type WorkflowWorktreeIsolationBoundary,
  type WorkflowSubagentResult
} from "./types"
import { WORKFLOW_SUBAGENT_BASE_PROMPT, buildWorkflowSubagentStructuredPrompt } from "./prompts"
import {
  extractVisibleReasoning,
  TRACE_REASONING_MAX_CHARS,
  truncateReasoningForTrace
} from "../../../shared/model-reasoning"
import { getAgentGraphRecursionLimit } from "../../../shared/agent-runtime-limits"

export { isWorkflowStructuredOutputFatalError } from "./structured-output-error"
// Explicitly marks a structured-output failure as "retry on a fresh session" so the
// retry decision does NOT depend on the error message incidentally containing the
// substring "structured_output" (the nudge-block reason names the pending tool, which
// may or may not be structured_output — see schemaRetry).
const STRUCTURED_OUTPUT_RETRYABLE = Symbol.for("cmb.workflow.structured_output.retryable")
const WORKFLOW_TRACE_TOOL_ARGS_PARSE_MAX_CHARS = 100_000

/**
 * Workflow subagent execution.
 *
 * Each `agent()` call in a workflow script runs one fresh agent runtime on its
 * own checkpoint thread (`<parent>__wf_<run>_a<index>`), exactly like a
 * coordinator async worker: approvals surface on the parent thread UI, the
 * deepagents task tool is disabled, and the runtime is torn down afterwards.
 *
 * The runtime factory is injected by agent/runtime.ts to avoid a circular
 * import (runtime → workflow tool → subagent → runtime).
 */

/** Minimal surface of a deepagents runtime the subagent loop needs. */
export interface WorkflowSubagentRuntime {
  stream: (input: unknown, config: unknown) => Promise<AsyncIterable<unknown>>
}

export interface WorkflowSubagentDeps {
  /** Creates a one-shot agent runtime for a subagent thread. */
  createRuntime: (options: {
    threadId: string
    agentId: string
    modelId?: string
    extraSystemPrompt: string
    abortSignal: AbortSignal
    additionalTools?: DynamicStructuredTool[]
    traceContext?: TraceContext
    /** agentType-resolved tool denylist (project tool names). Undefined = none. */
    disallowedTools?: string[]
    /** agentType-resolved shell policy. Undefined = full. */
    shellAccess?: AgentShellAccess
    /** Immutable checkout identity used by file-root and Git guards. */
    worktreeIsolation?: WorkflowWorktreeIsolationBoundary
  }) => Promise<WorkflowSubagentRuntime>
  /** Tears down per-thread resources (checkpointer, sandbox ACLs). */
  cleanupThread: (threadId: string) => Promise<void>
  isRetryableApiError: (error: unknown) => boolean
  parentThreadId: string
  defaultModelId?: string
  traceContext?: TraceContext
  /** True while any subagent of this run is blocked on a pending user approval —
   * lets the engine's inactivity watchdog treat the run as waiting, not hung. Pass
   * the run's `runId` so the check is scoped to THIS run (concurrent runs on one
   * parent thread must not share watchdog state). */
  hasPendingApproval?: (runId?: string) => boolean
}

export interface RunWorkflowSubagentRequest {
  prompt: string
  schema?: Record<string, unknown>
  model?: string
  agentIndex: number
  label: string
  phase?: string | null
  runId: string
  signal: AbortSignal
  /** Role system prompt resolved from the call's agentType (prepended to the
   * subagent base prompt). Undefined for the default general agent. */
  roleSystemPrompt?: string
  /** agentType-resolved tool denylist (project tool names). Undefined = none. */
  disallowedTools?: string[]
  /** agentType-resolved shell policy. Undefined = full. */
  shellAccess?: AgentShellAccess
  /** Runtime checkout identity for the private worktree. */
  worktreeIsolation?: WorkflowWorktreeIsolationBoundary
  /**
   * Best-effort display tap: invoked with each "values" snapshot (the graph state
   * `{ messages: [...] }`) so the renderer can show this subagent's live tool stream.
   * PURELY additive — it never affects the returned result, the structured-stop
   * logic, or the journal. The callee guards it with try/catch, but callers MUST
   * keep it non-throwing and cheap. Undefined for all non-display callers.
   */
  onValues?: (snapshot: unknown) => void
}

/** A structured-output failure surfaced by runOnce (no schema-valid result after
 * the in-session tool-retries + nudge). Both messages mention `structured_output`. */
function isStructuredOutputFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes("structured_output")
}

/** A structured-output failure explicitly tagged "retry on a fresh session" (e.g. the
 * nudge-block when the transcript has a dangling tool call) — classified by an explicit
 * marker rather than by message substring, so the retry decision is stable regardless of
 * which tool was pending. */
function structuredOutputRetryableError(message: string): Error {
  const error = new Error(message)
  Object.defineProperty(error, STRUCTURED_OUTPUT_RETRYABLE, { value: true })
  return error
}

function isStructuredOutputRetryableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [STRUCTURED_OUTPUT_RETRYABLE]?: unknown })[STRUCTURED_OUTPUT_RETRYABLE] === true
  )
}

export async function runWorkflowSubagent(
  deps: WorkflowSubagentDeps,
  request: RunWorkflowSubagentRequest
): Promise<WorkflowSubagentResult> {
  return withSubagentSessionCapture(
    {
      kind: "workflow",
      threadId: deps.parentThreadId,
      runId: request.runId,
      agentIndex: request.agentIndex
    },
    request.label,
    () => runWorkflowSubagentAttempts(deps, request)
  )
}

async function runWorkflowSubagentAttempts(
  deps: WorkflowSubagentDeps,
  request: RunWorkflowSubagentRequest
): Promise<WorkflowSubagentResult> {
  const timeoutMs = getWorkflowAgentTimeoutMs()
  let lastError: unknown

  for (let attempt = 1; attempt <= WORKFLOW_SUBAGENT_MAX_RUNS; attempt += 1) {
    if (request.signal.aborted) throw new WorkflowAbortError()
    try {
      return await runOnce(deps, request, attempt, timeoutMs)
    } catch (error) {
      if (request.signal.aborted || isWorkflowAbortError(error)) throw new WorkflowAbortError()
      lastError = error
      const retryable = deps.isRetryableApiError(error)
      // A structured-output failure (the model never produced a schema-valid
      // result even after the in-session tool-retries + nudge) is worth a retry on
      // a FRESH session: a clean transcript often succeeds where a poisoned one
      // couldn't, especially for mid-tier models. Bounded by MAX_RUNS (2) — exactly
      // one extra attempt — so a genuinely impossible schema can't loop.
      const schemaRetry =
        request.schema !== undefined &&
        (isStructuredOutputRetryableError(error) || isStructuredOutputFailure(error))
      if ((!retryable && !schemaRetry) || attempt >= WORKFLOW_SUBAGENT_MAX_RUNS) break
      console.warn(
        `[Workflow] Subagent ${request.label} attempt ${attempt} failed (${
          retryable ? "retryable API" : "structured-output"
        }), retrying on a fresh session:`,
        error instanceof Error ? error.message : error
      )
      await delay(500, request.signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Hard-stop race: runs cooperative stream work against the lifetime signal. If
 * runtime.stream() or the async iterator hangs and never honours the AbortSignal,
 * controller.abort() (parent abort or an optional per-agent timeout) still settles
 * this race, so the subagent — and the engine awaiting it — unblock instead of the
 * whole run hanging on a dead stream. The orphaned work promise may settle later; its
 * result/rejection is swallowed so it can't surface as an unhandled rejection.
 */
function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined)
    return Promise.reject(new Error("aborted before stream started"))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void work.catch(() => undefined)
      reject(new Error("aborted while awaiting stream"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

function normalizeWorkflowModelId(model: string | undefined): string | undefined {
  if (!model) return undefined
  return model.startsWith("custom:") ? model : `custom:${model}`
}

function describeWorkflowTraceError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Workflow subagent failed"
  if (typeof error === "string" && error) return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function createWorkflowSubagentTrace(
  deps: WorkflowSubagentDeps,
  request: RunWorkflowSubagentRequest,
  threadId: string
): TraceCollector | undefined {
  const parent = deps.traceContext
  if (!parent) return undefined
  const requestedModelId =
    normalizeWorkflowModelId(request.model) ?? deps.defaultModelId ?? "unknown"
  const workflowPhase = request.phase ?? undefined
  return createTraceCollectorSafely(
    threadId,
    request.prompt,
    requestedModelId,
    {
      traceKind: "subagent",
      executionMode: "workflow",
      rootTraceId: parent.rootTraceId,
      rootThreadId: parent.rootThreadId,
      parentTraceId: parent.traceId,
      parentThreadId: parent.threadId,
      parentSpanId: parent.rootNodeId,
      linkType: "async_span_link",
      subagentKind: "workflow_agent",
      subagentRunId: `${request.runId}:agent:${request.agentIndex}`,
      subagentThreadId: threadId,
      handoffAction: "workflow_agent",
      handoffSourceAgent: "workflow",
      handoffTargetAgent: request.label,
      workflowRunId: request.runId,
      workflowAgentIndex: request.agentIndex,
      workflowPhase,
      workflowAgentLabel: request.label,
      harnessFeature: parent.harnessFeature,
      includeSkillEval: false
    },
    "Workflow"
  )
}

async function runOnce(
  deps: WorkflowSubagentDeps,
  request: RunWorkflowSubagentRequest,
  attempt: number,
  timeoutMs: number | undefined
): Promise<WorkflowSubagentResult> {
  // Fresh thread per attempt so a retried run never resumes a poisoned checkpoint.
  const runShort = request.runId.replace(/^wf_/, "")
  const attemptSuffix = attempt > 1 ? `_r${attempt}` : ""
  const threadId = `${deps.parentThreadId}__wf_${runShort}_a${request.agentIndex}${attemptSuffix}`
  const agentId = `${request.runId}:agent:${request.agentIndex}`

  // Subagent lifetime signal: parent abort, plus optional per-agent timeout when
  // CMB_WORKFLOW_AGENT_TIMEOUT_MS is configured.
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort()
  request.signal.addEventListener("abort", onParentAbort, { once: true })
  const timeoutTimer =
    timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
  timeoutTimer?.unref?.()

  const structured: { value: unknown; called: boolean } = { value: undefined, called: false }
  const promptMessage = new HumanMessage({ content: request.prompt, id: randomUUID() })
  let traceRecorder: TurnTraceRecorder | undefined
  let tracer: TraceCollector | undefined
  let latestSnapshot: unknown
  let traceTerminalRecorded = false
  let traceOutcome: TraceOutcome = "success"
  let traceError: string | undefined
  const skillUsageDetector = new SkillUsageDetector()
  const valuesSnapshotAccumulator = new WorkerValuesSnapshotAccumulator(request.prompt, {
    deriveWorkerState: false
  })
  const syncSkillAttribution = (): void => {
    if (!tracer) return
    const usedSkills = skillUsageDetector.getUsedSkillNames()
    const skillSource = skillUsageDetector.getUsedSkillSourceRefs()
    tracer.setUsedSkills(usedSkills)
    tracer.setSkillSource(skillSource)
    tracer.setEvolvedSkills(skillUsageDetector.getUsedEvolvedSkillNames())
    // This agent owns its own thread, so recordGen reads *this* thread's
    // adoption context. Resolve the fallback chain rather than publishing the
    // bare detector result: an agent that never re-reads a SKILL.md would
    // otherwise drop the attribution its parent had already established.
    syncSubagentSkillAttribution({
      threadId,
      parentThreadId: deps.parentThreadId,
      currentRunSkills: usedSkills,
      currentRunSkillSource: skillSource
    })
  }
  const recordValuesSnapshot = (snapshot: unknown): void => {
    latestSnapshot = snapshot
    traceRecorder?.onRawValues(snapshot)
    const valuesContext = valuesSnapshotAccumulator.createContext("values", snapshot)
    runTraceSideEffect("Workflow Skill observer", () => {
      if (observeSkillUsageFromStream("values", snapshot, skillUsageDetector, valuesContext)) {
        syncSkillAttribution()
      }
    })
    request.onValues?.(snapshot)
  }

  try {
    // agentIndex is deterministic, so after a crash-resume this threadId can
    // collide with a dead run's leftover checkpoint — continuing on that
    // transcript poisons the subagent (or 400s on a dangling tool_call).
    // Purge any stale per-thread state before creating the runtime.
    await deps.cleanupThread(threadId).catch(() => undefined)
    tracer = createWorkflowSubagentTrace(deps, request, threadId)
    if (tracer)
      traceRecorder = new TurnTraceRecorder({
        tracer,
        userMessageId: promptMessage.id,
        requireUserMessageAnchor: true
      })

    const additionalTools = request.schema
      ? [
          createStructuredOutputTool(request.schema, structured, {
            runId: request.runId,
            agentIndex: request.agentIndex,
            label: request.label,
            attempt,
            threadId
          })
        ]
      : undefined
    const baseExtraPrompt = request.schema
      ? buildWorkflowSubagentStructuredPrompt(
          JSON.stringify(request.schema, null, 2),
          structuredOutputToolInputExampleJson(request.schema)
        )
      : WORKFLOW_SUBAGENT_BASE_PROMPT
    // An agentType resolves to a focused role prompt; prepend it so the subagent
    // adopts the role while still honouring the workflow base/structured contract.
    const rolePrompt = request.roleSystemPrompt
      ? `${request.roleSystemPrompt}\n\n${baseExtraPrompt}`
      : baseExtraPrompt
    const extraSystemPrompt = request.worktreeIsolation
      ? `${rolePrompt}\n\nYou are running in an isolated Git worktree at \`${request.worktreeIsolation.workspaceRoot}\` on branch \`${request.worktreeIsolation.branch}\`, separate from the source working directory and other agents. It starts from the frozen committed source HEAD; staged, unstaged, and untracked changes in the source checkout are not present. For this isolated worktree, these native Git instructions override the ordinary task-card commit workflow. Work normally with native Git: use \`git add\` and \`git commit\` to commit exactly the changes you intend to deliver, and leave the worktree clean. Never commit sensitive files such as \`.env\` files, credentials, API keys, or private keys; before force-adding an ignored file, verify that it contains no sensitive data. Do not switch to or modify another existing branch, and do not merge back into the source branch yourself. Do not push unless the task explicitly requires publishing this transient branch and the user approves it. The checkout is removed if unchanged or preserved for review if changed.`
      : rolePrompt

    const { runtime, modelFellBack } = await createRuntimeWithModelFallback(deps, {
      threadId,
      agentId,
      model: request.model,
      extraSystemPrompt,
      abortSignal: controller.signal,
      additionalTools,
      traceContext: tracer?.getTraceContext() ?? deps.traceContext,
      label: request.label,
      disallowedTools: request.disallowedTools,
      shellAccess: request.shellAccess,
      worktreeIsolation: request.worktreeIsolation
    })
    runTraceSideEffect("Workflow", () => {
      tracer?.setModelId(
        modelFellBack
          ? (deps.defaultModelId ?? "unknown")
          : (normalizeWorkflowModelId(request.model) ?? deps.defaultModelId ?? "unknown")
      )
    })

    const streamConfig = {
      configurable: { thread_id: threadId },
      callbacks: subagentSessionCallbacks([]),
      signal: controller.signal,
      // "messages" is subscribed for its side effect, not for display: it attaches
      // LangGraph's StreamMessagesHandler (lc_prefer_streaming), which switches the
      // underlying HTTP call to SSE. Without it the request is non-streaming and the
      // 60s first-byte watchdog in createRetryingFetch kills any model turn whose
      // generation exceeds 60s (e.g. write_file of a large file). consumeValuesStream
      // skips non-"values" chunks, so the token stream is otherwise ignored.
      streamMode: ["values", "messages"] as Array<"values" | "messages">,
      recursionLimit: getAgentGraphRecursionLimit()
    }
    const stopAfterStructuredAccepted =
      request.schema === undefined
        ? undefined
        : (snapshot: unknown): boolean => {
            throwIfStructuredOutputInterrupt(snapshot)
            return isStructuredAccepted(structured, request.schema!)
          }

    // raceWithAbort so a stream that never honours controller.signal (a dead async
    // iterator / a gateway that ignores the abort) can't hang the whole run — the
    // parent abort or configured per-agent timeout still unblocks us.
    let snapshot = await raceWithAbort(
      (async () =>
        consumeValuesStream(
          await runtime.stream({ messages: [promptMessage] }, streamConfig),
          controller.signal,
          stopAfterStructuredAccepted,
          recordValuesSnapshot
        ))(),
      controller.signal
    )
    latestSnapshot = snapshot
    throwIfStructuredOutputInterrupt(snapshot)

    // Structured mode: if the model never called structured_output, give it one
    // explicit nudge turn before failing — mid-tier models often need it.
    //
    // Overwriting `snapshot` here does NOT lose round-1 tokens: the nudge reuses
    // the SAME streamConfig.thread_id, so it resumes the same checkpoint and the
    // "values" snapshot is cumulative — round-2's messages array still contains
    // round-1's AI messages. extractOutputTokens sums output_tokens across ALL
    // AI messages, so both rounds are metered. (If you ever switch the nudge to
    // a fresh thread_id, you must accumulate tokens across both snapshots.)
    if (request.schema && !isStructuredAccepted(structured, request.schema)) {
      throwIfAborted(controller.signal, request.signal, timeoutMs)
      // A genuine (non-structured) interrupt can't be repaired — fail it, but tag it
      // retryable so a fresh clean session gets one more shot.
      const interruptText = nonStructuredInterruptText(snapshot)
      if (interruptText) {
        throw structuredOutputRetryableError(
          `subagent paused before returning a structured result: ${interruptText}`
        )
      }
      // Split dangling tool calls by SOURCE — this decides repair-in-place vs fresh session.
      // deepagents' patchToolCalls (runs in beforeAgent right before the nudge's model call)
      // builds its keep-set from NORMALIZED tool_calls only, so a synthesized result for a call
      // that lives solely in additional_kwargs / invalid_tool_calls (deepseek emitted malformed
      // or token-truncated JSON) is dropped as an orphan — the dangling call then re-serializes
      // and 400s anyway. Those are UNREPAIRABLE in place: fail fast as retryable so a FRESH
      // session (clean transcript, no poisoned assistant turn) gets the next shot. Calls present
      // in the normalized array ARE repairable (patchToolCalls keeps the result) — e.g. mid-tier
      // models doing parallel calls where one came back unpaired — so synthesize a result for
      // each and nudge on the SAME session (claude-code yieldMissingToolResultBlocks / MiMo-Code
      // parity), preserving the round-1 context.
      const danglingIds = danglingToolCallIds(snapshot)
      const normalizedDanglingIds = normalizedToolCallIds(snapshot)
      const unrepairableDangling = danglingIds.filter((id) => !normalizedDanglingIds.has(id))
      if (unrepairableDangling.length > 0) {
        throw structuredOutputRetryableError(
          `structured_output left ${unrepairableDangling.length} unparseable tool call(s) dangling ` +
            `(malformed/truncated JSON in additional_kwargs/invalid_tool_calls); patchToolCalls drops ` +
            `in-place repairs for these, so retrying on a fresh session`
        )
      }
      const repairMessages = danglingIds.map(
        (id) =>
          new ToolMessage({
            tool_call_id: id,
            content:
              "[This tool call did not complete. Call structured_output again, exactly once, " +
              "by itself, with input matching the required JSON Schema.]"
          })
      )
      snapshot = await raceWithAbort(
        (async () =>
          consumeValuesStream(
            await runtime.stream(
              {
                messages: [
                  ...repairMessages,
                  new HumanMessage(
                    "You have not returned a valid structured result yet. Call the structured_output tool now, exactly once, with an input matching the required JSON Schema. Do not reply with plain text."
                  )
                ]
              },
              streamConfig
            ),
            controller.signal,
            stopAfterStructuredAccepted,
            recordValuesSnapshot
          ))(),
        controller.signal
      )
      latestSnapshot = snapshot
      throwIfStructuredOutputInterrupt(snapshot)
    }

    throwIfAborted(controller.signal, request.signal, timeoutMs)

    const text = extractFinalAssistantText(snapshot)
    let reasoning = ""
    if (tracer) {
      runTraceSideEffect("Workflow reasoning observer", () => {
        reasoning = truncateReasoningForTrace(extractFinalAssistantReasoning(snapshot))
      })
    }
    const outputTokens = extractOutputTokens(snapshot, text)
    const toolCallCount = extractWorkflowToolCallCount(snapshot)

    if (request.schema) {
      if (!isStructuredAccepted(structured, request.schema)) {
        throw new Error(
          structured.called
            ? "subagent called structured_output but every attempt failed schema validation"
            : "subagent completed without calling the structured_output tool"
        )
      }
      runTraceSideEffect("Workflow", () => {
        if (!tracer) return
        tracer.addTerminalNode({
          type: "message",
          output: text.trim() ? text : structured.value,
          metadata: {
            outputTokens,
            toolCallCount,
            modelFellBack,
            structuredOutput: true,
            ...(reasoning ? { reasoning } : {})
          }
        })
        traceTerminalRecorded = true
      })
      return { text, structured: structured.value, outputTokens, modelFellBack }
    }

    if (!text.trim()) {
      throw new Error("subagent produced no assistant output")
    }
    runTraceSideEffect("Workflow", () => {
      if (!tracer) return
      tracer.addTerminalNode({
        type: "message",
        output: text,
        metadata: {
          outputTokens,
          toolCallCount,
          modelFellBack,
          structuredOutput: false,
          ...(reasoning ? { reasoning } : {})
        }
      })
      traceTerminalRecorded = true
    })
    return { text, structured: undefined, outputTokens, modelFellBack }
  } catch (error) {
    if (isWorkflowAbortError(error)) {
      traceOutcome = "cancelled"
      traceError = describeWorkflowTraceError(error)
      throw error
    }
    try {
      throwIfAborted(controller.signal, request.signal, timeoutMs)
    } catch (abortError) {
      traceOutcome = "cancelled"
      traceError = describeWorkflowTraceError(abortError)
      throw abortError
    }
    traceOutcome = "error"
    traceError = describeWorkflowTraceError(error)
    throw error
  } finally {
    valuesSnapshotAccumulator.reset()
    if (tracer) {
      const tracerToFinish = tracer
      runTraceSideEffect("Workflow", () => {
        const toolCallCount = extractWorkflowToolCallCount(latestSnapshot)
        if (!traceTerminalRecorded && toolCallCount > 0) {
          tracerToFinish.addTerminalNode({
            type: traceOutcome === "cancelled" ? "cancel" : "error",
            output: traceError,
            metadata: {
              toolCallCount
            }
          })
          traceTerminalRecorded = true
        }
      })
      finishTraceInBackground(tracerToFinish, traceOutcome, traceError, "Workflow")
    }
    if (timeoutTimer) clearTimeout(timeoutTimer)
    request.signal.removeEventListener("abort", onParentAbort)
    // Abort the per-subagent controller on every exit path (including normal
    // completion) so any child process the subagent left tied to this signal
    // is torn down — mirrors the coordinator worker's background-task cancel.
    controller.abort()
    await deps.cleanupThread(threadId).catch((cleanupError) => {
      console.warn(`[Workflow] Subagent cleanup failed for ${threadId}:`, cleanupError)
    })
  }
}

/**
 * Whether a createRuntime failure means the REQUESTED model is genuinely
 * unavailable (so falling back to the session default is correct), as opposed to a
 * real init fault — MCP scoped-tool setup, checkpointer, skills, config — that must
 * NOT be masked as a model fallback. Keyed to the messages createAgentRuntime throws
 * for an unconfigured / empty custom model; a unit test pins these strings so a
 * runtime reword can't silently re-widen the fallback.
 */
export function isModelUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Custom model (not configured|name is empty)/i.test(message)
}

export async function createRuntimeWithModelFallback(
  deps: WorkflowSubagentDeps,
  options: {
    threadId: string
    agentId: string
    model?: string
    extraSystemPrompt: string
    abortSignal: AbortSignal
    additionalTools?: DynamicStructuredTool[]
    traceContext?: TraceContext
    label: string
    disallowedTools?: string[]
    shellAccess?: AgentShellAccess
    worktreeIsolation?: WorkflowWorktreeIsolationBoundary
  }
): Promise<{ runtime: WorkflowSubagentRuntime; modelFellBack: boolean }> {
  const baseOptions = {
    threadId: options.threadId,
    agentId: options.agentId,
    extraSystemPrompt: options.extraSystemPrompt,
    abortSignal: options.abortSignal,
    additionalTools: options.additionalTools,
    traceContext: options.traceContext,
    disallowedTools: options.disallowedTools,
    shellAccess: options.shellAccess,
    worktreeIsolation: options.worktreeIsolation
  }
  if (options.model) {
    // Don't double-prefix known model references. Bare profile model names keep
    // the legacy custom-model interpretation. (Using includes(":") would
    // wrongly skip the prefix for a custom model whose own name contains a
    // colon, and would not help an unsupported provider prefix anyway.)
    const modelId = /^(?:custom|builtin):/.test(options.model)
      ? options.model
      : `custom:${options.model}`
    try {
      return {
        runtime: await deps.createRuntime({ ...baseOptions, modelId }),
        modelFellBack: false
      }
    } catch (error) {
      // ONLY a genuinely-unavailable model is a fallback case. A different init
      // fault for an otherwise-valid model (MCP/checkpointer/skills/config) must
      // surface — silently downgrading it to the default would BOTH mask a real
      // failure and run a different model than the script asked for, while looking
      // like an intended fallback.
      if (!isModelUnavailableError(error)) {
        throw error
      }
      console.warn(
        `[Workflow] Subagent ${options.label}: model "${options.model}" unavailable, using session default:`,
        error instanceof Error ? error.message : error
      )
      // Fell back to the default model because the REQUESTED one was unavailable.
      // The caller must not journal this result, or a resume taken after the
      // requested model becomes available would replay this default-model output
      // as if it were the requested model's — silently violating opts.model.
      return {
        runtime: await deps.createRuntime({ ...baseOptions, modelId: deps.defaultModelId }),
        modelFellBack: true
      }
    }
  }
  // No model requested → using the session default IS the intent, not a fallback.
  return {
    runtime: await deps.createRuntime({ ...baseOptions, modelId: deps.defaultModelId }),
    modelFellBack: false
  }
}

function isStructuredAccepted(
  capture: { value: unknown; called: boolean },
  schema: Record<string, unknown>
): boolean {
  return capture.value !== undefined && validateJsonSchemaValue(schema, capture.value).length === 0
}

function throwIfStructuredOutputInterrupt(snapshot: unknown): void {
  const message = structuredOutputInterruptMessage(snapshot)
  if (!message) return
  throw structuredOutputFailureError(message)
}

function structuredOutputInterruptMessage(snapshot: unknown): string | null {
  if (!isPlainRecord(snapshot)) return null
  const interrupts = snapshot.__interrupt__
  if (!Array.isArray(interrupts)) return null
  for (const interrupt of interrupts) {
    const value = isPlainRecord(interrupt) ? interrupt.value : interrupt
    const text = typeof value === "string" ? value : extractTextFromUnknownContent(value).trim()
    if (text.includes("structured_output schema validation failed")) return text
  }
  return null
}

/** Consumes a [mode, data] stream and returns the last "values" snapshot. */
/** Exported for the tap-isolation regression test (display-only onValues must not
 * change the return value or stop semantics; a throwing tap must be swallowed). */
/**
 * Stops the graph, not just our reading of it.
 *
 * Breaking out of a `for await` calls the iterator's `return()`, which cancels
 * the ReadableStream we are reading — and nothing else. LangGraph aborts a run
 * only from `IterableReadableStreamWithAbortSignal.cancel()`, and the source it
 * builds has no cancel handler for `reader.cancel()` to reach, so the graph runs
 * on: more model turns, more tool calls, unsupervised and billed, writing tokens
 * into a controller we already closed (which is where the flood of
 * "Controller is already closed" warnings came from).
 *
 * Cancels only this stream's own derived controller, never the caller's signal —
 * aborting that would reject the raceWithAbort around this call and throw away
 * the result we just accepted.
 */
async function stopGraphStream(stream: AsyncIterable<unknown>): Promise<void> {
  const cancel = (stream as { cancel?: (reason?: unknown) => Promise<void> | void }).cancel
  if (typeof cancel !== "function") return
  try {
    await cancel.call(stream)
  } catch {
    /* teardown is best-effort; the caller already has what it needs */
  }
}

export async function consumeValuesStream(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal,
  shouldStop?: (snapshot: unknown) => boolean,
  onValues?: (snapshot: unknown) => void
): Promise<unknown> {
  let lastValues: unknown
  for await (const chunk of stream) {
    // The config signal already tears the run down here, so this is belt and
    // braces — but this file has long guarded against a stream that never
    // honours that signal, and the cost of asking twice is nothing.
    if (signal.aborted) {
      await stopGraphStream(stream)
      break
    }
    if (!Array.isArray(chunk) || chunk.length < 2) continue
    const [mode, data] = chunk as [string, unknown]
    if (mode === "values") {
      lastValues = data
      // Best-effort display tap (BEFORE the stop check so the final accepted
      // snapshot is also surfaced). Fully isolated: a throwing tap must never
      // perturb the run's result or stop semantics.
      if (onValues) {
        try {
          onValues(data)
        } catch {
          /* display tap is best-effort */
        }
      }
      // Structured subagents can stop as soon as a schema-valid structured_output
      // call has been captured; invalid tool calls keep streaming so the model can
      // read the repair feedback and call the tool again.
      //
      // Nothing has aborted the run at this point — we are leaving early because
      // we have the answer — so this is the path that actually needed stopping.
      if (shouldStop?.(lastValues)) {
        await stopGraphStream(stream)
        break
      }
    }
  }
  return lastValues
}

function nonStructuredInterruptText(snapshot: unknown): string | null {
  if (!isPlainRecord(snapshot)) return null
  const interrupts = snapshot.__interrupt__
  if (!Array.isArray(interrupts)) return null
  for (const interrupt of interrupts) {
    const value = isPlainRecord(interrupt) ? interrupt.value : interrupt
    const text = typeof value === "string" ? value : extractTextFromUnknownContent(value).trim()
    if (!text) continue
    if (!text.includes("structured_output schema validation failed")) return text
  }
  return null
}

/** Tool-call ids from the snapshot that never got a matching tool result — "dangling".
 * Walks the cumulative messages tracking the latest assistant turn's tool calls; any still
 * unresolved when a non-tool message arrives (or the transcript ends) are returned, so the
 * caller can synthesize a tool result for each before continuing (else the API 400s). */
function danglingToolCallIds(snapshot: unknown): string[] {
  const pending = new Set<string>()
  for (const message of snapshotMessages(snapshot)) {
    if (pending.size > 0) {
      if (isToolMessage(message)) {
        const id = toolMessageToolCallId(message)
        if (id) pending.delete(id)
        continue
      }
      return Array.from(pending)
    }
    if (!isAiMessage(message)) continue
    for (const call of messageToolCalls(message)) {
      const id = toolCallId(call)
      if (id) pending.add(id)
    }
  }
  return Array.from(pending)
}

/** Tool-call ids that appear in some assistant turn's NORMALIZED `tool_calls` (live `tool_calls`
 * or serialized `kwargs.tool_calls`) — NEVER additional_kwargs / invalid_tool_calls. deepagents'
 * patchToolCalls builds its keep-set from exactly these, so a synthesized repair ToolMessage
 * survives the pre-model patch ONLY if its id is here; a result for a call that lives solely in
 * additional_kwargs is dropped as an orphan (re-dangles → 400). Lets the nudge tell repairable
 * (normalized) dangling calls from unrepairable (raw, malformed-JSON) ones apart. */
function normalizedToolCallIds(snapshot: unknown): Set<string> {
  const ids = new Set<string>()
  for (const message of snapshotMessages(snapshot)) {
    if (!isAiMessage(message)) continue
    for (const candidate of [message.tool_calls, message.kwargs?.tool_calls]) {
      if (!Array.isArray(candidate)) continue
      for (const call of candidate) {
        const id = toolCallId(call)
        if (id) ids.add(id)
      }
    }
  }
  return ids
}

/** ONLY the normalized/actionable tool_calls (live `tool_calls` or serialized `kwargs.tool_calls`) —
 * NOT additional_kwargs / invalid_tool_calls, which can hold a RAW or MALFORMED artifact the runtime
 * never executes. messageToolCalls() unions those for dangling DETECTION; but "is this turn awaiting
 * a real tool result (so it is NOT the final text)?" must look at normalized only — otherwise a
 * mid-tier gateway tacking a malformed tool-call artifact onto its final TEXT would make a
 * non-schema subagent look like it produced no output and falsely throw "no assistant output". */
function messageNormalizedToolCalls(message: MessageLike): unknown[] {
  for (const candidate of [message.tool_calls, message.kwargs?.tool_calls]) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate
  }
  return []
}

function extractFinalAssistantText(snapshot: unknown): string {
  const messages = snapshotMessages(snapshot)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isAiMessage(message)) continue
    // Normalized-only: a malformed/raw artifact must NOT hide this message's final text (see helper).
    const toolCalls = messageNormalizedToolCalls(message)
    if (Array.isArray(toolCalls) && toolCalls.length > 0) continue
    const text = extractTextFromUnknownContent(message.content ?? message.kwargs?.content)
    if (text.trim()) return text.trim()
  }
  return ""
}

function extractFinalAssistantReasoning(snapshot: unknown): string {
  const messages = snapshotMessages(snapshot)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isAiMessage(message)) continue
    const reasoning = extractVisibleReasoning(message, TRACE_REASONING_MAX_CHARS + 1).trim()
    if (reasoning) return reasoning
  }
  return ""
}

interface WorkflowNormalizedToolCall {
  toolCallId?: string
  name: string
  input?: unknown
}

export interface WorkflowTraceToolDetail extends WorkflowNormalizedToolCall {
  output?: unknown
  status: TraceNodeStatus
}

function workflowTraceToolCallName(toolCall: unknown): string {
  if (!isPlainRecord(toolCall)) return "unknown"
  const fn = isPlainRecord(toolCall.function) ? toolCall.function : undefined
  let name = ""
  if (typeof toolCall.name === "string") name = toolCall.name
  else if (typeof fn?.name === "string") name = fn.name
  return name.trim() || "unknown"
}

function workflowTraceToolCallInput(toolCall: unknown): unknown {
  if (!isPlainRecord(toolCall)) return undefined
  if (Object.prototype.hasOwnProperty.call(toolCall, "args")) return toolCall.args
  const fn = isPlainRecord(toolCall.function) ? toolCall.function : undefined
  if (!fn || !Object.prototype.hasOwnProperty.call(fn, "arguments")) return undefined
  const args = fn.arguments
  if (typeof args !== "string") return args
  const trimmed = args.trim()
  if (
    !trimmed ||
    trimmed.length > WORKFLOW_TRACE_TOOL_ARGS_PARSE_MAX_CHARS ||
    (!trimmed.startsWith("{") && !trimmed.startsWith("["))
  ) {
    return args
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return args
  }
}

function extractWorkflowNormalizedToolCalls(snapshot: unknown): WorkflowNormalizedToolCall[] {
  const details: WorkflowNormalizedToolCall[] = []
  const seenIds = new Set<string>()
  for (const message of snapshotMessages(snapshot)) {
    if (!isAiMessage(message)) continue
    for (const call of messageNormalizedToolCalls(message)) {
      const id = toolCallId(call)
      if (id) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
      }
      const input = workflowTraceToolCallInput(call)
      details.push({
        ...(id ? { toolCallId: id } : {}),
        name: workflowTraceToolCallName(call),
        ...(input !== undefined ? { input } : {})
      })
    }
  }
  return details
}

function workflowTraceToolResultStatus(message: MessageLike): TraceNodeStatus {
  const status = message.status ?? message.kwargs?.status
  if (status === "error") return "error"
  if (status === "cancelled") return "cancelled"
  if (status === "unknown") return "unknown"
  return "success"
}

/**
 * Recover the tools that actually executed from a Workflow agent's cumulative
 * values snapshot. Only normalized/actionable AI tool calls are included;
 * malformed calls from additional_kwargs/invalid_tool_calls are intentionally
 * excluded because the runtime never executed them.
 */
export function extractWorkflowTraceToolDetails(snapshot: unknown): WorkflowTraceToolDetail[] {
  const resultsByCallId = new Map<string, { output?: unknown; status: TraceNodeStatus }>()
  for (const message of snapshotMessages(snapshot)) {
    if (!isToolMessage(message)) continue
    const id = toolMessageToolCallId(message)
    if (!id) continue
    const output = message.content ?? message.kwargs?.content
    resultsByCallId.set(id, {
      ...(output !== undefined ? { output } : {}),
      status: workflowTraceToolResultStatus(message)
    })
  }

  return extractWorkflowNormalizedToolCalls(snapshot).map((call) => {
    const result = call.toolCallId ? resultsByCallId.get(call.toolCallId) : undefined
    return {
      ...call,
      ...(result && result.output !== undefined ? { output: result.output } : {}),
      status: result?.status ?? "unknown"
    }
  })
}

/**
 * Sums reported output tokens across assistant messages; falls back to a
 * chars/4 estimate when the provider reports no usage (common on mid-tier
 * gateways) so the workflow budget still functions.
 */
function extractWorkflowToolCallCount(snapshot: unknown): number {
  return extractWorkflowNormalizedToolCalls(snapshot).length
}

/**
 * Rough output-token estimate for gateways that report no usage. CJK characters
 * count ~1 token each (a flat chars/4 underestimates Chinese ~3-4x); other
 * characters count ~1 token per 4. Inexact by nature, but far closer than
 * chars/4 alone for the app's primary (Chinese) workloads.
 */
function throwIfAborted(
  agentSignal: AbortSignal,
  parentSignal: AbortSignal,
  timeoutMs: number | undefined
): void {
  if (parentSignal.aborted) throw new WorkflowAbortError()
  if (agentSignal.aborted) {
    if (timeoutMs !== undefined) throw new Error(`subagent timed out after ${timeoutMs}ms`)
    throw new WorkflowAbortError("Subagent aborted")
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  // The signal is the run-wide lifetime signal: the listener MUST come off on
  // the timer path too, or every gateway retry leaks one listener on it.
  let onAbort: (() => void) | undefined
  try {
    await new Promise<void>((resolveDelay) => {
      // NOT unref'd: this is the run's critical retry path, so the timer MUST keep the
      // process alive until it fires (an unref'd timer let a bare-node test exit early
      // mid-retry — a false green). On app quit the run's abort signal resolves it at once.
      const timer = setTimeout(resolveDelay, ms)
      onAbort = () => {
        clearTimeout(timer)
        resolveDelay()
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}
