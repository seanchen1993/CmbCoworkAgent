import { createDesignProgressNormalizer } from "./managed-design-session"
import { extractReasoningText, extractVisibleReasoning } from "./model-reasoning"
import { mergeTranscriptReasoningUpdates, normalizeTranscriptReasoning, TRANSCRIPT_REASONING_MAX_CHARS } from "./transcript-reasoning"
import type { StreamMessageWireMode } from "./stream-message-wire-mode"

export const DESIGN_LIVE_OUTPUT_LIMIT = 1600
export interface DesignLiveOutput {
  phase: "waiting" | "thinking" | "model" | "file" | "tool" | "validation" | "retry" | "approval"
  text: string
  chars: number
  reasoning?: string
  reasoningChars?: number
  reasoningScope?: string
  startedAt: number
  updatedAt: number
  outputAt?: number
  toolName?: string
}
export interface DesignModelActivity {
  scope: string
  toolCallChunks?: unknown
  reasoning?: string
  reasoningMode?: StreamMessageWireMode
  completed?: boolean
}

/** Keep reasoning separate from the generated artifact and ordinary assistant text. */
export function extractDesignPublicText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((block) => {
    if (typeof block === "string") return block
    if (!block || typeof block !== "object") return ""
    const item = block as { type?: string; text?: unknown }
    if (item.type && !["text", "output_text"].includes(item.type)) return ""
    return typeof item.text === "string" ? item.text : ""
  }).join("")
}

/** Read only reasoning the provider exposed, using the same fields as ordinary chat. */
export function extractDesignModelReasoning(message: unknown, includeInline = false): string {
  const explicit = extractVisibleReasoning(message)
  if (explicit) return explicit
  if (!message || typeof message !== "object") return ""
  const root = message as { kwargs?: { content?: unknown }; content?: unknown }
  const content = root.kwargs?.content ?? root.content
  if (Array.isArray(content)) {
    const reasoning = content.map((block) => {
      if (!block || typeof block !== "object") return ""
      if (block.type === "thinking") return typeof block.thinking === "string" ? block.thinking : extractReasoningText(block)
      if (block.type === "reasoning") return extractReasoningText(block)
      return ""
    }).join("")
    if (reasoning) return reasoning
  }
  if (!includeInline) return ""
  let reasoning = ""
  createDesignProgressNormalizer({ includeCode: true, onReasoning: (text) => { reasoning += text } })(extractDesignPublicText(content))
  return reasoning
}

export function createDesignModelActivity(
  message: unknown,
  scope: string,
  reasoningMode: StreamMessageWireMode = "delta",
  completed = false
): DesignModelActivity {
  const root = message as { kwargs?: Record<string, unknown>; tool_call_chunks?: unknown } | null
  const reasoning = extractDesignModelReasoning(message, completed)
  return {
    scope,
    toolCallChunks: root?.kwargs?.tool_call_chunks ?? root?.tool_call_chunks,
    ...(reasoning ? { reasoning, reasoningMode } : {}),
    ...(completed ? { completed: true } : {})
  }
}

/** Incrementally decode only generated file content, without retaining large JSON arguments. */
class FileArgumentReader {
  private inString = false
  private escape = false
  private unicode: string | null = null
  private key = ""
  private token = ""
  private value = false
  private capture = false

  read(chunk: string): string {
    let output = ""
    for (const char of chunk) {
      if (!this.inString) {
        if (char === '"') {
          this.inString = true
          this.token = ""
          this.capture = this.value && ["content", "new_string"].includes(this.key)
        } else if (char === ":") this.value = true
        else if (char === "," || char === "{" || char === "}") this.value = false
        continue
      }
      let decoded = char
      if (this.unicode !== null) {
        this.unicode += char
        if (this.unicode.length < 4) continue
        decoded = /^[\da-f]{4}$/i.test(this.unicode) ? String.fromCharCode(parseInt(this.unicode, 16)) : ""
        this.unicode = null
      } else if (this.escape) {
        this.escape = false
        if (char === "u") { this.unicode = ""; continue }
        decoded = ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[char] ?? char
      } else if (char === "\\") { this.escape = true; continue }
      else if (char === '"') {
        this.inString = false
        if (!this.value) this.key = this.token
        this.capture = false
        continue
      }
      if (this.capture) output += decoded
      if (!this.value && this.token.length < 80) this.token += decoded
    }
    return output
  }
}

