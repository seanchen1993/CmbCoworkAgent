/**
 * Translate the agent's raw internal stream into an OpenAI-compatible
 * `chat.completion.chunk` SSE stream.
 *
 * The raw stream (what the renderer's useStream consumes) is verbose: it repeats
 * full graph-state snapshots (`mode:"values"` — todos/files/skills/messages) and
 * carries langgraph internals. External HTTP clients want the same thing the
 * OpenAI streaming API gives: assistant text deltas, tool calls, and (since we
 * execute tools server-side) tool results. This encoder keeps only those.
 *
 * Emitted frames (one per SSE `data:` line):
 *   { object:"chat.completion.chunk", choices:[{ delta:{ role:"assistant" } }] }
 *   { ... choices:[{ delta:{ content:"你好" } }] }                 // text delta
 *   { ... choices:[{ delta:{ tool_calls:[{ index, id, function:{name,arguments} }] } }] }
 *   { ... choices:[{ delta:{ role:"tool", tool_call_id, name, content } }] } // tool result
 *   { ... choices:[{ delta:{}, finish_reason:"stop" }] }
 *   [DONE]
 */

function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b && typeof b === "object" && (b as { type?: unknown }).type === "text"
      )
      .map((b) => b.text)
      .join("")
  }
  return ""
}

export interface OpenAiStreamEncoder {
  /** Encode one raw payload to SSE text, or "" when it carries nothing useful. */
  encode(payload: unknown): string
  /** Terminal frames for a normal finish. */
  finish(): string
  /** Terminal frames for an error. */
  error(message: string): string
}

export function createOpenAiStreamEncoder(
  threadId: string,
  createdSec: number
): OpenAiStreamEncoder {
  const id = "chatcmpl-" + threadId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)
  let model = "unknown"
  let roleSent = false

  const frame = (delta: Record<string, unknown>, finishReason: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: createdSec,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`

  return {
    encode(payload: unknown): string {
      const p = payload as { type?: string; mode?: string; data?: unknown } | null
      // Only token-level message chunks carry content/tool calls/results.
      // Full-state `mode:"values"` snapshots and custom events are dropped.
      if (!p || p.type !== "stream" || p.mode !== "messages") return ""
      const arr = p.data
      if (!Array.isArray(arr) || !arr[0] || typeof arr[0] !== "object") return ""
      const msg = arr[0] as { id?: unknown; kwargs?: Record<string, unknown> }
      const meta = (arr[1] ?? {}) as { ls_model_name?: unknown; model?: unknown }
      if (typeof meta.ls_model_name === "string") model = meta.ls_model_name
      else if (typeof meta.model === "string") model = meta.model

      const cls = Array.isArray(msg.id) ? String(msg.id[msg.id.length - 1]) : ""
      const kw = msg.kwargs ?? {}

      if (cls === "ToolMessage") {
        // A tool finished — surface its return value.
        return frame(
          {
            role: "tool",
            tool_call_id: kw.tool_call_id,
            name: kw.name,
            content: extractText(kw.content)
          },
          null
        )
      }

      // Assistant text and/or tool-call deltas.
      const delta: Record<string, unknown> = {}
      if (!roleSent) {
        delta.role = "assistant"
        roleSent = true
      }
      const text = extractText(kw.content)
      if (text) delta.content = text
      const toolCallChunks = Array.isArray(kw.tool_call_chunks) ? kw.tool_call_chunks : []
      if (toolCallChunks.length > 0) {
        delta.tool_calls = toolCallChunks.map((tc) => {
          const t = tc as { index?: number; id?: string; name?: string; args?: string }
          return {
            index: typeof t.index === "number" ? t.index : 0,
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: t.args ?? "" }
          }
        })
      }
      return Object.keys(delta).length > 0 ? frame(delta, null) : ""
    },
    finish(): string {
      return frame({}, "stop") + "data: [DONE]\n\n"
    },
    error(message: string): string {
      const delta = roleSent
        ? { content: `\n[error] ${message}` }
        : { role: "assistant", content: `\n[error] ${message}` }
      return frame(delta, "stop") + "data: [DONE]\n\n"
    }
  }
}
