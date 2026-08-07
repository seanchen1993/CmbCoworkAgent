import { createMiddleware } from "langchain"
import type { TraceCollectorOptions } from "./collector"
import {
  createTraceCollectorSafely,
  finishTraceInBackground,
  runTraceSideEffect,
  type TraceCollector
} from "./collector"
import { SkillUsageDetector } from "../skill-evolution/usage-detector"
import type { TraceChatMessage, TraceContext, TraceOutcome, TraceTokenUsage } from "./types"
import { normalizeTraceTokenUsage } from "./token-usage"
import { nowIsoLocal } from "../../util/local-time"
import { extractVisibleReasoning, truncateReasoningForTrace } from "../../../shared/model-reasoning"

/**
 * Metadata/configurable key attached to deepagents' task-owned subgraph runs.
 * The renderer and stream converter intentionally mirror this literal because
 * they cannot import main-process runtime code.
 */
export const SOLO_TASK_OWNER_METADATA_KEY = "cmb_subagent_owner_tool_call_id"

const MAX_TRACE_CONTENT = 2000
const MODEL_INPUT_WINDOW = 12

type AnyRecord = Record<string, unknown>

interface SoloTaskTraceEntry {
  tracer: TraceCollector
  skillUsageDetector: SkillUsageDetector
}

export interface SoloTaskStartInput {
  ownerId: string
  description?: string
  subagentType?: string
}

interface SoloTaskTraceDependencies {
  createTracer: (
    threadId: string,
    userMessage: string,
    modelId: string,
    options: TraceCollectorOptions,
    scope: string
  ) => TraceCollector | undefined
  finishTracer: (
    tracer: TraceCollector,
    outcome: TraceOutcome,
    errorMessage?: string,
    scope?: string
  ) => void
  runSideEffect: (scope: string, effect: () => void) => void
  createSkillUsageDetector: () => SkillUsageDetector
}

export interface SoloTaskTraceManagerOptions {
  parent: TraceContext
  modelId?: string
  dependencies?: Partial<SoloTaskTraceDependencies>
}

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined
}

function trimTraceContent(value: string): string {
  return value.length > MAX_TRACE_CONTENT
    ? `${value.slice(0, MAX_TRACE_CONTENT)}\n…(truncated)`
    : value
}

function extractText(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return ""
  if (value instanceof Error) return trimTraceContent(value.message || value.name)
  if (typeof value === "string") return trimTraceContent(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    return trimTraceContent(
      value
        .map((item) => extractText(item, depth + 1))
        .filter(Boolean)
        .join("\n")
    )
  }

  const record = asRecord(value)
  if (!record) return ""
  for (const key of ["text", "content", "output", "result"]) {
    const text = extractText(record[key], depth + 1)
    if (text) return text
  }
  const kwargsText = extractText(asRecord(record.kwargs)?.content, depth + 1)
  if (kwargsText) return kwargsText
  const update = asRecord(record.update)
  const messages = update?.messages
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const text = extractText(messages[index], depth + 1)
      if (text) return text
    }
  }
  const keys = Object.keys(record).slice(0, 12)
  return keys.length > 0 ? `{${keys.join(", ")}}` : String(value)
}

function messageRole(message: AnyRecord): TraceChatMessage["role"] {
  const explicitType =
    (typeof message.type === "string" && message.type) ||
    (typeof asRecord(message.kwargs)?.type === "string" &&
      (asRecord(message.kwargs)?.type as string)) ||
    ""
  const constructorName =
    typeof (message as { constructor?: { name?: unknown } }).constructor?.name === "string"
      ? ((message as { constructor: { name: string } }).constructor.name ?? "")
      : ""
  const marker = `${constructorName} ${explicitType}`.toLowerCase()
  if (marker.includes("human") || marker.includes("user")) return "user"
  if (marker.includes("assistant") || marker.includes("ai")) return "assistant"
  if (marker.includes("system")) return "system"
  if (marker.includes("tool")) return "tool"
  return "unknown"
}

function normalizeMessage(message: unknown): TraceChatMessage {
  const record = asRecord(message) ?? {}
  const kwargs = asRecord(record.kwargs)
  const content = record.content ?? kwargs?.content
  const name = record.name ?? kwargs?.name
  const toolCallId = record.tool_call_id ?? kwargs?.tool_call_id
  return {
    role: messageRole(record),
    content: extractText(content),
    ...(typeof name === "string" && name ? { name } : {}),
    ...(typeof toolCallId === "string" && toolCallId ? { toolCallId } : {})
  }
}

