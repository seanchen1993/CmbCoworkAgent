import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { setTimeout as delay } from "node:timers/promises"
import type { ProjectRunReporter } from "./run-progress"
import { guardedProjectStream, ProjectStreamIdleError } from "./stream-guard"

// Match the main runtime's pinned-model budget (7 attempts = initial + 6 retries).
// Keep retry execution here: the project Agent does not participate in runtime model failover.
const PROJECT_MODEL_MAX_RETRIES = 6
const MAX_RETRY_AFTER_MS = 120_000

export interface ProjectAnalysisModel {
  stream(
    messages: BaseMessage[],
    options: { signal: AbortSignal }
  ): Promise<AsyncIterable<AIMessageChunk>>
}
export function projectModelStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  const status = Number(value.status ?? value.statusCode ?? value.response?.status)
  return Number.isFinite(status) ? status : undefined
}
export class ProjectModelRequestError extends Error {
  readonly status: number | undefined
  constructor(
    error: unknown,
    readonly retries: number
  ) {
    super(error instanceof Error ? error.message : "模型连接失败", { cause: error })
    this.status = projectModelStatus(error)
  }
}
export class ProjectModelOutputError extends Error {
  constructor(
    message: string,
    readonly canRetry = true,
    readonly retryInstruction?: string
  ) {
    super(message)
  }
}
function retryable(error: unknown): boolean {
  if (error instanceof ProjectStreamIdleError || error instanceof SyntaxError) return true
  if (error instanceof ProjectModelOutputError) return error.canRetry
  const status = projectModelStatus(error)
  if (status !== undefined) return [408, 425, 429, 433, 500, 502, 503, 504].includes(status)
  if (!(error instanceof Error)) return false
  const cause = error.cause as { code?: string } | undefined
  return /APIConnection|Timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|network|socket|premature close|terminated/i.test(
    `${error.name} ${error.message} ${cause?.code ?? ""}`
  )
}
function responseDetail(response?: AIMessage): string {
  const reason = response?.response_metadata?.finish_reason
  const labels: Record<string, string> = {
    stop: "正常结束",
    length: "达到输出上限",
    content_filter: "服务端内容过滤",
    tool_calls: "工具调用",
    function_call: "函数调用"
  }
  const finish =
    typeof reason === "string"
      ? `${labels[reason] ?? "服务端结束"}（${reason.slice(0, 64)}）`
      : "服务端未提供结束原因"
  const usage = response?.usage_metadata
  return [
    finish,
    typeof usage?.output_tokens === "number" ? `输出 ${usage.output_tokens} token` : "",
    typeof usage?.output_token_details?.reasoning === "number"
      ? `其中思考 ${usage.output_token_details.reasoning} token`
      : ""
  ]
    .filter(Boolean)
    .join(" · ")
}
function retryDelay(error: unknown, retry: number): number {
  const headers = (error as { headers?: Record<string, string> | Headers } | null)?.headers
  const after = headers instanceof Headers ? headers.get("retry-after") : headers?.["retry-after"]
  const seconds = after ? Number(after) : NaN
  const requested = Number.isFinite(seconds)
    ? seconds * 1000
    : after
      ? Date.parse(after) - Date.now()
      : 0
  // Same backoff as runtime.ts: 1, 2, 4, 8, 16, 32 seconds, with 1–2x jitter.
  // Honor longer gateway cooldowns, bounded so a bad Retry-After cannot stall forever.
  const backoff = Math.round(1000 * 2 ** retry * (1 + Math.random()))
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(backoff, requested || 0))
}
export function projectMessageText(content: AIMessage["content"]): string {
  return typeof content === "string"
    ? content
    : content
        .map((part) =>
          typeof part === "object" && part.type === "text" ? String(part.text ?? "") : ""
        )
        .join("")
}

