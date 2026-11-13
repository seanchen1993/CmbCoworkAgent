import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import type { ProjectRunReporter } from "./run-progress"

export interface ProjectAnalysisModel {
  stream(
    messages: BaseMessage[],
    options: { signal: AbortSignal }
  ): Promise<AsyncIterable<AIMessageChunk>>
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
    const status =
      error && typeof error === "object" && "status" in error ? error.status : undefined
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
