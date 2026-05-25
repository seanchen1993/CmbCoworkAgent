import { createHash } from "crypto"

export interface CountableToolCall {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`
}

export function stableToolArgsDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16)
}

export function stableToolOutputDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

export function buildToolResultFallbackKey(
  toolCallId: unknown,
  index: number,
  output: string
): string {
  const callId = typeof toolCallId === "string" && toolCallId.trim() ? toolCallId : "tool"
  return `${callId}:${index}:len:${output.length}:out:${stableToolOutputDigest(output)}`
}

export class ToolCallCounter {
  private readonly seen = new Set<string>()
  private count = 0
  private names: string[] = []

  private buildKey(tc: CountableToolCall, aiMessageId: string, index: number): string {
    if (typeof tc.id === "string" && tc.id.trim()) return `id:${tc.id}`
    const name = tc.name ?? "unknown"
    const argsHash = stableToolArgsDigest(tc.args ?? {})
    return `msg:${aiMessageId || "unknown"}#${index}:${name}:${argsHash}`
  }

  /**
   * Returns true only when this tool call is newly counted.
   */
  register(tc: CountableToolCall, aiMessageId: string, index: number): boolean {
    const key = this.buildKey(tc, aiMessageId, index)
    if (this.seen.has(key)) return false
    this.seen.add(key)
    this.count += 1
    this.names.push(tc.name ?? "unknown")
    return true
  }

  getCount(): number {
    return this.count
  }

  getNames(): string[] {
    return [...this.names]
  }

  getNamesSince(startIndex: number): string[] {
    const index = Math.max(0, Math.min(this.names.length, Math.floor(startIndex)))
    return this.names.slice(index)
  }
}
