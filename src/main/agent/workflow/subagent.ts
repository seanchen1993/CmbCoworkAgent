import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import { DynamicStructuredTool, ToolInputParsingException } from "@langchain/core/tools"
import { NodeInterrupt } from "@langchain/langgraph"
import type { AgentShellAccess } from "../agent-registry"
import {
  extractTextFromUnknownContent,
  observeSkillUsageFromStream
} from "../coordinator-worker-stream"
import { SkillUsageDetector } from "../skill-evolution/usage-detector"
import {
  createTraceCollectorSafely,
  finishTraceInBackground,
  runTraceSideEffect,
  type TraceCollector
} from "../trace/collector"
import type { TraceContext, TraceOutcome } from "../trace/types"
import { setAdoptionContext } from "../../services/adoption-tracker"
import { validateJsonSchemaValue } from "./json-schema"
import {
  WORKFLOW_STRUCTURED_OUTPUT_MAX_ATTEMPTS,
  WORKFLOW_SUBAGENT_MAX_RUNS,
  WorkflowAbortError,
  getWorkflowAgentTimeoutMs,
  isWorkflowAbortError,
  type WorkflowSubagentResult
} from "./types"
import { WORKFLOW_SUBAGENT_BASE_PROMPT, buildWorkflowSubagentStructuredPrompt } from "./prompts"
import {
  extractVisibleReasoning,
  TRACE_REASONING_MAX_CHARS,
  truncateReasoningForTrace
} from "../../../shared/model-reasoning"

const STRUCTURED_OUTPUT_FATAL_ERROR = Symbol.for("cmb.workflow.structured_output.fatal")
// Explicitly marks a structured-output failure as "retry on a fresh session" so the
// retry decision does NOT depend on the error message incidentally containing the
// substring "structured_output" (the nudge-block reason names the pending tool, which
// may or may not be structured_output — see schemaRetry).
const STRUCTURED_OUTPUT_RETRYABLE = Symbol.for("cmb.workflow.structured_output.retryable")
const STRUCTURED_OUTPUT_RECORDED_MESSAGE =
  "Structured output recorded successfully. End your turn now — no further text is needed."
const STRUCTURED_OUTPUT_SIGNATURE_MAX_CHARS = 8_192
const STRUCTURED_OUTPUT_HINT_JSON_MAX_CHARS = 200
const STRUCTURED_OUTPUT_HINT_PARSE_MAX_CHARS = 20_000
const STRUCTURED_OUTPUT_HINT_MAX_NODES = 512
const STRUCTURED_OUTPUT_EXAMPLE_ARRAY_MAX_ITEMS = 16
const STRUCTURED_OUTPUT_EXAMPLE_MAX_NODES = 256
const STRUCTURED_OUTPUT_EXAMPLE_MAX_CHARS = 4_000
const STRUCTURED_OUTPUT_STRINGIFY_MAX_OBJECT_KEYS = 256
const STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE = Symbol("structured_output_example_unavailable")
const STRUCTURED_OUTPUT_NO_SINGLE_VALUE = Symbol("structured_output_no_single_value")
const PROVIDER_SCHEMA_DROPPED_ANNOTATIONS = new Set([
  "default",
  "examples",
  "format",
  "$schema",
  "$id",
  "$comment",
  "readOnly",
  "writeOnly",
  "deprecated"
])

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
    modelId?: string
    extraSystemPrompt: string
    abortSignal: AbortSignal
    additionalTools?: DynamicStructuredTool[]
    /** agentType-resolved tool denylist (project tool names). Undefined = none. */
    disallowedTools?: string[]
    /** agentType-resolved shell policy. Undefined = full. */
    shellAccess?: AgentShellAccess
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
  /**
   * Best-effort display tap: invoked with each "values" snapshot (the graph state
   * `{ messages: [...] }`) so the renderer can show this subagent's live tool stream.
   * PURELY additive — it never affects the returned result, the structured-stop
   * logic, or the journal. The callee guards it with try/catch, but callers MUST
   * keep it non-throwing and cheap. Undefined for all non-display callers.
   */
  onValues?: (snapshot: unknown) => void
}

interface StructuredOutputLogContext {
  runId: string
  agentIndex: number
  label: string
  attempt: number
  threadId: string
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

export function isWorkflowStructuredOutputFatalError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [STRUCTURED_OUTPUT_FATAL_ERROR]?: unknown })[STRUCTURED_OUTPUT_FATAL_ERROR] === true
  )
}

function structuredOutputFailureError(message: string): Error {
  // ToolNode converts ordinary tool throws into ToolMessage(status:"error").
  // NodeInterrupt is a GraphInterrupt, so both ToolNode and our runtime error
  // middleware bubble it instead of feeding another retry prompt to the model.
  const error = new NodeInterrupt(message)
  Object.defineProperty(error, STRUCTURED_OUTPUT_FATAL_ERROR, { value: true })
  return error
}

