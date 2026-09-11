export const CONTEXT_COMPACTION_EVENT_TYPE = "context_compaction"

/**
 * LangGraph's messages stream ignores model runs carrying this tag. Keeping the
 * summarizer out of the regular message stream prevents its private handoff
 * text from becoming a visible or persisted assistant message.
 */
export const CONTEXT_COMPACTION_NO_STREAM_TAG = "langsmith:nostream"

/** Identifies a compaction model run if a provider ignores the no-stream tag. */
export const CONTEXT_COMPACTION_MODEL_TAG = "cmb:context-compaction"

export type ContextCompactionPhase = "started" | "completed" | "failed"

export interface ContextCompactionLifecycleEvent {
  id: string
  phase: ContextCompactionPhase
  startedAt: number
  finishedAt?: number
}

export type ContextCompactionLifecycleCallback = (event: ContextCompactionLifecycleEvent) => void

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function parseContextCompactionLifecycleEvent(
  value: unknown
): ContextCompactionLifecycleEvent | null {
  const record = asRecord(value)
  if (!record) return null

  const id = typeof record.id === "string" ? record.id.trim() : ""
  const phase = record.phase
  if (
    !id ||
    (phase !== "started" && phase !== "completed" && phase !== "failed") ||
    !isFiniteTimestamp(record.startedAt)
  ) {
    return null
  }

  const finishedAt = isFiniteTimestamp(record.finishedAt) ? record.finishedAt : undefined
  if (phase !== "started" && finishedAt === undefined) return null

  return {
    id,
    phase,
    startedAt: record.startedAt,
    ...(finishedAt !== undefined && { finishedAt })
  }
}

/**
 * Defense in depth for runtimes/providers that still surface a tagged
 * summarizer chunk despite `langsmith:nostream`.
 */
export function isContextCompactionStreamPayload(mode: string, payload: unknown): boolean {
  if (mode !== "messages" || !Array.isArray(payload)) return false
  const metadata = asRecord(payload[1])
  const tags = metadata?.tags
  return Array.isArray(tags) && tags.includes(CONTEXT_COMPACTION_MODEL_TAG)
}
