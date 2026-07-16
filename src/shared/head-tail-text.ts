export interface HeadTailTextSnapshot {
  /** Renderable bounded preview. The omission marker is preview-only. */
  content: string
  head: string
  tail: string
  totalChars: number
  retainedChars: number
  omittedChars: number
  truncated: boolean
}

export interface HeadTailTextIngestResult extends HeadTailTextSnapshot {
  /** How a durable event log should apply `persistedContent`. */
  persistenceMode: "append" | "replace" | "noop"
  /** Minimal content needed to reproduce the authoritative text. */
  persistedContent: string
}

export type HeadTailTextInputKind = "auto" | "delta" | "snapshot"

type ObservedStreamMode = "unknown" | "delta" | "cumulative"

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Slice without leaving an unmatched UTF-16 surrogate at either boundary. */
function safeSlice(value: string, start: number, end?: number): string {
  let safeStart = Math.max(0, start)
  let safeEnd = end === undefined ? value.length : Math.min(value.length, Math.max(safeStart, end))

  if (
    safeStart > 0 &&
    safeStart < value.length &&
    isLowSurrogate(value.charCodeAt(safeStart)) &&
    isHighSurrogate(value.charCodeAt(safeStart - 1))
  ) {
    safeStart += 1
  }
  if (
    safeEnd > safeStart &&
    safeEnd < value.length &&
    isHighSurrogate(value.charCodeAt(safeEnd - 1)) &&
    isLowSurrogate(value.charCodeAt(safeEnd))
  ) {
    safeEnd -= 1
  }
  return value.slice(safeStart, safeEnd)
}

/**
 * Bounded text accumulator for streams that may emit either deltas or complete
 * cumulative snapshots. It retains a stable head and a moving tail, while
 * reporting the exact UTF-16 length observed from the provider.
 */
export class HeadTailTextAccumulator {
  private head = ""
  private tail = ""
  private totalChars = 0
  private observedMode: ObservedStreamMode = "unknown"

  constructor(
    private readonly maxRetainedChars = 16_000,
    private readonly headChars = Math.floor(maxRetainedChars / 2)
  ) {
    if (!Number.isInteger(maxRetainedChars) || maxRetainedChars < 2) {
      throw new Error("maxRetainedChars must be an integer >= 2")
    }
    if (!Number.isInteger(headChars) || headChars < 1 || headChars >= maxRetainedChars) {
      throw new Error("headChars must be between 1 and maxRetainedChars - 1")
    }
  }

  get isEmpty(): boolean {
    return this.totalChars === 0
  }

  ingest(incoming: string, inputKind: HeadTailTextInputKind = "auto"): HeadTailTextIngestResult {
    if (!incoming) {
      if (inputKind === "snapshot" && this.totalChars > 0) {
        this.observedMode = "cumulative"
        this.replace("")
        return this.result("replace", "")
      }
      return this.result("noop", "")
    }

    if (this.totalChars === 0) {
      this.replace(incoming)
      if (inputKind === "delta") this.observedMode = "delta"
      if (inputKind === "snapshot") this.observedMode = "cumulative"
      return this.result("append", incoming)
    }

    const cumulative = this.classifyCumulativeSnapshot(incoming)
    if (inputKind === "snapshot") {
      this.observedMode = "cumulative"
      return this.applyCumulativeSnapshot(incoming, cumulative)
    }
    if (inputKind === "delta") {
      this.observedMode = "delta"
      this.append(incoming)
      return this.result("append", incoming)
    }
    if (this.observedMode === "cumulative") {
      return this.applyCumulativeSnapshot(incoming, cumulative)
    }
    if (this.observedMode === "delta") {
      this.append(incoming)
      return this.result("append", incoming)
    }

    if (cumulative === "same") return this.result("noop", "")
    if (cumulative === "growth") {
      this.observedMode = "cumulative"
      const suffix = safeSlice(incoming, this.totalChars)
      this.append(suffix)
      return this.result(suffix ? "append" : "noop", suffix)
    }
    if (cumulative === "replacement") {
      this.observedMode = "cumulative"
      this.replace(incoming)
      return this.result("replace", incoming)
    }

    // A shorter prefix is ambiguous until the provider establishes whether it
    // emits deltas or cumulative snapshots. Keep auto-detection open so a later
    // cumulative growth can still identify the stream. Other non-prefix chunks
    // are strong evidence of a delta stream.
    if (!(incoming.length < this.totalChars && this.head.startsWith(incoming))) {
      this.observedMode = "delta"
    }
    this.append(incoming)
    return this.result("append", incoming)
  }

