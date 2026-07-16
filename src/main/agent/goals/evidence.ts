const DEFAULT_MAX_OUTPUT_CHARS = 6_000
const DEFAULT_MAX_INPUT_CHARS = 1_200

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const headChars = Math.floor(maxChars * 0.65)
  const tailChars = Math.floor(maxChars * 0.25)
  return `${text.slice(0, headChars)}\n...(middle truncated, ${text.length - headChars - tailChars} chars omitted)...\n${text.slice(-tailChars)}`
}

function compactGoalToolArg(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= 500) return value
    return `${value.slice(0, 300)}...(${value.length - 420} chars omitted)...${value.slice(-120)}`
  }
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactGoalToolArg(item, depth + 1))
  }
  if (depth >= 2) return "[object omitted]"

  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value).slice(0, 16)) {
    out[key] = compactGoalToolArg(raw, depth + 1)
  }
  return out
}

export function summarizeGoalToolInput(
  args: Record<string, unknown> | undefined,
  maxChars = DEFAULT_MAX_INPUT_CHARS
): string {
  if (!args || Object.keys(args).length === 0) return ""
  try {
    return truncateMiddle(JSON.stringify(compactGoalToolArg(args), null, 2), maxChars)
  } catch {
    return truncateMiddle(String(args), maxChars)
  }
}

export function buildGoalToolEvidenceEntry(params: {
  toolName: string
  output: string
  inputSummary?: string
  maxOutputChars?: number
}): string | null {
  const trimmed = params.output.trim()
  if (!trimmed) return null

  return [
    `Tool: ${params.toolName}`,
    ...(params.inputSummary ? [`Input:\n${params.inputSummary}`] : []),
    `Output:\n${truncateMiddle(trimmed, params.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)}`
  ].join("\n")
}

export class GoalEvidenceBuffer {
  private readonly inputByCallId = new Map<string, string>()
  private readonly evidence: string[] = []
  private evidenceStartCount = 0

  constructor(
    private readonly maxItems = 60,
    private readonly maxPendingInputs = Math.max(120, maxItems * 4)
  ) {}

  rememberToolCall(
    toolCallId: string | undefined,
    args: Record<string, unknown> | undefined
  ): void {
    if (!toolCallId) return
    const summary = summarizeGoalToolInput(args)
    if (summary) {
      this.inputByCallId.set(toolCallId, summary)
      while (this.inputByCallId.size > this.maxPendingInputs) {
        const oldestKey = this.inputByCallId.keys().next().value
        if (!oldestKey) break
        this.inputByCallId.delete(oldestKey)
      }
    }
  }

  appendToolResult(params: { toolName: string; output: string; toolCallId?: string }): void {
    const inputSummary = params.toolCallId ? this.inputByCallId.get(params.toolCallId) : undefined
    if (params.toolCallId) this.inputByCallId.delete(params.toolCallId)
    const entry = buildGoalToolEvidenceEntry({
      toolName: params.toolName,
      output: params.output,
      inputSummary
    })
    if (!entry) return
    this.evidence.push(entry)
    if (this.evidence.length > this.maxItems) {
      const removed = this.evidence.length - this.maxItems
      this.evidence.splice(0, removed)
      this.evidenceStartCount += removed
    }
  }

  getItems(): string[] {
    return this.evidence.slice()
  }

  getItemsSince(startIndex: number): string[] {
    const absoluteIndex = Math.max(0, Math.floor(startIndex))
    if (absoluteIndex <= this.evidenceStartCount) {
      return this.evidence.slice()
    }
    const relativeIndex = Math.min(this.evidence.length, absoluteIndex - this.evidenceStartCount)
    return this.evidence.slice(relativeIndex)
  }

  getCount(): number {
    return this.evidenceStartCount + this.evidence.length
  }
}