function responseTokenUsage(response: AnyRecord): TraceTokenUsage | undefined {
  const responseMetadata = asRecord(response.response_metadata)
  return normalizeTraceTokenUsage(
    response.usage_metadata ?? responseMetadata?.token_usage ?? responseMetadata?.usage
  )
}

function responseToolCalls(response: AnyRecord): Array<{
  id?: string
  name: string
  args: Record<string, unknown>
}> {
  const kwargs = asRecord(response.kwargs)
  const rawCalls = response.tool_calls ?? kwargs?.tool_calls
  if (!Array.isArray(rawCalls)) return []
  return rawCalls.map((rawCall) => {
    const call = asRecord(rawCall) ?? {}
    return {
      ...(typeof call.id === "string" && call.id ? { id: call.id } : {}),
      name: typeof call.name === "string" && call.name ? call.name : "unknown",
      args: asRecord(call.args) ?? {}
    }
  })
}

function requestOwnerId(request: unknown): string | undefined {
  const record = asRecord(request)
  const runtime = asRecord(record?.runtime)
  const candidates = [
    asRecord(runtime?.configurable)?.[SOLO_TASK_OWNER_METADATA_KEY],
    asRecord(asRecord(runtime?.config)?.configurable)?.[SOLO_TASK_OWNER_METADATA_KEY],
    asRecord(record?.configurable)?.[SOLO_TASK_OWNER_METADATA_KEY],
    asRecord(record?.metadata)?.[SOLO_TASK_OWNER_METADATA_KEY],
    asRecord(runtime?.metadata)?.[SOLO_TASK_OWNER_METADATA_KEY]
  ]
  const ownerId = candidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0
  )
  return ownerId?.trim()
}

