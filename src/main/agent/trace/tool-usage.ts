import { createHash } from "crypto"
import { isPlausibleToolName } from "../../../shared/tool-name"

/** Counters live outside the trace content budget and node retention limits. */
export class TraceToolUsageCounter {
  private readonly calls = new Set<string>()
  private readonly counts = new Map<string, number>()
  private overflow = false
  private userInputRequests = 0
  private total = 0

  observe(key: string, name: string): void {
    key = key.length > 256 ? `sha256:${createHash("sha256").update(key).digest("hex")}` : key
    name = isPlausibleToolName(name) ? name : "__invalid_tool_name__"
    if (this.calls.has(key)) return
    // Bound pathological sessions without silently claiming complete coverage.
    if (this.calls.size >= 100_000) {
      this.overflow = true
      return
    }
    this.calls.add(key)
    this.total += 1
    if (name === "request_user_input") this.userInputRequests += 1
    if (!this.counts.has(name) && this.counts.size >= 256) {
      this.overflow = true
      return
    }
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1)
  }

  get totalCalls(): number {
    return this.total
  }

  snapshot(totalToolCalls: number) {
    const complete = !this.overflow && totalToolCalls === this.total
    return {
      toolUsageSchemaVersion: 1 as const,
      toolUsageComplete: complete,
      toolUsage: [...this.counts].map(([name, count]) => ({ name, count })),
      // Missing means unknown; only a complete observation can assert zero.
      ...(complete ? { userInputRequestCount: this.userInputRequests } : {})
    }
  }
}
