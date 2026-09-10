/**
 * Keeps the last stretch of a turn readable when the collection budget runs out
 * partway through.
 *
 * The budget is spent in the order work happens, so a long turn used to come
 * out as "the first handful of steps in full, then two hundred skeletons" — and
 * the end of a turn is usually where the answer is. Everything after the budget
 * ran out looked identical whether the agent finished cleanly or died on the
 * last call.
 *
 * So a slice of the budget is held back and spent on whatever turns out to be
 * last. The collector cannot know which step is final while it is still
 * running, so content that could not be recorded is remembered here instead,
 * oldest evicted first, and written back into the trace at finish().
 */
import { createHash } from "crypto"

export interface TailContentEntry {
  key: string
  value: unknown
  bytes: number
}

export class TraceTailContentBuffer {
  /**
   * Content-addressed, because the same assistant text is recorded in three
   * places (the step, the model call's output message, the llm node) and the
   * reserve is small. Storing it once per distinct value rather than once per
   * position is the difference between covering the last three turns and the
   * last dozen.
   */
  private readonly entries = new Map<string, TailContentEntry>()
  private readonly keyToContent = new Map<string, string>()
  private bytes = 0

  constructor(private readonly maxBytes: number) {}

  get sizeBytes(): number {
    return this.bytes
  }

  get count(): number {
    return this.entries.size
  }

  /**
   * Remember content the budget could not afford, under a key that identifies
   * where it belongs. Re-remembering a key replaces it. Oldest entries are
   * evicted once the reserve is full, which is what makes this a tail: only the
   * most recent survive to be written back.
   */
  remember(key: string, value: unknown): void {
    if (this.maxBytes <= 0 || value === undefined || value === null) return
    let bytes: number
    try {
      bytes = Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8")
    } catch {
      // Unserializable values cannot be written back, so there is no point
      // holding them.
      return
    }
    // A single value larger than the whole reserve would evict everything and
    // still not fit; skip it rather than emptying the tail for one entry.
    if (bytes > this.maxBytes) return

    const serialized = typeof value === "string" ? value : JSON.stringify(value)
    const contentId = createHash("sha1").update(serialized).digest("hex").slice(0, 16)
    this.keyToContent.set(key, contentId)

    const existing = this.entries.get(contentId)
    if (existing) {
      // Move it to the end so a value still being referenced stays recent.
      this.entries.delete(contentId)
      this.entries.set(contentId, existing)
      return
    }
    while (this.bytes + bytes > this.maxBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== "string") break
      const dropped = this.entries.get(oldest)
      this.entries.delete(oldest)
      this.bytes -= dropped?.bytes ?? 0
    }
    this.entries.set(contentId, { key, value, bytes })
    this.bytes += bytes
  }

  /** Read back a remembered value, if it survived eviction. */
  take(key: string): unknown {
    const contentId = this.keyToContent.get(key)
    if (contentId === undefined) return undefined
    return this.entries.get(contentId)?.value
  }

  has(key: string): boolean {
    return this.take(key) !== undefined
  }
}

/** Keys are positional so finish() can find where each value belongs. */
export const tailKeys = {
  stepText: (index: number): string => `s${index}.text`,
  stepToolArgs: (index: number, toolIndex: number): string => `s${index}.t${toolIndex}.args`,
  modelCallContent: (index: number): string => `c${index}.content`,
  nodeOutput: (nodeId: string): string => `n:${nodeId}.out`,
  nodeInput: (nodeId: string): string => `n:${nodeId}.in`
} as const