function safeChildThreadId(parentThreadId: string, ownerId: string): string {
  const safeOwner = ownerId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unknown"
  return `${parentThreadId}__task_${safeOwner}`
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Task subagent failed"
  if (typeof error === "string" && error) return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isToolError(result: unknown, output: string): boolean {
  const record = asRecord(result)
  const kwargs = asRecord(record?.kwargs)
  return (
    record?.status === "error" ||
    record?.is_error === true ||
    kwargs?.status === "error" ||
    kwargs?.is_error === true ||
    /^(error:|mcp tool error:|tool error:|failed:)/i.test(output.trim())
  )
}

/** Read the task owner id from a LangGraph `messages` stream payload. */
export function getSoloTaskOwnerIdFromStreamPayload(payload: unknown): string | undefined {
  if (!Array.isArray(payload)) return undefined
  const metadata = asRecord(payload[1])
  const ownerId = metadata?.[SOLO_TASK_OWNER_METADATA_KEY]
  return typeof ownerId === "string" && ownerId.trim() ? ownerId.trim() : undefined
}

/**
 * Sidecar collector for synchronous deepagents `task` subagents in Solo mode.
 * All methods are telemetry-only and contain their own failure boundary.
 */
export class SoloTaskTraceManager {
  private readonly parent: TraceContext
  private readonly dependencies: SoloTaskTraceDependencies
  private readonly active = new Map<string, SoloTaskTraceEntry>()
  private readonly observedOwnerIds = new Set<string>()
  private readonly finishedOwnerIds = new Set<string>()
  private modelId: string

  readonly middleware: ReturnType<typeof createMiddleware>

  constructor(options: SoloTaskTraceManagerOptions) {
    this.parent = options.parent
    this.modelId = options.modelId ?? "unknown"
    this.dependencies = {
      createTracer: createTraceCollectorSafely,
      finishTracer: finishTraceInBackground,
      runSideEffect: runTraceSideEffect,
      createSkillUsageDetector: () => new SkillUsageDetector(),
      ...options.dependencies
    }
    this.middleware = createMiddleware({
      name: "soloTaskTraceSidecar",
      // `beforeModel` receives the full graph state, unlike wrapModelCall which
      // is intentionally scoped to this middleware's own state schema.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      beforeModel: (state: any, runtime: any) => this.beforeModel(state, runtime),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wrapModelCall: async (request: any, handler: any) => this.wrapModelCall(request, handler),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wrapToolCall: async (request: any, handler: any) => this.wrapToolCall(request, handler)
    })
  }

  setModelId(modelId: string | undefined): void {
    if (modelId) this.modelId = modelId
  }

  startTask(input: SoloTaskStartInput): void {
    try {
      const ownerId = input.ownerId.trim()
      if (!ownerId || this.active.has(ownerId) || this.finishedOwnerIds.has(ownerId)) return
      const childThreadId = safeChildThreadId(this.parent.threadId, ownerId)
      const targetAgent = input.subagentType?.trim() || "task"
      const skillUsageDetector = this.dependencies.createSkillUsageDetector()
      const tracer = this.dependencies.createTracer(
        childThreadId,
        input.description?.trim() || `Task subagent ${targetAgent}`,
        this.modelId,
        {
          traceKind: "subagent",
          executionMode: "normal",
          rootTraceId: this.parent.rootTraceId,
          rootThreadId: this.parent.rootThreadId,
          parentTraceId: this.parent.traceId,
          parentThreadId: this.parent.threadId,
          parentSpanId: `task:${ownerId}`,
          linkType: "parent_child",
          subagentKind: "task",
          subagentRunId: ownerId,
          subagentThreadId: childThreadId,
          handoffAction: "task",
          handoffSourceAgent: "main",
          handoffTargetAgent: targetAgent,
          harnessFeature: this.parent.harnessFeature,
          includeSkillEval: false
        },
        "SoloTask"
      )
      if (!tracer) return
      this.active.set(ownerId, { tracer, skillUsageDetector })
    } catch (error) {
      console.warn("[SoloTask] trace setup failed; continuing without child telemetry:", error)
    }
  }

  /** True after child middleware observed the owner, including while deferred finish is pending. */
  hasCapturedTask(ownerId: string | undefined): boolean {
    return Boolean(ownerId && this.observedOwnerIds.has(ownerId))
  }

  finishTask(ownerId: string, outcome: TraceOutcome, resultOrError?: unknown): void {
    try {
      if (this.finishedOwnerIds.has(ownerId)) return
      const entry = this.active.get(ownerId)
      if (!entry) return
      this.finishedOwnerIds.add(ownerId)
      this.active.delete(ownerId)
      const output = extractText(resultOrError)
      this.runSideEffect("SoloTask terminal trace", () => {
        this.syncSkills(entry)
        entry.tracer.addTerminalNode({
          type: outcome === "error" ? "error" : outcome === "cancelled" ? "cancel" : "message",
          status:
            outcome === "error"
              ? "error"
              : outcome === "cancelled"
                ? "cancelled"
                : outcome === "unknown"
                  ? "unknown"
                  : "success",
          output: output || undefined
        })
      })
      this.dependencies.finishTracer(
        entry.tracer,
        outcome,
        outcome === "success" ? undefined : output || describeError(resultOrError),
        "SoloTask"
      )
    } catch (error) {
      console.warn("[SoloTask] trace completion failed; continuing agent run:", error)
    }
  }

  finishActiveTasks(outcome: TraceOutcome, reason?: string): void {
    for (const ownerId of Array.from(this.active.keys())) {
      this.finishTask(ownerId, outcome, reason)
    }
  }

  private syncSkills(entry: SoloTaskTraceEntry): void {
    entry.tracer.setUsedSkills(entry.skillUsageDetector.getUsedSkillNames())
    entry.tracer.setSkillSource(entry.skillUsageDetector.getUsedSkillSourceRefs())
    entry.tracer.setEvolvedSkills(entry.skillUsageDetector.getUsedEvolvedSkillNames())
  }

  private runSideEffect(scope: string, effect: () => void): boolean {
    let completed = false
    try {
      this.dependencies.runSideEffect(scope, () => {
        effect()
        completed = true
      })
    } catch (error) {
      console.warn(`[${scope}] trace update failed; continuing without this telemetry:`, error)
    }
    return completed
  }

  private beforeModel(state: unknown, runtime: unknown): void {
    const ownerId = requestOwnerId({ runtime })
    if (!ownerId) return
    const entry = this.active.get(ownerId)
    if (!entry) return
    const skillsMetadata = asRecord(state)?.skillsMetadata
    if (!Array.isArray(skillsMetadata) || skillsMetadata.length === 0) return
    this.runSideEffect("SoloTask Skill observer", () => {
      entry.skillUsageDetector.onSkillsMetadata(skillsMetadata)
      this.syncSkills(entry)
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async wrapModelCall(request: any, handler: any): Promise<any> {
    const ownerId = requestOwnerId(request)
    if (!ownerId) return handler(request)
    const entry = this.active.get(ownerId)
    if (!entry) return handler(request)

    let llmNodeId: string | undefined
    const startedAt = nowIsoLocal()
    this.runSideEffect("SoloTask model start", () => {
      const inputMessages = Array.isArray(request.messages)
        ? request.messages.slice(-MODEL_INPUT_WINDOW).map(normalizeMessage)
        : []
      llmNodeId = entry.tracer.beginLlmNode({
        startedAt,
        input: inputMessages,
        metadata: { ownerTaskToolCallId: ownerId }
      })
    })

    try {
      const response = await handler(request)
      const modelRecorded = this.runSideEffect("SoloTask model result", () => {
        const responseRecord = asRecord(response) ?? {}
        const inputMessages = Array.isArray(request.messages)
          ? request.messages.slice(-MODEL_INPUT_WINDOW).map(normalizeMessage)
          : []
        const toolCalls = responseToolCalls(responseRecord)
        const responseMetadata = asRecord(responseRecord.response_metadata)
        const modelName = responseMetadata?.model_name ?? responseMetadata?.model
        if (typeof modelName === "string" && modelName) entry.tracer.setModelName(modelName)
        const messageId =
          typeof responseRecord.id === "string"
            ? responseRecord.id
            : typeof asRecord(responseRecord.kwargs)?.id === "string"
              ? (asRecord(responseRecord.kwargs)?.id as string)
              : undefined
        const output = extractText(
          responseRecord.content ?? asRecord(responseRecord.kwargs)?.content
        )
        const reasoning = truncateReasoningForTrace(
          extractVisibleReasoning(responseRecord, MAX_TRACE_CONTENT + 1),
          MAX_TRACE_CONTENT
        )
        const tokenUsage = responseTokenUsage(responseRecord)

        entry.tracer.recordModelCall({
          ...(messageId ? { messageId } : {}),
          startedAt,
          inputMessages,
          outputMessage: {
            role: "assistant",
            content: output,
            ...(reasoning ? { reasoning } : {})
          },
          toolCalls: toolCalls.map((call) => ({ name: call.name, args: call.args })),
          tokenUsage
        })
        entry.tracer.beginStep()
        for (const call of toolCalls) {
          entry.tracer.recordToolCall({ name: call.name, args: call.args })
        }
        entry.tracer.endStep(output)
        entry.tracer.endLlmNode({
          nodeId: llmNodeId,
          status: "success",
          output,
          metadata: {
            tokenUsage,
            toolCallCount: toolCalls.length,
            ...(reasoning ? { reasoning } : {})
          }
        })
      })
      if (modelRecorded) this.observedOwnerIds.add(ownerId)
      return response
    } catch (error) {
      this.runSideEffect("SoloTask model error", () => {
        entry.tracer.endLlmNode({
          nodeId: llmNodeId,
          status: "error",
          output: describeError(error)
        })
      })
      throw error
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async wrapToolCall(request: any, handler: any): Promise<any> {
    const ownerId = requestOwnerId(request)
    if (!ownerId) return handler(request)
    const entry = this.active.get(ownerId)
    if (!entry) return handler(request)

    const toolCall = asRecord(request.toolCall) ?? {}
    const toolCallId = typeof toolCall.id === "string" ? toolCall.id : undefined
    const toolName = typeof toolCall.name === "string" && toolCall.name ? toolCall.name : "unknown"
    const toolArgs = asRecord(toolCall.args) ?? {}
    let toolNodeId: string | undefined
    this.runSideEffect("SoloTask tool start", () => {
      if (toolName === "read_file") {
        const readPath =
          (typeof toolArgs.path === "string" && toolArgs.path) ||
          (typeof toolArgs.file_path === "string" && toolArgs.file_path) ||
          ""
        if (readPath && entry.skillUsageDetector.onReadFilePath(readPath)) this.syncSkills(entry)
      }
      toolNodeId = entry.tracer.addToolNode({
        name: toolName,
        input: toolArgs,
        toolCallId,
        metadata: { ownerTaskToolCallId: ownerId }
      })
    })

    try {
      const result = await handler(request)
      this.runSideEffect("SoloTask tool result", () => {
        const output = extractText(result)
        entry.tracer.addToolResultNode({
          parentId: toolNodeId,
          toolCallId,
          output,
          status: isToolError(result, output) ? "error" : "success"
        })
      })
      return result
    } catch (error) {
      this.runSideEffect("SoloTask tool error", () => {
        entry.tracer.addToolResultNode({
          parentId: toolNodeId,
          toolCallId,
          output: describeError(error),
          status: "error"
        })
      })
      throw error
    }
  }
}