export function projectToolCallIssue(response: AIMessage, remaining: number): string | undefined {
  if (response.invalid_tool_calls?.length)
    return `上次工具调用未执行：参数不是完整 JSON 对象。请根据工具定义修正后重试。问题调用（仅作错误反馈）：${JSON.stringify(response.invalid_tool_calls.map((call) => ({ name: call.name, args: call.args?.slice(0, 512), error: call.error })).slice(0, 3))}`
  if ((response.tool_calls?.length ?? 0) > remaining)
    return `上次工具调用未执行：剩余最多 ${remaining} 次查询。请只查询必要数据，或基于已有证据回答，明确未查证的部分。`
  return undefined
}

/** Every production model request uses SSE. No invoke fallback: intranet endpoints time out without streaming. */
export async function streamProjectModel(
  model: ProjectAnalysisModel,
  messages: BaseMessage[],
  signal: AbortSignal,
  reporter: ProjectRunReporter,
  title: string,
  visibleText = false
): Promise<AIMessage> {
  let requestMessages = messages
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try {
      return await streamAttempt(
        model,
        requestMessages,
        signal,
        reporter,
        attempt ? `${title} · 自动重试 ${attempt}/${PROJECT_MODEL_MAX_RETRIES}` : title,
        visibleText
      )
    } catch (error) {
      signal.throwIfAborted()
      if (!retryable(error) || attempt >= PROJECT_MODEL_MAX_RETRIES) {
        if (attempt) throw new ProjectModelRequestError(error, attempt)
        throw error
      }
      if (error instanceof ProjectModelOutputError && error.retryInstruction)
        requestMessages = [...messages, new HumanMessage(error.retryInstruction)]
      const ms = retryDelay(error, attempt)
      const status = projectModelStatus(error)
      const step = reporter.begin(
        "review",
        "等待自动重试",
        `${error instanceof ProjectStreamIdleError ? "模型长时间无响应" : error instanceof ProjectModelOutputError ? "模型输出不完整或为空" : status ? `HTTP ${status}` : "连接或响应解析异常"}，${Math.ceil(ms / 1000)} 秒后重试 ${attempt + 1}/${PROJECT_MODEL_MAX_RETRIES}；已完成步骤保留`
      )
      await delay(ms, undefined, { signal })
      step.finish("开始重试失败的模型调用")
    }
  }
}