export async function runWorkflowSubagent(
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

  // Subagent lifetime signal: parent abort, plus optional per-agent timeout when
  // CMB_WORKFLOW_AGENT_TIMEOUT_MS is configured.
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort()
  request.signal.addEventListener("abort", onParentAbort, { once: true })
  const timeoutTimer =
    timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
  timeoutTimer?.unref?.()

  const structured: { value: unknown; called: boolean } = { value: undefined, called: false }
  let tracer: TraceCollector | undefined
  let latestSnapshot: unknown
  let traceTerminalRecorded = false
  let traceOutcome: TraceOutcome = "success"
  let traceError: string | undefined
  const skillUsageDetector = new SkillUsageDetector()
  const syncSkillAttribution = (): void => {
    if (!tracer) return
    const usedSkills = skillUsageDetector.getUsedSkillNames()
    const skillSource = skillUsageDetector.getUsedSkillSourceRefs()
    tracer.setUsedSkills(usedSkills)
    tracer.setSkillSource(skillSource)
    tracer.setEvolvedSkills(skillUsageDetector.getUsedEvolvedSkillNames())
    setAdoptionContext(threadId, { usedSkills, skillSource })
  }
  const recordValuesSnapshot = (snapshot: unknown): void => {
    latestSnapshot = snapshot
    runTraceSideEffect("Workflow Skill observer", () => {
      if (
        observeSkillUsageFromStream(
          "values",
          snapshot,
          skillUsageDetector,
          undefined,
          request.prompt
        )
      ) {
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
    const extraSystemPrompt = request.roleSystemPrompt
      ? `${request.roleSystemPrompt}\n\n${baseExtraPrompt}`
      : baseExtraPrompt

    const { runtime, modelFellBack } = await createRuntimeWithModelFallback(deps, {
      threadId,
      model: request.model,
      extraSystemPrompt,
      abortSignal: controller.signal,
      additionalTools,
      label: request.label,
      disallowedTools: request.disallowedTools,
      shellAccess: request.shellAccess
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
      callbacks: [],
      signal: controller.signal,
      // "messages" is subscribed for its side effect, not for display: it attaches
      // LangGraph's StreamMessagesHandler (lc_prefer_streaming), which switches the
      // underlying HTTP call to SSE. Without it the request is non-streaming and the
      // 60s first-byte watchdog in createRetryingFetch kills any model turn whose
      // generation exceeds 60s (e.g. write_file of a large file). consumeValuesStream
      // skips non-"values" chunks, so the token stream is otherwise ignored.
      streamMode: ["values", "messages"] as Array<"values" | "messages">,
      recursionLimit: 1000
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
          await runtime.stream({ messages: [new HumanMessage(request.prompt)] }, streamConfig),
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
    model?: string
    extraSystemPrompt: string
    abortSignal: AbortSignal
    additionalTools?: DynamicStructuredTool[]
    label: string
    disallowedTools?: string[]
    shellAccess?: AgentShellAccess
  }
): Promise<{ runtime: WorkflowSubagentRuntime; modelFellBack: boolean }> {
  const baseOptions = {
    threadId: options.threadId,
    extraSystemPrompt: options.extraSystemPrompt,
    abortSignal: options.abortSignal,
    additionalTools: options.additionalTools,
    disallowedTools: options.disallowedTools,
    shellAccess: options.shellAccess
  }
  if (options.model) {
    // Don't double-prefix, but stay consistent with how the runtime resolves
    // it: the runtime only recognizes the `custom:` prefix (it slices it off),
    // so add `custom:` unless it is ALREADY there. (Using includes(":") would
    // wrongly skip the prefix for a custom model whose own name contains a
    // colon, and would not help an unsupported provider prefix anyway.)
    const modelId = options.model.startsWith("custom:") ? options.model : `custom:${options.model}`
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

function logStructuredOutputEvent(
  context: StructuredOutputLogContext | undefined,
  event: string,
  details: Record<string, unknown> = {},
  level: "info" | "warn" = "info"
): void {
  if (!context) return
  if (level === "info" && process.env.CMB_WORKFLOW_STRUCTURED_OUTPUT_DEBUG !== "1") return
  const firstError =
    typeof details.firstError === "string" ? details.firstError.slice(0, 300) : details.firstError
  const payload = {
    event,
    runId: context.runId,
    agentIndex: context.agentIndex,
    label: context.label,
    attempt: context.attempt,
    threadId: context.threadId,
    ...details,
    ...(firstError === undefined ? {} : { firstError })
  }
  console[level]("[Workflow][structured_output]", payload)
}

export function createStructuredOutputTool(
  schema: Record<string, unknown>,
  capture: { value: unknown; called: boolean },
  logContext?: StructuredOutputLogContext
): DynamicStructuredTool {
  let attempts = 0
  let lastInvalidSignature: string | undefined
  let repeatedInvalidAttempts = 0
  const toolInputSchema = structuredOutputToolInputSchema(schema)
  const recordValidOutput = (candidate: unknown): string => {
    capture.called = true
    if (
      capture.value !== undefined &&
      validateJsonSchemaValue(schema, capture.value).length === 0
    ) {
      logStructuredOutputEvent(logContext, "valid-after-success-ignored", {
        toolAttempt: attempts + 1
      })
      return STRUCTURED_OUTPUT_RECORDED_MESSAGE
    }
    capture.value = candidate
    logStructuredOutputEvent(logContext, "succeeded", { toolAttempt: attempts + 1 })
    return STRUCTURED_OUTPUT_RECORDED_MESSAGE
  }
  const registerInvalidAttempt = (input: unknown, errors: string[]): string => {
    if (
      capture.value !== undefined &&
      validateJsonSchemaValue(schema, capture.value).length === 0
    ) {
      capture.called = true
      logStructuredOutputEvent(logContext, "invalid-after-success-ignored", {
        toolAttempt: attempts + 1,
        errorCount: errors.length
      })
      return STRUCTURED_OUTPUT_RECORDED_MESSAGE
    }
    attempts += 1
    capture.called = true
    const modelErrors = buildStructuredOutputRepairErrors(schema, input, errors)
    const inputSignature = stableStringifyWithMetadata(input)
    const invalidSignature = inputSignature.truncated
      ? undefined
      : `${inputSignature.value}\n${modelErrors.join("\n")}`
    if (invalidSignature === undefined) {
      repeatedInvalidAttempts = 1
      lastInvalidSignature = undefined
    } else {
      repeatedInvalidAttempts =
        invalidSignature === lastInvalidSignature ? repeatedInvalidAttempts + 1 : 1
      lastInvalidSignature = invalidSignature
    }
    logStructuredOutputEvent(
      logContext,
      "invalid",
      {
        toolAttempt: attempts,
        repeatedInvalidAttempts,
        errorCount: modelErrors.length,
        firstError: modelErrors[0]
      },
      "warn"
    )
    if (attempts >= WORKFLOW_STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
      logStructuredOutputEvent(
        logContext,
        "fatal-max-attempts",
        {
          toolAttempt: attempts,
          errorCount: modelErrors.length,
          firstError: modelErrors[0]
        },
        "warn"
      )
      throw structuredOutputFailureError(
        `structured_output schema validation failed after ${attempts} attempts:\n${modelErrors.join("\n")}`
      )
    }
    if (repeatedInvalidAttempts >= 3) {
      logStructuredOutputEvent(
        logContext,
        "fatal-identical-attempts",
        {
          toolAttempt: attempts,
          repeatedInvalidAttempts,
          errorCount: modelErrors.length,
          firstError: modelErrors[0]
        },
        "warn"
      )
      throw structuredOutputFailureError(
        `structured_output schema validation failed after ${repeatedInvalidAttempts} identical invalid attempts:\n${modelErrors.join("\n")}`
      )
    }
    return `StructuredOutput schema mismatch:\n${modelErrors.join("\n")}\nRead the errors and call structured_output again with a corrected input.`
  }
  const structuredTool = new DynamicStructuredTool({
    name: "structured_output",
    description:
      "Return the final machine-readable answer for this task. Call it exactly once with input matching this tool's JSON Schema. Do not stringify arrays or objects; pass them as real JSON values.",
    schema: cloneJsonSchema(toolInputSchema),
    func: async (input: unknown) => {
      capture.called = true
      logStructuredOutputEvent(logContext, "called", {
        toolAttempt: attempts + 1,
        alreadyCaptured: capture.value !== undefined
      })
      // Tool args always arrive as a JSON object. Mid-tier models often wrap
      // the real answer one level deep. Scalar/array/wide schemas prefer the
      // unwrapped value; shaped object schemas also unwrap conventional wrapper
      // keys when that key is not a declared business field.
      const candidates = structuredOutputCandidates(input, schema)
      let errors: string[] | undefined
      for (const candidate of candidates) {
        const candidateErrors = validateJsonSchemaValue(schema, candidate)
        errors = chooseStructuredOutputErrors(input, candidate, schema, errors, candidateErrors)
        if (candidateErrors.length === 0) {
          return recordValidOutput(candidate)
        }
      }
      return registerInvalidAttempt(input, errors ?? [])
    }
  }) as DynamicStructuredTool
  restoreStructuredToolSchema(structuredTool, toolInputSchema)
  const originalInvoke = structuredTool.invoke.bind(structuredTool)
  structuredTool.invoke = async (...args: Parameters<typeof structuredTool.invoke>) => {
    try {
      return await originalInvoke(...args)
    } catch (error) {
      if (!(error instanceof ToolInputParsingException)) throw error
      logStructuredOutputEvent(
        logContext,
        "tool-input-parsing-fallback",
        { toolAttempt: attempts + 1 },
        "warn"
      )
      const rawInput = toolInputFromParsingError(error, args[0])
      const candidates = structuredOutputCandidates(rawInput, schema)
      let errors: string[] | undefined
      for (const candidate of candidates) {
        const candidateErrors = validateJsonSchemaValue(schema, candidate)
        errors = chooseStructuredOutputErrors(rawInput, candidate, schema, errors, candidateErrors)
        if (candidateErrors.length === 0) {
          return recordValidOutput(candidate) as Awaited<ReturnType<typeof structuredTool.invoke>>
        }
      }
      return registerInvalidAttempt(
        rawInput,
        errors && errors.length > 0
          ? errors
          : ["Tool input did not match the required JSON Schema."]
      ) as Awaited<ReturnType<typeof structuredTool.invoke>>
    }
  }
  return structuredTool
}

function cloneJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
}

function restoreStructuredToolSchema(
  tool: DynamicStructuredTool,
  schema: Record<string, unknown>
): void {
  // DynamicStructuredTool's constructor normalizes JSON-schema booleans to `{}`.
  // That is useful for provider-incompatible boolean subschemas, but
  // `additionalProperties:false` is a provider-facing constraint we want models
  // to see. Reattach our normalized schema after construction; local validation
  // still remains the source of truth inside `func`.
  ;(tool as { schema: Record<string, unknown> }).schema = schema
  const kwargs = (tool as { lc_kwargs?: { schema?: unknown } }).lc_kwargs
  if (kwargs) kwargs.schema = schema
}

function chooseStructuredOutputErrors(
  input: unknown,
  candidate: unknown,
  schema: Record<string, unknown>,
  current: string[] | undefined,
  candidateErrors: string[]
): string[] {
  if (shouldPreferUnwrappedErrors(input, candidate, schema)) return candidateErrors
  if (shouldPreferSemanticSingleValueErrors(input, candidate, schema)) return candidateErrors
  return current ?? candidateErrors
}

function shouldPreferUnwrappedErrors(
  input: unknown,
  candidate: unknown,
  schema: Record<string, unknown>
): boolean {
  if (candidate === input) return false
  if (!schemaRootIsObject(schema)) return false
  if (!isPlainRecord(input)) return false
  const single = singleOwnEntry(input)
  return (
    single !== null &&
    isStructuredOutputWrapperKey(single.key) &&
    !rootSchemaCoversProperty(schema, single.key)
  )
}

function rootSchemaCoversProperty(schema: Record<string, unknown>, key: string): boolean {
  if (
    isPlainRecord(schema.properties) &&
    Object.prototype.hasOwnProperty.call(schema.properties, key)
  ) {
    return true
  }
  if (schema.additionalProperties === true || isPlainRecord(schema.additionalProperties))
    return true
  return rootSchemaVariants(schema).some((variant) => rootSchemaCoversProperty(variant, key))
}

function rootSchemaDeclaresProperty(schema: Record<string, unknown>, key: string): boolean {
  if (
    isPlainRecord(schema.properties) &&
    Object.prototype.hasOwnProperty.call(schema.properties, key)
  ) {
    return true
  }
  return rootSchemaVariants(schema).some((variant) => rootSchemaDeclaresProperty(variant, key))
}

function rootSchemaHasObjectShape(schema: Record<string, unknown>): boolean {
  const propertyCount = isPlainRecord(schema.properties) ? Object.keys(schema.properties).length : 0
  const requiredCount = Array.isArray(schema.required) ? schema.required.length : 0
  return propertyCount > 0 || requiredCount > 0
}

function shouldPreferSemanticSingleValueErrors(
  input: unknown,
  candidate: unknown,
  schema: Record<string, unknown>
): boolean {
  if (schemaRootIsObject(schema)) return false
  if (!isPlainRecord(input)) return false
  const single = singleOwnEntry(input)
  return single !== null && single.value === candidate
}

function structuredOutputCandidates(input: unknown, schema: Record<string, unknown>): unknown[] {
  const unwrapped = unwrapToolInput(input)
  if (shouldTreatAsAccidentalObjectWrapper(input, unwrapped, schema)) {
    return [unwrapped]
  }
  const ordered = shouldPreferUnwrappedStructuredOutput(input, unwrapped, schema)
    ? [unwrapped, input]
    : [input, unwrapped]
  if (!schemaRootIsObject(schema)) {
    const semanticValue = singleToolInputValue(input)
    if (semanticValue !== STRUCTURED_OUTPUT_NO_SINGLE_VALUE) ordered.push(semanticValue)
  }
  return ordered.filter((candidate, index, all) => all.indexOf(candidate) === index)
}

function shouldTreatAsAccidentalObjectWrapper(
  input: unknown,
  unwrapped: unknown,
  schema: Record<string, unknown>
): boolean {
  if (!schemaRootIsObject(schema)) return false
  if (unwrapped === input || !isPlainRecord(input)) return false
  const single = singleOwnEntry(input)
  return (
    single !== null &&
    isStructuredOutputWrapperKey(single.key) &&
    !rootSchemaCoversProperty(schema, single.key) &&
    rootSchemaHasObjectShape(schema)
  )
}

function shouldPreferUnwrappedStructuredOutput(
  input: unknown,
  unwrapped: unknown,
  schema: Record<string, unknown>
): boolean {
  if (schemaRootIsObject(schema)) return false
  if (unwrapped === input) return false
  const unwrappedErrors = validateJsonSchemaValue(schema, unwrapped)
  if (unwrappedErrors.length > 0) return false
  if (isPlainRecord(input)) {
    const single = singleOwnEntry(input)
    if (
      single !== null &&
      isStructuredOutputWrapperKey(single.key) &&
      !rootSchemaDeclaresProperty(schema, single.key)
    ) {
      return true
    }
  }
  const inputErrors = validateJsonSchemaValue(schema, input)
  if (inputErrors.length > 0) return true
  return false
}

function toolInputFromParsingError(error: ToolInputParsingException, fallback: unknown): unknown {
  const output = (error as { output?: unknown }).output
  if (typeof output === "string") {
    try {
      return JSON.parse(output)
    } catch {
      return output
    }
  }
  return fallback
}

function structuredOutputToolInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const toolSchema = normalizeToolSchemaForProvider(schema) as Record<string, unknown>
  if (schemaRootIsObject(schema)) return normalizeObjectToolSchema(toolSchema)
  return {
    type: "object",
    properties: {
      value: {
        ...toolSchema,
        description:
          typeof toolSchema.description === "string"
            ? toolSchema.description
            : "The final structured result value."
      }
    },
    required: ["value"],
    additionalProperties: false
  }
}

function normalizeToolSchemaForProvider(value: unknown): unknown {
  return normalizeTypeArraysForToolSchema(stripPatternForToolSchema(value))
}

function normalizeObjectToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...schema }
  const types = Array.isArray(normalized.type) ? normalized.type : [normalized.type]
  if (normalized.type === undefined || types.every((item) => item === "object")) {
    normalized.type = "object"
  }
  return normalized
}

function schemaRootIsObject(schema: Record<string, unknown>): boolean {
  if (schemaRootIncludesExplicitNull(schema)) return false
  if (!schemaRootAllowsObject(schema)) return false
  return !schemaRootAllowsNonObject(schema)
}

function schemaRootIncludesExplicitNull(schema: Record<string, unknown>): boolean {
  return validateJsonSchemaValue(schema, null).length === 0
}

function schemaRootAllowsObject(schema: Record<string, unknown>, depth = 0): boolean {
  if (depth > 8) return false
  const explicitTypes = schemaTypeNames(schema)
  if (explicitTypes.includes("object")) return true
  if (explicitTypes.length > 0) return false
  if (
    Array.isArray(schema.required) ||
    isPlainRecord(schema.properties) ||
    schema.additionalProperties !== undefined
  ) {
    return true
  }
  if (schema.const !== undefined || Array.isArray(schema.enum)) return false
  const variants = [...schemaVariantValues(schema.anyOf), ...schemaVariantValues(schema.oneOf)]
  if (variants.length > 0) {
    return variants.some((variant) => {
      if (variant === true) return true
      if (variant === false || !isPlainRecord(variant)) return false
      return schemaRootAllowsObject(variant, depth + 1)
    })
  }
  return !schemaHasScalarRootAssertions(schema)
}

function schemaRootAllowsNonObject(schema: Record<string, unknown>, depth = 0): boolean {
  if (depth > 8) return false
  const explicitTypes = schemaTypeNames(schema)
  if (explicitTypes.length > 0) return explicitTypes.some((type) => type !== "object")
  if (Array.isArray(schema.required) || isPlainRecord(schema.properties)) return false
  if (schema.const !== undefined) return !isPlainRecord(schema.const)
  if (Array.isArray(schema.enum)) return schema.enum.some((candidate) => !isPlainRecord(candidate))
  const variants = [...schemaVariantValues(schema.anyOf), ...schemaVariantValues(schema.oneOf)]
  if (variants.length > 0) {
    return variants.some((variant) => {
      if (variant === true) return true
      if (variant === false || !isPlainRecord(variant)) return false
      return schemaRootAllowsNonObject(variant, depth + 1)
    })
  }
  return true
}

function schemaTypeNames(schema: Record<string, unknown>): string[] {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  return types.filter((item): item is string => typeof item === "string")
}

function schemaHasScalarRootAssertions(schema: Record<string, unknown>): boolean {
  return (
    schema.items !== undefined ||
    schema.minItems !== undefined ||
    schema.maxItems !== undefined ||
    schema.minLength !== undefined ||
    schema.maxLength !== undefined ||
    schema.pattern !== undefined ||
    schema.minimum !== undefined ||
    schema.maximum !== undefined
  )
}

export function exampleStructuredOutputToolInput(schema: Record<string, unknown>): unknown {
  const example = tryExampleStructuredOutputToolInput(schema)
  if (example === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return undefined
  return example
}

function tryExampleStructuredOutputToolInput(
  schema: Record<string, unknown>
): unknown | typeof STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE {
  const value = exampleJsonValue(schema, { nodes: 0 })
  if (value === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  return schemaRootIsObject(schema) ? value : { value }
}

export function structuredOutputToolInputExampleJson(
  schema: Record<string, unknown>
): string | undefined {
  const example = tryExampleStructuredOutputToolInput(schema)
  if (example === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return undefined
  const candidate = schemaRootIsObject(schema) ? example : unwrapToolInput(example)
  if (validateJsonSchemaValue(schema, candidate).length > 0) return undefined
  try {
    const json = JSON.stringify(example, null, 2)
    return json.length <= STRUCTURED_OUTPUT_EXAMPLE_MAX_CHARS ? json : undefined
  } catch {
    return undefined
  }
}

function exampleJsonValue(
  schema: Record<string, unknown>,
  budget: { nodes: number },
  depth = 0
): unknown | typeof STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE {
  budget.nodes += 1
  if (budget.nodes > STRUCTURED_OUTPUT_EXAMPLE_MAX_NODES) {
    return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  }
  if (depth > 6) return null
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return (
      schema.enum.find((candidate) => validateJsonSchemaValue(schema, candidate).length === 0) ??
      schema.enum[0]
    )
  }
  const anyOfExample = exampleJsonVariant(schema, schema.anyOf, budget, depth)
  if (anyOfExample !== STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return anyOfExample
  const oneOfExample = exampleJsonVariant(schema, schema.oneOf, budget, depth)
  if (oneOfExample !== STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return oneOfExample
  if (
    (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) ||
    (Array.isArray(schema.oneOf) && schema.oneOf.length > 0)
  ) {
    return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  }
  const candidates = Array.isArray(schema.type) ? schema.type : [schema.type]
  const type = candidates.find(
    (item): item is string => typeof item === "string" && item !== "null"
  )
  if (!type && candidates.includes("null")) return null
  if (type === "array") {
    const minItems =
      typeof schema.minItems === "number" ? Math.max(0, Math.floor(schema.minItems)) : 0
    if (minItems > STRUCTURED_OUTPUT_EXAMPLE_ARRAY_MAX_ITEMS) {
      return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
    }
    const exampleItems = minItems > 0 ? minItems : 0
    const itemSchema =
      typeof schema.items === "object" && schema.items !== null
        ? (schema.items as Record<string, unknown>)
        : {}
    const out: unknown[] = []
    for (let index = 0; index < exampleItems; index += 1) {
      const item = exampleJsonValue(itemSchema, budget, depth + 1)
      if (item === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) {
        return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
      }
      out.push(item)
    }
    return out
  }
  if (type === "string") {
    const minLength =
      typeof schema.minLength === "number" ? Math.max(0, Math.floor(schema.minLength)) : 0
    if (minLength > 32) return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
    const candidates = [
      ...exampleStringsForPattern(typeof schema.pattern === "string" ? schema.pattern : undefined),
      "x".repeat(minLength)
    ]
    for (const candidate of candidates) {
      const padded =
        candidate.length < minLength
          ? candidate + candidate.slice(-1).repeat(minLength - candidate.length)
          : candidate
      if (validateJsonSchemaValue(schema, padded).length === 0) return padded
    }
    return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  }
  if (type === "number" || type === "integer") return exampleJsonNumber(schema, type === "integer")
  if (type === "boolean") return false
  if (type === "null") return null
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : []
  const keys = required.length > 0 ? required : Object.keys(properties)
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const child = properties[key]
    if (typeof child === "object" && child !== null) {
      const example = exampleJsonValue(child as Record<string, unknown>, budget, depth + 1)
      if (example === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) {
        return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
      }
      out[key] = example
    } else {
      out[key] = null
    }
  }
  return out
}

function exampleJsonVariant(
  schema: Record<string, unknown>,
  value: unknown,
  budget: { nodes: number },
  depth: number
): unknown | typeof STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE {
  const variants = schemaVariantValues(value)
  if (variants.length === 0) return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  const siblingAssertions = { ...schema }
  delete siblingAssertions.anyOf
  delete siblingAssertions.oneOf
  for (const variant of variants) {
    budget.nodes += 1
    if (budget.nodes > STRUCTURED_OUTPUT_EXAMPLE_MAX_NODES) {
      return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
    }
    if (variant === false) continue
    const candidateSchema =
      variant === true
        ? siblingAssertions
        : isPlainRecord(variant)
          ? { ...variant, ...siblingAssertions }
          : null
    if (candidateSchema === null) {
      continue
    }
    const candidate = exampleJsonValue(candidateSchema, budget, depth + 1)
    if (
      candidate !== STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE &&
      validateJsonSchemaValue(schema, candidate).length === 0
    ) {
      return candidate
    }
  }
  return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
}

function exampleStringsForPattern(pattern: string | undefined): string[] {
  if (!pattern) return []
  const candidates: string[] = []
  const literalPrefix = pattern.match(/^\^([A-Za-z0-9_-]+)/)?.[1]
  if (literalPrefix) candidates.push(literalPrefix)
  const repeatedLiteral = pattern.match(/^\^([A-Za-z0-9])\+\$$/)
  if (repeatedLiteral) candidates.push(repeatedLiteral[1])
  const exactClass = pattern.match(/^\^\[([^\]]+)\]\{(\d+)\}\$$/)
  if (exactClass) {
    const length = Number.parseInt(exactClass[2], 10)
    if (Number.isInteger(length) && length >= 0 && length <= 32) {
      candidates.push(exampleCharFromClass(exactClass[1]).repeat(length))
    }
  }
  const repeatedClass = pattern.match(/^\^\[([^\]]+)\]\+\$$/)
  if (repeatedClass) candidates.push(exampleCharFromClass(repeatedClass[1]))
  return [...new Set(candidates)]
}

function exampleCharFromClass(charClass: string): string {
  if (charClass.includes("A-Z")) return "A"
  if (charClass.includes("a-z")) return "a"
  if (charClass.includes("0-9") || charClass.includes("\\d")) return "0"
  const literal = charClass.match(/[A-Za-z0-9_-]/)?.[0]
  return literal ?? "x"
}

function exampleJsonNumber(schema: Record<string, unknown>, integer: boolean): number {
  const minimum = typeof schema.minimum === "number" ? schema.minimum : null
  const maximum = typeof schema.maximum === "number" ? schema.maximum : null
  let value = 0
  if (minimum !== null && value < minimum) value = integer ? Math.ceil(minimum) : minimum
  if (maximum !== null && value > maximum) value = integer ? Math.floor(maximum) : maximum
  return value
}

function stripPatternForToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPatternForToolSchema)
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === "pattern" && typeof child === "string") continue
    if (key === "const" || key === "enum") {
      out[key] = child
      continue
    }
    if (PROVIDER_SCHEMA_DROPPED_ANNOTATIONS.has(key)) continue
    if (key === "properties" && isPlainRecord(child)) {
      const properties: Record<string, unknown> = {}
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        properties[propertyName] = stripPatternForToolSchema(propertySchema)
      }
      out[key] = properties
      continue
    }
    out[key] = stripPatternForToolSchema(child)
  }
  return out
}

function normalizeTypeArraysForToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTypeArraysForToolSchema)
  if (typeof value === "boolean") return {}
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === "type" || key === "nullable") continue
    if (key === "const" || key === "enum") {
      out[key] = child
      continue
    }
    if (PROVIDER_SCHEMA_DROPPED_ANNOTATIONS.has(key)) continue
    if (key === "additionalProperties") {
      if (child === false) out[key] = false
      continue
    }
    if (key === "properties" && isPlainRecord(child)) {
      const properties: Record<string, unknown> = {}
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        properties[propertyName] = normalizeTypeArraysForToolSchema(propertySchema)
      }
      out[key] = properties
      continue
    }
    out[key] = normalizeTypeArraysForToolSchema(child)
  }
  const declaredTypes = Array.isArray(value.type) ? value.type : [value.type]
  const explicitTypes = declaredTypes.filter((item): item is string => typeof item === "string")
  const hasImplicitObjectShape = isPlainRecord(value.properties) || Array.isArray(value.required)
  const inferredTypes =
    explicitTypes.length > 0 ? explicitTypes : hasImplicitObjectShape ? ["object"] : []
  const nullableAcceptsNull =
    value.nullable === true &&
    inferredTypes.length > 0 &&
    !inferredTypes.includes("null") &&
    validateJsonSchemaValue(value, null).length === 0
  const types = nullableAcceptsNull ? [...inferredTypes, "null"] : inferredTypes
  if (types.length === 0) {
    return out
  }
  if (types.length === 1) {
    out.type = types[0]
    return out
  }
  const anyOf = types.map((type) => toolSchemaBranchForType(out, type))
  return { anyOf }
}

