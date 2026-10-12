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
  keys: Set<string>
}

/** Keep complete, detached JSON values only. Budget before serialization so
 * rejected tool payloads cannot run getters/toJSON or allocate their full JSON.
 * Partial data must not be restored as a complete tool argument at finish(). */
function snapshotTailValue(
  value: unknown,
  maxBytes: number
): { value: unknown; serialized: string; bytes: number } | undefined {
  let remaining = maxBytes
  let entries = 1024
  const ancestors = new WeakSet<object>()
  const reject = () => {
    throw new Error("tail snapshot limit")
  }
  const visit = (input: unknown, depth: number): unknown => {
    if (--entries < 0 || depth > 6) return reject()
    if (input === null || typeof input === "boolean" || typeof input === "number") {
      remaining -= 16
      if (remaining < 0) return reject()
      return typeof input === "number" && !Number.isFinite(input) ? null : input
    }
    if (typeof input === "string") {
      if (input.length > remaining) return reject()
      remaining -= Buffer.byteLength(input, "utf8") + 2
      if (remaining < 0) return reject()
      return input
    }
    if (typeof input !== "object" || ancestors.has(input)) return reject()
    const array = Array.isArray(input)
    if (
      !array &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      return reject()
    ancestors.add(input)
    try {
      if (array) {
        if (input.length > 64) return reject()
        const output: unknown[] = []
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
          if (descriptor && !("value" in descriptor)) return reject()
          output.push(visit(descriptor?.value ?? null, depth + 1))
        }
        return output
      }
      const output: Record<string, unknown> = Object.create(null)
      let count = 0
      for (const key in input) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue
        if (++count > 64) return reject()
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (!descriptor || !("value" in descriptor)) return reject()
        // JSON omits undefined object properties. Never invoke accessors or
        // serialization hooks; ordinary tool arguments are already JSON data.
        if (descriptor.value === undefined) continue
        if (key.length > remaining) return reject()
        remaining -= Buffer.byteLength(key, "utf8") + 4
        if (remaining < 0) return reject()
        output[key] = visit(descriptor.value, depth + 1)
      }
      return output
    } finally {
      ancestors.delete(input)
    }
  }
  try {
    // Strings are the common case, and remain raw text in the content pool.
    if (typeof value === "string") {
      if (value.length > maxBytes) return undefined
      const bytes = Buffer.byteLength(value, "utf8")
      return bytes <= maxBytes ? { value, serialized: value, bytes } : undefined
    }
    const snapshot = visit(value, 0)
    const serialized = JSON.stringify(snapshot)
    const bytes = Buffer.byteLength(serialized, "utf8")
    return bytes <= maxBytes ? { value: snapshot, serialized, bytes } : undefined
  } catch {
    return undefined
  }
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
    this.forget(key)
    if (this.maxBytes <= 0 || key.length > 512 || value === undefined || value === null) return
    const snapshot = snapshotTailValue(value, this.maxBytes)
    if (!snapshot) return
    const { serialized, bytes } = snapshot
    const contentId = createHash("sha1")
      .update(typeof value === "string" ? "text\0" : "json\0")
      .update(serialized)
      .digest("hex")
      .slice(0, 16)
    const existing = this.entries.get(contentId)
    if (existing) {
      this.entries.delete(contentId)
      this.entries.set(contentId, existing)
      existing.keys.add(key)
    } else {
      while (this.bytes + bytes > this.maxBytes && this.entries.size > 0) {
        const oldest = this.entries.keys().next().value
        if (typeof oldest !== "string") break
        this.dropContent(oldest)
      }
      this.entries.set(contentId, { key, value: snapshot.value, bytes, keys: new Set([key]) })
      this.bytes += bytes
    }
    this.keyToContent.set(key, contentId)
    // Many identical values must not turn a bounded content pool into an
    // unbounded reference index. Positional keys are local trace metadata.
    while (this.keyToContent.size > 4096) {
      const oldestKey = this.keyToContent.keys().next().value
      if (oldestKey === undefined) break
      this.forget(oldestKey)
    }
  }

  private forget(key: string): void {
    const contentId = this.keyToContent.get(key)
    if (contentId === undefined) return
    this.keyToContent.delete(key)
    const entry = this.entries.get(contentId)
    entry?.keys.delete(key)
    if (entry?.keys.size === 0) this.dropContent(contentId)
  }

  private dropContent(contentId: string): void {
    const entry = this.entries.get(contentId)
    if (!entry) return
    for (const key of entry.keys) this.keyToContent.delete(key)
    this.entries.delete(contentId)
    this.bytes -= entry.bytes
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