export class DesignLiveOutputTracker {
  private state: DesignLiveOutput
  private scope = ""
  private tools = new Map<string, { name: string; reader: FileArgumentReader }>()
  private reasoningByScope = new Map<string, { text: string; provider: boolean }>()
  private publicText = this.createTextNormalizer()

  constructor(private readonly now: () => number = Date.now) {
    this.state = { phase: "waiting", text: "", chars: 0, startedAt: now(), updatedAt: now() }
  }
  snapshot(): DesignLiveOutput { return { ...this.state } }
  get reasoning(): string {
    return normalizeTranscriptReasoning([...this.reasoningByScope.values()].map((part) => part.text).join("\n\n")) ?? ""
  }
  private createTextNormalizer(): (token: string) => string {
    return createDesignProgressNormalizer({ includeCode: true, onReasoning: (text) => this.appendReasoning(text) })
  }
  private appendReasoning(text: string, mode: StreamMessageWireMode = "delta", provider = false, scope = this.scope, completed = false): void {
    const previous = this.reasoningByScope.get(scope)
    if (!provider && previous?.provider) return
    if (!text && mode !== "snapshot") return
    const merged = mergeTranscriptReasoningUpdates(
      { reasoning: previous?.provider === provider ? previous.text : "" },
      { reasoning: text, reasoning_mode: mode }
    ).reasoning ?? ""
    const otherChars = [...this.reasoningByScope.entries()].reduce((total, [id, part]) => total + (id === scope ? 0 : part.text.length), 0)
    const bounded = merged.slice(0, Math.max(0, TRANSCRIPT_REASONING_MAX_CHARS - otherChars))
    this.reasoningByScope.set(scope, { text: bounded, provider })
    if (scope !== this.scope) return
    // Keep live feedback moving even after the saved transcript reaches its cap.
    const append = mode === "delta" && previous?.provider === provider
    this.state.reasoning = (append ? `${this.state.reasoning ?? ""}${text}` : text).slice(-DESIGN_LIVE_OUTPUT_LIMIT)
    this.state.reasoningChars = append ? (this.state.reasoningChars ?? 0) + text.length : text.length
    this.state.reasoningScope = scope
    if (text && !completed) {
      this.phase("thinking")
      this.state.outputAt = this.now()
    }
  }
  phase(phase: DesignLiveOutput["phase"], toolName?: string): void {
    this.state = { ...this.state, phase, toolName, updatedAt: this.now() }
  }
  private append(text: string): void {
    if (!text) return
    this.state.text = (this.state.text + text).slice(-DESIGN_LIVE_OUTPUT_LIMIT)
    this.state.chars += text.length
    this.state.outputAt = this.now()
  }
  text(token: string, includePublicText = true): void {
    const text = this.publicText(token)
    if (text) {
      if (text.trim()) this.phase("model")
      if (includePublicText) this.append(text)
    }
  }
  activity(activity: DesignModelActivity): void {
    if (activity.completed) {
      if (activity.reasoning !== undefined) this.appendReasoning(activity.reasoning, "snapshot", true, activity.scope, true)
      return
    }
    if (activity.scope !== this.scope) {
      this.scope = activity.scope
      this.tools.clear()
      this.publicText = this.createTextNormalizer()
      this.state.reasoning = this.reasoningByScope.get(this.scope)?.text.slice(-DESIGN_LIVE_OUTPUT_LIMIT)
      this.state.reasoningChars = this.reasoningByScope.get(this.scope)?.text.length ?? 0
      this.state.reasoningScope = this.scope
      this.phase("model")
    }
    this.phase(this.state.phase === "thinking" ? "thinking" : "model")
    if (activity.reasoning !== undefined) this.appendReasoning(activity.reasoning, activity.reasoningMode, true)
    if (!Array.isArray(activity.toolCallChunks)) return
    activity.toolCallChunks.forEach((raw, index) => {
      if (!raw || typeof raw !== "object") return
      const item = raw as { index?: number; id?: string; name?: string; args?: unknown }
      // Providers usually send the ID/name only in the first chunk; index is stable thereafter.
      const key = String(item.index ?? index)
      let tool = this.tools.get(key)
      if (!tool) {
        if (this.tools.size >= 32) return
        tool = { name: "", reader: new FileArgumentReader() }
        this.tools.set(key, tool)
      }
      if (item.name) tool.name = item.name
      if (!["write_file", "edit_file"].includes(tool.name)) return
      this.phase("file", tool.name)
      if (typeof item.args === "string") this.append(tool.reader.read(item.args))
    })
  }
}