function toolSchemaBranchForType(
  schema: Record<string, unknown>,
  type: string
): Record<string, unknown> {
  const branch: Record<string, unknown> = {}
  for (const key of ["title", "description", "enum", "const", "anyOf", "oneOf"] as const) {
    if (schema[key] !== undefined) branch[key] = schema[key]
  }
  if (type === "object") {
    for (const key of ["properties", "required", "additionalProperties"] as const) {
      if (schema[key] !== undefined) branch[key] = schema[key]
    }
  } else if (type === "array") {
    for (const key of ["items", "minItems", "maxItems"] as const) {
      if (schema[key] !== undefined) branch[key] = schema[key]
    }
  } else if (type === "string") {
    for (const key of ["minLength", "maxLength"] as const) {
      if (schema[key] !== undefined) branch[key] = schema[key]
    }
  } else if (type === "number" || type === "integer") {
    for (const key of ["minimum", "maximum"] as const) {
      if (schema[key] !== undefined) branch[key] = schema[key]
    }
  }
  branch.type = type
  return branch
}

export function buildStructuredOutputRepairErrors(
  schema: Record<string, unknown>,
  input: unknown,
  errors: string[]
): string[] {
  const hints = [
    ...collectStringifiedJsonHints(structuredOutputToolInputSchema(schema), input),
    ...collectStringifiedJsonHints(schema, input),
    ...collectSemanticSingleValueJsonHints(schema, input)
  ]
  if (hints.length === 0) return errors
  return [...new Set([...hints, ...errors])]
}