  snapshot(): HeadTailTextSnapshot {
    const retainedChars = this.head.length + this.tail.length
    const omittedChars = Math.max(0, this.totalChars - retainedChars)
    const truncated = omittedChars > 0
    return {
      content: truncated
        ? `${this.head}\n\n…[实时预览省略 ${omittedChars} 字]…\n\n${this.tail}`
        : this.head,
      head: this.head,
      tail: this.tail,
      totalChars: this.totalChars,
      retainedChars,
      omittedChars,
      truncated
    }
  }

  private result(
    persistenceMode: HeadTailTextIngestResult["persistenceMode"],
    persistedContent: string
  ): HeadTailTextIngestResult {
    return { ...this.snapshot(), persistenceMode, persistedContent }
  }

  private classifyCumulativeSnapshot(
    incoming: string
  ): "same" | "growth" | "replacement" | "delta" {
    if (incoming.length < this.totalChars || !incoming.startsWith(this.head)) return "delta"

    if (this.tail === "") {
      if (incoming === this.head) return "same"
      if (incoming.startsWith(this.head)) return "growth"
      return "delta"
    }

    const priorTailStart = this.totalChars - this.tail.length
    const priorTailInIncoming = safeSlice(incoming, priorTailStart, this.totalChars)
    if (priorTailInIncoming === this.tail) {
      return incoming.length === this.totalChars ? "same" : "growth"
    }

    // A provider may revise a cumulative snapshot in place. Persist a boundedly
    // rare replacement instead of corrupting the transcript by appending it.
    return incoming.length >= this.totalChars ? "replacement" : "delta"
  }

  private applyCumulativeSnapshot(
    incoming: string,
    classification: ReturnType<HeadTailTextAccumulator["classifyCumulativeSnapshot"]>
  ): HeadTailTextIngestResult {
    if (classification === "same") return this.result("noop", "")
    if (classification === "growth") {
      const suffix = safeSlice(incoming, this.totalChars)
      this.append(suffix)
      return this.result(suffix ? "append" : "noop", suffix)
    }

    // Once cumulative semantics are explicit or observed, both a shorter
    // snapshot and an arbitrary in-place revision replace prior content.
    this.replace(incoming)
    return this.result("replace", incoming)
  }

  private replace(value: string): void {
    this.totalChars = value.length
    if (value.length <= this.maxRetainedChars) {
      this.head = value
      this.tail = ""
      return
    }
    const tailChars = this.maxRetainedChars - this.headChars
    this.head = safeSlice(value, 0, this.headChars)
    this.tail = safeSlice(value, value.length - tailChars)
  }

  private append(delta: string): void {
    if (!delta) return
    const previousTotal = this.totalChars
    this.totalChars += delta.length

    if (previousTotal <= this.maxRetainedChars && this.tail === "") {
      const combined = this.head + delta
      if (combined.length <= this.maxRetainedChars) {
        this.head = combined
        return
      }
      const tailChars = this.maxRetainedChars - this.headChars
      this.head = safeSlice(combined, 0, this.headChars)
      this.tail = safeSlice(combined, combined.length - tailChars)
      return
    }

    const tailChars = this.maxRetainedChars - this.headChars
    const combinedTail = this.tail + delta
    this.tail = safeSlice(combinedTail, Math.max(0, combinedTail.length - tailChars))
  }
}
