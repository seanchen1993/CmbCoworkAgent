import { createDesignProgressNormalizer } from "./managed-design-session"

export const DESIGN_LIVE_OUTPUT_LIMIT = 1600
export interface DesignLiveOutput {
  phase: "waiting" | "model" | "file" | "tool" | "validation" | "retry" | "approval"
  text: string
  chars: number
  startedAt: number
  updatedAt: number
  outputAt?: number
  toolName?: string
}
export interface DesignModelActivity {
  scope: string
  toolCallChunks?: unknown
}

/** Reasoning blocks are never public model output, even when they have a text field. */
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
  private publicText = createDesignProgressNormalizer({ includeCode: true })

  constructor(private readonly now: () => number = Date.now) {
    this.state = { phase: "waiting", text: "", chars: 0, startedAt: now(), updatedAt: now() }
  }
  snapshot(): DesignLiveOutput { return { ...this.state } }
  phase(phase: DesignLiveOutput["phase"], toolName?: string): void {
    this.state = { ...this.state, phase, toolName, updatedAt: this.now() }
  }
  private append(text: string): void {
    if (!text) return
    this.state.text = (this.state.text + text).slice(-DESIGN_LIVE_OUTPUT_LIMIT)
    this.state.chars += text.length
    this.state.outputAt = this.now()
  }
  text(token: string): void {
    this.phase("model")
    this.append(this.publicText(token))
  }
  activity(activity: DesignModelActivity): void {
    if (activity.scope !== this.scope) {
      this.scope = activity.scope
      this.tools.clear()
      this.publicText = createDesignProgressNormalizer({ includeCode: true })
    }
    this.phase("model")
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