function collectSemanticSingleValueJsonHints(
  schema: Record<string, unknown>,
  input: unknown
): string[] {
  if (schemaRootIsObject(schema) || !isPlainRecord(input)) return []
  const single = singleOwnEntry(input)
  if (single === null) return []
  return collectStringifiedJsonHints(schema, single.value, `$.${single.key}`)
}

function collectStringifiedJsonHints(
  schema: Record<string, unknown>,
  value: unknown,
  path = "$",
  depth = 0,
  budget: { nodes: number; stopped: boolean } = { nodes: 0, stopped: false }
): string[] {
  if (budget.stopped || depth > 8) return []
  budget.nodes += 1
  if (budget.nodes > STRUCTURED_OUTPUT_HINT_MAX_NODES) {
    budget.stopped = true
    return []
  }
  const hints: string[] = []
  for (const variant of schemaVariants(schema.anyOf)) {
    if (budget.stopped) break
    hints.push(...collectStringifiedJsonHints(variant, value, path, depth + 1, budget))
  }
  for (const variant of schemaVariants(schema.oneOf)) {
    if (budget.stopped) break
    hints.push(...collectStringifiedJsonHints(variant, value, path, depth + 1, budget))
  }
  const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type]
  const expectsArray = expectedTypes.includes("array")
  const expectsObject =
    expectedTypes.includes("object") ||
    (schema.type === undefined &&
      (isPlainRecord(schema.properties) || Array.isArray(schema.required)))
  if ((expectsArray || expectsObject) && typeof value === "string") {
    const parsed = parseLikelyJsonString(value)
    if (parsed !== undefined) {
      if ((expectsArray && Array.isArray(parsed)) || (expectsObject && isPlainRecord(parsed))) {
        hints.push(
          `${path}: pass ${expectsArray ? "an array" : "an object"} directly, not a JSON-encoded string. Use ${shortJson(parsed)} instead of ${shortJson(value)}.`
        )
      }
    }
  }
  if (Array.isArray(value)) {
    const itemSchema = isPlainRecord(schema.items) ? schema.items : null
    if (!itemSchema) return Array.from(new Set(hints))
    const maxItems = Math.min(value.length, STRUCTURED_OUTPUT_EXAMPLE_ARRAY_MAX_ITEMS)
    for (let index = 0; index < maxItems && !budget.stopped; index += 1) {
      hints.push(
        ...collectStringifiedJsonHints(
          itemSchema,
          value[index],
          `${path}[${index}]`,
          depth + 1,
          budget
        )
      )
    }
    return Array.from(new Set(hints))
  }
  if (!isPlainRecord(value)) return hints
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {}
  for (const [key, childSchema] of Object.entries(properties)) {
    if (budget.stopped) break
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (typeof childSchema !== "object" || childSchema === null) continue
    hints.push(
      ...collectStringifiedJsonHints(
        childSchema as Record<string, unknown>,
        value[key],
        `${path}.${key}`,
        depth + 1,
        budget
      )
    )
  }
  if (isPlainRecord(schema.additionalProperties)) {
    for (const key in value) {
      if (budget.stopped) break
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue
      const childValue = value[key]
      hints.push(
        ...collectStringifiedJsonHints(
          schema.additionalProperties,
          childValue,
          `${path}.${key}`,
          depth + 1,
          budget
        )
      )
    }
  }
  return Array.from(new Set(hints))
}

