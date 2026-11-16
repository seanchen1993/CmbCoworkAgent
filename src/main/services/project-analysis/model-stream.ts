import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { setTimeout as delay } from "node:timers/promises"
import type { ProjectRunReporter } from "./run-progress"

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
function retryable(error: unknown): boolean {
  const status = projectModelStatus(error)
  if (status !== undefined) return [408, 425, 429, 433, 500, 502, 503, 504].includes(status)
  if (!(error instanceof Error)) return false
  const cause = error.cause as { code?: string } | undefined
  return /APIConnection|Timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|network|socket|premature close|terminated/i.test(
    `${error.name} ${error.message} ${cause?.code ?? ""}`
  )
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

/** Every production model request uses SSE. No invoke fallback: intranet endpoints time out without streaming. */
export async function streamProjectModel(
  model: ProjectAnalysisModel,
  messages: BaseMessage[],
  signal: AbortSignal,
  reporter: ProjectRunReporter,
  title: string,
  visibleText = false
): Promise<AIMessage> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try {
      return await streamAttempt(
        model,
        messages,
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
      const ms = retryDelay(error, attempt)
      const status = projectModelStatus(error)
      const step = reporter.begin(
        "review",
        "等待自动重试",
        `${status ? `HTTP ${status}` : "连接中断"}，${Math.ceil(ms / 1000)} 秒后重试 ${attempt + 1}/${PROJECT_MODEL_MAX_RETRIES}；已完成步骤保留`
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
  if (visibleText) reporter.text(step.id, "", true)
  let combined: AIMessageChunk | undefined
  let pending = "",
    chars = 0,
    chunks = 0,
    lastEmit = 0
  const flush = () => {
    if (visibleText && pending) reporter.text(step.id, pending)
    pending = ""
    lastEmit = Date.now()
    step.update(`正在接收模型输出 · ${chunks} 个片段 · ${chars} 字`)
  }
  try {
    signal.throwIfAborted()
    const stream = await model.stream(messages, { signal })
    for await (const chunk of stream) {
      signal.throwIfAborted()
      combined = combined ? combined.concat(chunk) : chunk
      // reasoning_content / reasoning blocks / prompts are deliberately excluded.
      const delta = projectMessageText(chunk.content)
      chars += delta.length
      chunks++
      if (visibleText) pending += delta
      if (Date.now() - lastEmit >= 100 || pending.length >= 256) flush()
    }
    signal.throwIfAborted()
    flush()
    if (!combined) throw new Error("模型流式响应为空，请重试")
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
    const response = new AIMessage({
      content: combined.content,
      tool_calls: combined.tool_calls,
      invalid_tool_calls: combined.invalid_tool_calls,
      additional_kwargs: combined.additional_kwargs,
      response_metadata: combined.response_metadata,
      usage_metadata: combined.usage_metadata
    })
    step.finish(
      `流式接收完成 · ${chars} 字${response.tool_calls?.length ? ` · 请求 ${response.tool_calls.length} 次工具查询` : ""}`
    )
    return response
  } catch (error) {
    const status = projectModelStatus(error)
    step.finish(
      signal.aborted
        ? "请求已停止"
        : `流式调用失败${typeof status === "number" ? `（HTTP ${status}）` : ""}；未切换非流式`,
      undefined,
      true
    )
    throw error
  }
}
