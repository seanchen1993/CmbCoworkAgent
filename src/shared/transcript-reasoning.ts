import type { StreamMessageWireMode } from "./stream-message-wire-mode"

// Match the durable transcript's text limit, independently of the smaller trace limit.
export const TRANSCRIPT_REASONING_MAX_CHARS = 120_000

export interface TranscriptReasoningUpdate {
  reasoning?: string
  /** Write-only: snapshot explicitly replaces, including an empty string. */
  reasoning_mode?: StreamMessageWireMode
}

export function normalizeTranscriptReasoning(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  if (value.length <= TRANSCRIPT_REASONING_MAX_CHARS) return value
  let end = TRANSCRIPT_REASONING_MAX_CHARS
  if (/[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1
  return `${value.slice(0, end)}\n[reasoning truncated]`
}

/** Fold deltas without deduplicating repeated tokens; snapshots are idempotent. */
export function mergeTranscriptReasoningUpdates(
  existing: TranscriptReasoningUpdate,
  incoming: TranscriptReasoningUpdate
): TranscriptReasoningUpdate {
  if (incoming.reasoning_mode === "snapshot" && typeof incoming.reasoning === "string") {
    return {
      reasoning: normalizeTranscriptReasoning(incoming.reasoning) ?? "",
      reasoning_mode: "snapshot"
    }
  }
  if (!incoming.reasoning) {
    return existing.reasoning || existing.reasoning_mode === "snapshot"
      ? { reasoning: existing.reasoning, reasoning_mode: existing.reasoning_mode }
      : {}
  }
  const isDelta = incoming.reasoning_mode === "delta"
  const reasoning = isDelta
    ? `${existing.reasoning ?? ""}${incoming.reasoning}`
    : existing.reasoning?.startsWith(incoming.reasoning)
      ? existing.reasoning
      : incoming.reasoning
  return {
    reasoning: normalizeTranscriptReasoning(reasoning),
    reasoning_mode: isDelta
      ? existing.reasoning_mode === "snapshot"
        ? "snapshot"
        : existing.reasoning
          ? existing.reasoning_mode
          : "delta"
      : undefined
  }
}

export function normalizeVisibleReasoningText(reasoning: string | undefined): string {
  if (!reasoning) return ""
  const startsOrEndsWithWhitespace = !reasoning[0].trim() || !reasoning.at(-1)!.trim()
  if (
    !startsOrEndsWithWhitespace &&
    !(reasoning[0] === "<" && reasoning.slice(0, 7).toLowerCase() === "<think>") &&
    !(reasoning.at(-1) === ">" && reasoning.slice(-8).toLowerCase() === "</think>")
  ) {
    // Ordinary provider reasoning is already a standalone, trimmed string.
    // Returning it directly avoids two regex passes + trim over the complete
    // cumulative reasoning snapshot for every token.
    return reasoning
  }
  let visible = reasoning.trim()
  if (visible.slice(0, 7).toLowerCase() === "<think>") visible = visible.slice(7).trimStart()
  if (visible.slice(-8).toLowerCase() === "</think>") visible = visible.slice(0, -8).trimEnd()
  return visible
}