function schemaVariants(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => isPlainRecord(item))
}

function rootSchemaVariants(schema: Record<string, unknown>): Record<string, unknown>[] {
  return [...schemaVariants(schema.anyOf), ...schemaVariants(schema.oneOf)]
}

function schemaVariantValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parseLikelyJsonString(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return undefined
  if (trimmed.length > STRUCTURED_OUTPUT_HINT_PARSE_MAX_CHARS) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function shortJson(value: unknown): string {
  return boundedStableStringify(value, STRUCTURED_OUTPUT_HINT_JSON_MAX_CHARS)
}

function stableStringifyWithMetadata(value: unknown): { value: string; truncated: boolean } {
  return boundedStableStringifyWithMetadata(value, STRUCTURED_OUTPUT_SIGNATURE_MAX_CHARS)
}

function boundedStableStringify(value: unknown, maxChars: number): string {
  return boundedStableStringifyWithMetadata(value, maxChars).value
}

function boundedStableStringifyWithMetadata(
  value: unknown,
  maxChars: number
): { value: string; truncated: boolean } {
  const seen = new WeakSet<object>()
  let out = ""
  let truncated = false
  let lossy = false

  const append = (text: string): void => {
    if (truncated || maxChars <= 0) return
    const remaining = maxChars - out.length
    if (text.length <= remaining) {
      out += text
      return
    }
    out += text.slice(0, Math.max(0, remaining))
    truncated = true
  }

  const writeString = (text: string): void => {
    const maxInlineChars = Math.min(1_024, Math.max(16, maxChars))
    if (text.length > maxInlineChars) lossy = true
    const value =
      text.length > maxInlineChars
        ? `${text.slice(0, maxInlineChars)}...[truncated ${text.length - maxInlineChars} chars]`
        : text
    append(JSON.stringify(value))
  }

  const write = (node: unknown, depth: number): void => {
    if (truncated) return
    if (depth > 12) {
      lossy = true
      writeString("[MaxDepth]")
      return
    }
    if (node === null) {
      append("null")
      return
    }
    if (typeof node === "string") {
      writeString(node)
      return
    }
    if (typeof node === "number" || typeof node === "boolean") {
      append(JSON.stringify(node))
      return
    }
    if (typeof node === "bigint") {
      writeString(`${node.toString()}n`)
      return
    }
    if (typeof node === "undefined" || typeof node === "function" || typeof node === "symbol") {
      writeString(`[${typeof node}]`)
      return
    }
    if (typeof node !== "object") {
      writeString(String(node))
      return
    }
    if (seen.has(node)) {
      writeString("[Circular]")
      return
    }
    seen.add(node)
    if (Array.isArray(node)) {
      append("[")
      for (let index = 0; index < node.length; index += 1) {
        if (index > 0) append(",")
        write(node[index], depth + 1)
        if (truncated) break
      }
      append("]")
      seen.delete(node)
      return
    }
    append("{")
    const { entries, hasMore } = boundedSortedObjectEntries(node as Record<string, unknown>)
    for (let index = 0; index < entries.length; index += 1) {
      const [key, child] = entries[index]
      if (index > 0) append(",")
      writeString(key)
      append(":")
      write(child, depth + 1)
      if (truncated) break
    }
    if (hasMore && !truncated) {
      lossy = true
      if (entries.length > 0) append(",")
      writeString("...[truncatedKeys]")
      append(":")
      writeString(`first ${STRUCTURED_OUTPUT_STRINGIFY_MAX_OBJECT_KEYS} keys only`)
    }
    append("}")
    seen.delete(node)
  }

  write(value, 0)
  if (!truncated) return { value: out, truncated: lossy }
  const suffix = "...[truncated]"
  if (maxChars <= suffix.length) return { value: suffix.slice(0, maxChars), truncated: true }
  return { value: `${out.slice(0, maxChars - suffix.length)}${suffix}`, truncated: true }
}

function boundedSortedObjectEntries(record: Record<string, unknown>): {
  entries: Array<[string, unknown]>
  hasMore: boolean
} {
  const entries: Array<[string, unknown]> = []
  let hasMore = false
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    if (entries.length >= STRUCTURED_OUTPUT_STRINGIFY_MAX_OBJECT_KEYS) {
      hasMore = true
      break
    }
    entries.push([key, record[key]])
  }
  entries.sort(([a], [b]) => a.localeCompare(b))
  return { entries, hasMore }
}