async function streamAttempt(
  model: ProjectAnalysisModel,
  messages: BaseMessage[],
  signal: AbortSignal,
  reporter: ProjectRunReporter,
  title: string,
  visibleText: boolean
): Promise<AIMessage> {
  const step = reporter.begin("model", title, "正在建立流式连接…")
  reporter.text(step.id, "", true, visibleText)
  let combined: AIMessageChunk | undefined
  let pending = "",
    chars = 0,
    chunks = 0,
    lastEmit = 0
  const flush = () => {
    if (pending) reporter.text(step.id, pending, false, visibleText)
    pending = ""
    lastEmit = Date.now()
    step.update(`正在接收模型输出 · ${chunks} 个片段 · ${chars} 字`)
  }
  try {
    signal.throwIfAborted()
    const stream = guardedProjectStream(model, messages, signal)
    for await (const chunk of stream) {
      signal.throwIfAborted()
      combined = combined ? combined.concat(chunk) : chunk
      // reasoning_content / reasoning blocks / prompts are deliberately excluded.
      const delta = projectMessageText(chunk.content)
      chars += delta.length
      chunks++
      pending += delta
      if (Date.now() - lastEmit >= 100 || pending.length >= 256) flush()
    }
    signal.throwIfAborted()
    flush()
    if (!combined)
      throw new ProjectModelOutputError(
        "模型流已结束，但没有返回正文或工具调用；服务端未提供结束原因"
      )
    // Some compatible providers omit call IDs. Wait for every argument fragment
    // before supplying IDs, so LangChain can parse these calls instead of dropping them.
    const callChunks = combined.tool_call_chunks
    if (callChunks?.some((call) => !call.id)) {
      combined = new AIMessageChunk({
        ...combined,
        tool_call_chunks: callChunks.map((call, index) => ({
          ...call,
          id: call.id || `project-${step.id}-${call.index ?? index}`
        }))
      })
    }
    let toolCalls = combined.tool_calls
    let invalidToolCalls = combined.invalid_tool_calls
    // LangChain accepts partial JSON while streaming. Only execute complete JSON objects.
    if (combined.tool_call_chunks?.length) {
      toolCalls = []
      invalidToolCalls = []
      for (const call of combined.tool_call_chunks) {
        try {
          const args: unknown = JSON.parse(call.args ?? "")
          if (!call.name || !args || typeof args !== "object" || Array.isArray(args))
            throw new Error("工具名称必填，参数必须是完整 JSON 对象")
          toolCalls.push({
            name: call.name,
            id: call.id,
            args: args as Record<string, unknown>,
            type: "tool_call"
          })
        } catch {
          invalidToolCalls.push({
            name: call.name,
            id: call.id,
            args: call.args,
            error: "工具名称必填，参数必须是完整 JSON 对象",
            type: "invalid_tool_call"
          })
        }
      }
    }
    const response = new AIMessage({
      content: combined.content,
      tool_calls: toolCalls,
      invalid_tool_calls: invalidToolCalls,
      additional_kwargs: combined.additional_kwargs,
      response_metadata: combined.response_metadata,
      usage_metadata: combined.usage_metadata
    })
    const reason = response.response_metadata.finish_reason
    const retryInstruction =
      reason === "length"
        ? "上次输出达到模型输出上限，未被接受为完成结果。请按原要求重新输出完整而精简的结果：减少重复文字、样式和逐行抄写，保留必要证据与结论；HTML 必须完整闭合，工具参数必须是完整 JSON 对象。无需重复查询已取得的数据。"
        : undefined
    if (reason === "content_filter")
      throw new ProjectModelOutputError(
        `模型输出被服务端过滤，未采用不完整结果 · ${responseDetail(response)}`,
        false
      )
    if (
      !projectMessageText(response.content).trim() &&
      !response.tool_calls?.length &&
      !response.invalid_tool_calls?.length
    ) {
      const reasoningOnly =
        response.usage_metadata?.output_token_details?.reasoning ||
        response.additional_kwargs.reasoning ||
        response.additional_kwargs.reasoning_content
      throw new ProjectModelOutputError(
        `${reasoningOnly ? "模型只返回了思考内容，未返回正文" : "模型流已结束，但没有返回正文或工具调用"} · ${responseDetail(response)}`,
        true,
        retryInstruction
      )
    }
    if (reason === "length")
      throw new ProjectModelOutputError(
        `模型输出达到上限，未采用不完整结果 · ${responseDetail(response)}`,
        true,
        retryInstruction
      )
    if (typeof reason !== "string" || !reason)
      throw new ProjectModelOutputError("模型流已断开，但未收到完成标记，未采用不完整结果")
    if (!["stop", "tool_calls", "function_call"].includes(reason))
      throw new ProjectModelOutputError(
        `模型异常结束，未采用不完整结果 · ${responseDetail(response)}`
      )
    step.finish(
      `流式接收完成 · ${chars} 字${response.tool_calls?.length ? ` · 请求 ${response.tool_calls.length} 次工具查询` : ""} · ${responseDetail(response)}`
    )
    return response
  } catch (error) {
    if (pending) flush()
    const status = projectModelStatus(error)
    step.finish(
      signal.aborted
        ? "请求已停止"
        : error instanceof ProjectModelOutputError || error instanceof ProjectStreamIdleError
          ? error.message
          : `流式调用失败${typeof status === "number" ? `（HTTP ${status}）` : ""}；未切换非流式`,
      undefined,
      true
    )
    throw error
  }
}
