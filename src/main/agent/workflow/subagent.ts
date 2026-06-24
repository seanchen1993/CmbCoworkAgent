import { tool } from "langchain"
import { z } from "zod"
import { HumanMessage } from "@langchain/core/messages"
import type { DynamicStructuredTool } from "@langchain/core/tools"
import type { AgentShellAccess } from "../agent-registry"
import { extractTextFromUnknownContent } from "../coordinator-worker-stream"
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
  runId: string
  signal: AbortSignal
  /** Role system prompt resolved from the call's agentType (prepended to the
   * subagent base prompt). Undefined for the default general agent. */
  roleSystemPrompt?: string
  /** agentType-resolved tool denylist (project tool names). Undefined = none. */
  disallowedTools?: string[]
  /** agentType-resolved shell policy. Undefined = full. */
  shellAccess?: AgentShellAccess
}

/** A structured-output failure surfaced by runOnce (no schema-valid result after
 * the in-session tool-retries + nudge). Both messages mention `structured_output`. */
function isStructuredOutputFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes("structured_output")
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
      const schemaRetry = request.schema !== undefined && isStructuredOutputFailure(error)
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

  try {
    // agentIndex is deterministic, so after a crash-resume this threadId can
    // collide with a dead run's leftover checkpoint — continuing on that
    // transcript poisons the subagent (or 400s on a dangling tool_call).
    // Purge any stale per-thread state before creating the runtime.
    await deps.cleanupThread(threadId).catch(() => undefined)

    const additionalTools = request.schema
      ? [createStructuredOutputTool(request.schema, structured)]
      : undefined
    const baseExtraPrompt = request.schema
      ? buildWorkflowSubagentStructuredPrompt(JSON.stringify(request.schema, null, 2))
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

    const streamConfig = {
      configurable: { thread_id: threadId },
      callbacks: [],
      signal: controller.signal,
      streamMode: ["values"] as Array<"values">,
      recursionLimit: 1000
    }

    // raceWithAbort so a stream that never honours controller.signal (a dead async
    // iterator / a gateway that ignores the abort) can't hang the whole run — the
    // parent abort or configured per-agent timeout still unblocks us.
    let snapshot = await raceWithAbort(
      (async () =>
        consumeValuesStream(
          await runtime.stream({ messages: [new HumanMessage(request.prompt)] }, streamConfig),
          controller.signal
        ))(),
      controller.signal
    )

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
      snapshot = await raceWithAbort(
        (async () =>
          consumeValuesStream(
            await runtime.stream(
              {
                messages: [
                  new HumanMessage(
                    "You have not returned a valid structured result yet. Call the structured_output tool now, exactly once, with an input matching the required JSON Schema. Do not reply with plain text."
                  )
                ]
              },
              streamConfig
            ),
            controller.signal
          ))(),
        controller.signal
      )
    }

    throwIfAborted(controller.signal, request.signal, timeoutMs)

    const text = extractFinalAssistantText(snapshot)
    const outputTokens = extractOutputTokens(snapshot, text)

    if (request.schema) {
      if (!isStructuredAccepted(structured, request.schema)) {
        throw new Error(
          structured.called
            ? "subagent called structured_output but every attempt failed schema validation"
            : "subagent completed without calling the structured_output tool"
        )
      }
      return { text, structured: structured.value, outputTokens, modelFellBack }
    }

    if (!text.trim()) {
      throw new Error("subagent produced no assistant output")
    }
    return { text, structured: undefined, outputTokens, modelFellBack }
  } catch (error) {
    throwIfAborted(controller.signal, request.signal, timeoutMs)
    throw error
  } finally {
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

function createStructuredOutputTool(
  schema: Record<string, unknown>,
  capture: { value: unknown; called: boolean }
): DynamicStructuredTool {
  let attempts = 0
  return tool(
    async (input: unknown) => {
      attempts += 1
      capture.called = true
      // Tool args always arrive as a JSON object. Mid-tier models often wrap
      // the real answer one level deep — try the direct value first, then the
      // single-key unwrap, and accept whichever validates.
      const candidates = [input, unwrapToolInput(input, schema)].filter(
        (candidate, index, all) => all.indexOf(candidate) === index
      )
      let errors: string[] = []
      for (const candidate of candidates) {
        errors = validateJsonSchemaValue(schema, candidate)
        if (errors.length === 0) {
          capture.value = candidate
          return "Structured output recorded successfully. End your turn now — no further text is needed."
        }
      }
      if (attempts >= WORKFLOW_STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
        return `StructuredOutput schema mismatch (attempt limit reached):\n${errors.join("\n")}`
      }
      return `StructuredOutput schema mismatch:\n${errors.join("\n")}\nRead the errors and call structured_output again with a corrected input.`
    },
    {
      name: "structured_output",
      description:
        "Return your final machine-readable answer for this task. Call it exactly once with an input matching the JSON Schema given in your instructions. The orchestration script reads ONLY this tool call.",
      schema: z.record(z.string(), z.unknown())
    }
  ) as unknown as DynamicStructuredTool
}

/**
 * Providers deliver tool args as a JSON object. When the model wraps the whole
 * answer under a single key — a conventional one (input/result/value/data), or
 * any single key when the schema's root is not an object (arrays/strings can
 * only arrive wrapped) — unwrap one level so near-miss calls still validate.
 */
function unwrapToolInput(input: unknown, schema: Record<string, unknown>): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1) return input
  const rootIsObject = schema.type === undefined || schema.type === "object"
  if (!rootIsObject || ["input", "result", "value", "data"].includes(keys[0])) {
    return record[keys[0]]
  }
  return input
}

function isStructuredAccepted(
  capture: { value: unknown; called: boolean },
  schema: Record<string, unknown>
): boolean {
  return capture.value !== undefined && validateJsonSchemaValue(schema, capture.value).length === 0
}

/** Consumes a [mode, data] stream and returns the last "values" snapshot. */
async function consumeValuesStream(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal
): Promise<unknown> {
  let lastValues: unknown
  for await (const chunk of stream) {
    if (signal.aborted) break
    if (!Array.isArray(chunk) || chunk.length < 2) continue
    const [mode, data] = chunk as [string, unknown]
    if (mode === "values") lastValues = data
  }
  return lastValues
}

interface MessageLike {
  content?: unknown
  kwargs?: { content?: unknown; usage_metadata?: { output_tokens?: number } }
  usage_metadata?: { output_tokens?: number }
  tool_calls?: unknown[]
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

function extractFinalAssistantText(snapshot: unknown): string {
  const messages = snapshotMessages(snapshot)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isAiMessage(message)) continue
    const toolCalls = message.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) continue
    const text = extractTextFromUnknownContent(message.content ?? message.kwargs?.content)
    if (text.trim()) return text.trim()
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
      const toolCalls = message.tool_calls
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        total += estimateTokenCount(stringifyToolCalls(toolCalls))
      }
    }
  }
  if (total > 0) return total
  // Last resort when the snapshot carried no assistant content at all.
  return Math.max(1, estimateTokenCount(text))
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
      const timer = setTimeout(resolveDelay, ms)
      timer.unref?.()
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