/**
 * Providers deliver tool args as a JSON object. When the model wraps the whole
 * answer under a conventional single key (input/result/value/data), unwrap one
 * level so near-miss calls still validate. Do not unwrap arbitrary single-key
 * objects: wide schemas like `{}` legitimately accept `{ foo: "bar" }`.
 */
function unwrapToolInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const single = singleOwnEntry(record)
  if (single !== null && isStructuredOutputWrapperKey(single.key)) return single.value
  return input
}

function singleToolInputValue(input: unknown): unknown | typeof STRUCTURED_OUTPUT_NO_SINGLE_VALUE {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return STRUCTURED_OUTPUT_NO_SINGLE_VALUE
  }
  const single = singleOwnEntry(input as Record<string, unknown>)
  return single === null ? STRUCTURED_OUTPUT_NO_SINGLE_VALUE : single.value
}

function singleOwnEntry(record: Record<string, unknown>): { key: string; value: unknown } | null {
  let found: { key: string; value: unknown } | null = null
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    if (found !== null) return null
    found = { key, value: record[key] }
  }
  return found
}

function isStructuredOutputWrapperKey(key: string): boolean {
  return key === "input" || key === "result" || key === "value" || key === "data"
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
export async function consumeValuesStream(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal,
  shouldStop?: (snapshot: unknown) => boolean,
  onValues?: (snapshot: unknown) => void
): Promise<unknown> {
  let lastValues: unknown
  for await (const chunk of stream) {
    if (signal.aborted) break
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
      if (shouldStop?.(lastValues)) break
    }
  }
  return lastValues
}