/**
 * Short-term, goal-scoped stash for background-result evidence whose delivery
 * turn was DEFERRED before the goal evaluation ran.
 *
 * Why it exists: a workflow/coordinator notification turn captures the delivered
 * result as one evidence entry (agent.ts pendingBackgroundResultEvidence — a
 * per-invoke local). The goal loop defers that turn when OTHER background work
 * is still pending (backlog: A delivered while B pending / workers still
 * running). The turn then ends, A is already acked (never re-delivered), and the
 * local evidence dies with the stack — the eventual evaluation sees only the
 * LAST delivery's evidence, re-introducing "judge on partial evidence" for
 * multi-batch results. Stash the entry here on defer; consume-and-clear it when
 * the evaluation finally runs so it sees every delivered batch.
 *
 * Scoped by goalId with self-healing: a stash/consume against a different
 * goalId than the stored one resets the bucket, so evidence can never leak into
 * a later, unrelated goal. Entries are priority-capped: supplementary evidence
 * is evicted before irreplaceable background-result batches.
 */
/** Eviction class for stashed entries: a "batch" is an irreplaceable delivered
 * background result (its notification is acked and never re-fires); a
 * "supplementary" entry is the deferred turn's ordinary tool evidence, which
 * has conversation-history redundancy. On cap overflow the OLDEST supplementary
 * entry is dropped first; only when none remain does the oldest batch go. */
export type GoalBackgroundEvidenceKind = "batch" | "supplementary"

export class GoalBackgroundEvidenceStash {
  private readonly byThread = new Map<
    string,
    { goalId: string; entries: Array<{ text: string; kind: GoalBackgroundEvidenceKind }> }
  >()

  // 16, not 8: one waiting period can fan out to a large worker/workflow fleet
  // returning in many staggered delivery turns (each parks ~2 entries: one batch
  // + one supplementary). 16 covers big fleets before priority eviction kicks
  // in; even then, supplementary entries go first so batches survive. Bumped
  // from 8 after real multi-batch runs approached the old ceiling.
  constructor(private readonly maxEntriesPerGoal = 16) {}

  stash(
    threadId: string,
    goalId: string,
    entry: string,
    kind: GoalBackgroundEvidenceKind = "batch"
  ): void {
    if (!entry.trim()) return
    const existing = this.byThread.get(threadId)
    const bucket =
      existing && existing.goalId === goalId
        ? existing
        : { goalId, entries: [] as Array<{ text: string; kind: GoalBackgroundEvidenceKind }> }
    bucket.entries.push({ text: entry, kind })
    while (bucket.entries.length > this.maxEntriesPerGoal) {
      // Priority eviction, not plain FIFO: dropping the overall-oldest entry
      // would let a late supplementary push evict an EARLIER irreplaceable
      // batch. Drop the oldest supplementary first (even if it is the one just
      // added — batches always win); fall back to the oldest batch only when
      // no supplementary entries remain.
      const supplementaryIdx = bucket.entries.findIndex(
        (item) => item.kind === "supplementary"
      )
      bucket.entries.splice(supplementaryIdx >= 0 ? supplementaryIdx : 0, 1)
    }
    this.byThread.set(threadId, bucket)
  }

  /** Returns the stashed entries for this thread's CURRENT goal WITHOUT
   * clearing them. A goalId mismatch discards the stale bucket and returns
   * nothing (same self-healing as consume).
   *
   * peek + discard-after-record (rather than consume-before-evaluate) keeps the
   * stash at-least-once: the goal evaluation awaits a model call between
   * reading the stash and recording the verdict — if that turn aborts or throws
   * in between, the entries survive for the retry/re-delivered turn instead of
   * being lost with the failed attempt (a background notification is re-driven
   * by its at-least-once delivery, but stashed batches have no re-delivery of
   * their own). */
  peek(threadId: string, goalId: string): string[] {
    const existing = this.byThread.get(threadId)
    if (!existing) return []
    if (existing.goalId !== goalId) {
      this.byThread.delete(threadId)
      return []
    }
    return existing.entries.map((item) => item.text)
  }

  /** Drops the bucket. Call ONLY after the judge decision that saw the peeked
   * entries was durably recorded — never before the evaluation settles. */
  discard(threadId: string): void {
    this.byThread.delete(threadId)
  }

  /** peek + discard in one step, for callers with no failure window between
   * reading and using the entries (e.g. synchronous flows). */
  consume(threadId: string, goalId: string): string[] {
    const entries = this.peek(threadId, goalId)
    this.byThread.delete(threadId)
    return entries
  }

  clear(threadId: string): void {
    this.byThread.delete(threadId)
  }
}