interface MessageLike {
  additional_kwargs?: { tool_calls?: unknown[] }
  content?: unknown
  kwargs?: {
    additional_kwargs?: { tool_calls?: unknown[] }
    content?: unknown
    tool_calls?: unknown[]
    invalid_tool_calls?: unknown[]
    tool_call_id?: unknown
    usage_metadata?: { output_tokens?: number }
  }
  usage_metadata?: { output_tokens?: number }
  tool_calls?: unknown[]
  invalid_tool_calls?: unknown[]
  tool_call_id?: unknown
  id?: unknown
  _getType?: () => string
}

function snapshotMessages(snapshot: unknown): MessageLike[] {
  if (typeof snapshot !== "object" || snapshot === null) return []
  const messages = (snapshot as { messages?: unknown }).messages
  return Array.isArray(messages) ? (messages as MessageLike[]) : []
}

function messageClassName(message: MessageLike): string {
  if (typeof message._getType === "function") {
    try {
      return message._getType()
    } catch {
      /* fall through to serialized form */
    }
  }
  const id = message.id
  if (Array.isArray(id)) return String(id[id.length - 1] ?? "")
  return String((message as { type?: unknown }).type ?? "")
}

function isAiMessage(message: MessageLike): boolean {
  const className = messageClassName(message).toLowerCase()
  return className === "ai" || className.includes("aimessage")
}

function isToolMessage(message: MessageLike): boolean {
  const className = messageClassName(message).toLowerCase()
  return className === "tool" || className.includes("toolmessage")
}

function messageToolCalls(message: MessageLike): unknown[] {
  // Collect ALL tool calls a message carries — deduped by id — across every shape it can take: live
  // vs serialized, normalized `tool_calls`, raw `additional_kwargs.tool_calls`, and the canonical
  // malformed bucket `invalid_tool_calls`. A "first non-empty" scan would MISS a malformed call when
  // the SAME turn also has a valid one (valid → tool_calls, malformed → invalid_tool_calls), and the
  // dangling/fail-fast logic must see BOTH: deepseek can leave normalized EMPTY while the real call
  // lives in additional_kwargs/invalid_tool_calls (truncated/unparseable args), or emit valid +
  // invalid side by side. Returning the UNION feeds every id to danglingToolCallIds, which then
  // cross-checks normalizedToolCallIds: a dangling id NOT in the normalized set is unrepairable
  // (patchToolCalls would drop any synthesized result) → fail-fast retry instead of a 400. Dedup
  // keeps the first (normalized) form when a call appears in several shapes; id-less calls are kept
  // as-is (danglingToolCallIds ignores them; token estimation may double-count, which errs high).
  const out: unknown[] = []
  const seen = new Set<string>()
  const candidates = [
    message.tool_calls,
    message.kwargs?.tool_calls,
    message.additional_kwargs?.tool_calls,
    message.kwargs?.additional_kwargs?.tool_calls,
    message.invalid_tool_calls,
    message.kwargs?.invalid_tool_calls
  ]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const call of candidate) {
      const id = toolCallId(call)
      if (id !== undefined) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      out.push(call)
    }
  }
  return out
}

function toolCallId(toolCall: unknown): string | undefined {
  if (!isPlainRecord(toolCall)) return undefined
  return typeof toolCall.id === "string" && toolCall.id.trim() ? toolCall.id : undefined
}

function toolMessageToolCallId(message: MessageLike): string | undefined {
  const id = message.tool_call_id ?? message.kwargs?.tool_call_id
  return typeof id === "string" && id.trim() ? id : undefined
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

/**
 * Sums reported output tokens across assistant messages; falls back to a
 * chars/4 estimate when the provider reports no usage (common on mid-tier
 * gateways) so the workflow budget still functions.
 */
export function extractOutputTokens(snapshot: unknown, text: string): number {
  let total = 0
  for (const message of snapshotMessages(snapshot)) {
    if (!isAiMessage(message)) continue
    const usage = message.usage_metadata ?? message.kwargs?.usage_metadata
    const reported = usage?.output_tokens
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
      // Authoritative per-message usage (langchain reports per LLM call).
      total += reported
    } else {
      // This message reported NO usage — estimate ITS output (text + serialized
      // tool-call args). Filling per-message rather than all-or-nothing means a
      // gateway that meters only some messages doesn't undercount; a hard spend
      // cap should err high, not low.
      total += estimateTokenCount(
        extractTextFromUnknownContent(message.content ?? message.kwargs?.content)
      )
      const toolCalls = messageToolCalls(message)
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        total += estimateTokenCount(stringifyToolCalls(toolCalls))
      }
    }
  }
  if (total > 0) return total
  // Last resort when the snapshot carried no assistant content at all.
  return Math.max(1, estimateTokenCount(text))
}

function extractWorkflowToolCallCount(snapshot: unknown): number {
  let count = 0
  const seenIds = new Set<string>()
  for (const message of snapshotMessages(snapshot)) {
    if (!isAiMessage(message)) continue
    for (const call of messageNormalizedToolCalls(message)) {
      const id = toolCallId(call)
      if (id) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
      }
      count += 1
    }
  }
  return count
}

/**
 * Rough output-token estimate for gateways that report no usage. CJK characters
 * count ~1 token each (a flat chars/4 underestimates Chinese ~3-4x); other
 * characters count ~1 token per 4. Inexact by nature, but far closer than
 * chars/4 alone for the app's primary (Chinese) workloads.
 */
function estimateTokenCount(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk += 1
  }
  // `text.length` is UTF-16 units; astral CJK chars (Ext B+) count as 1 above
  // but occupy 2 units, so `other` is at most a hair high — safe for a spend cap.
  const other = Math.max(0, text.length - cjk)
  return Math.ceil(cjk + other / 4)
}

/** Common CJK ranges where a character is ~1 token (a flat chars/4 underestimates). */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) || // symbols/punct, kana, CJK Unified + Ext A
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xff00 && code <= 0xffef) || // halfwidth/fullwidth forms
    (code >= 0x20000 && code <= 0x3ffff) // CJK Unified Ext B–F + compat supplement
  )
}

function stringifyToolCalls(toolCalls: unknown): string {
  try {
    return JSON.stringify(toolCalls) ?? ""
  } catch {
    return ""
  }
}

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
