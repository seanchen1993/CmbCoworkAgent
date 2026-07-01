/**
 * Display-only bounding of a workflow subagent's "values" snapshot before it crosses IPC
 * or is written to its sidecar. Pure (no electron) so it is unit-testable.
 *
 * Design — three independent bounds so no input shape can spike the main process or
 * produce an unbounded payload:
 *  - We do NOT `JSON.stringify` the whole messages array and then trim. We tail-slice to
 *    the last N messages FIRST, then walk each message truncating over-long strings AS WE
 *    READ THEM — a multi-MB tool arg is sliced in place; a giant intermediate string is
 *    never materialized.
 *  - Truncation applies to strings ANYWHERE — message content, tool-call args,
 *    tool_call_chunks, additional_kwargs, … — so the biggest fields can't bypass the cap.
 *  - A hard TOTAL char budget caps the whole payload regardless of shape (e.g. an object with
 *    millions of tiny fields, or a tree of empty arrays/objects — every container also costs
 *    budget, not just leaf chars). The walk keeps the NEWEST messages and stops once the budget
 *    is spent, so the recent activity the user is looking at always survives.
 */

export const WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP = 24_000
export const WORKFLOW_AGENT_SNAPSHOT_MAX_MESSAGES = 400
export const WORKFLOW_AGENT_SNAPSHOT_TOTAL_CAP = 1_000_000
const WORKFLOW_AGENT_SNAPSHOT_MAX_DEPTH = 12
const WORKFLOW_AGENT_SNAPSHOT_MAX_ARRAY = 2_000

interface SnapshotBudget {
  left: number
}

function truncateString(value: string): string {
  return value.length > WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP
    ? `${value.slice(0, WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP)}\n…[truncated ${
        value.length - WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP
      } chars]`
    : value
}

/** Recursively copy a serialized message value, truncating over-long strings in place,
 * capping array length + nesting depth, and decrementing a shared TOTAL char budget so
 * the whole payload is bounded regardless of breadth. Honors `toJSON` (LangChain
 * serializables) so instances serialize the same shape `JSON.stringify` would — but
 * truncated as we go, so we never build a giant intermediate string. */
export function boundedCloneSnapshotValue(
  value: unknown,
  depth: number,
  budget: SnapshotBudget
): unknown {
  if (budget.left <= 0) return undefined
  if (typeof value === "string") {
    const capped = truncateString(value)
    budget.left -= capped.length
    return capped
  }
  if (value === null || typeof value !== "object") {
    budget.left -= 8
    return value
  }
  if (depth >= WORKFLOW_AGENT_SNAPSHOT_MAX_DEPTH) return undefined
  const serializable = value as { toJSON?: unknown }
  if (typeof serializable.toJSON === "function") {
    return boundedCloneSnapshotValue((serializable.toJSON as () => unknown)(), depth + 1, budget)
  }
  if (Array.isArray(value)) {
    // The container itself costs budget: a tree of empty arrays has no leaf chars and would
    // otherwise bypass the total cap, so without this the budget bounds leaf CONTENT but not node
    // COUNT (a tool can return a huge nested-empty structure). Charging per container makes the
    // "caps the whole payload regardless of shape" invariant actually hold.
    budget.left -= 2
    const capped =
      value.length > WORKFLOW_AGENT_SNAPSHOT_MAX_ARRAY
        ? value.slice(value.length - WORKFLOW_AGENT_SNAPSHOT_MAX_ARRAY)
        : value
    const out: unknown[] = []
    for (const item of capped) {
      if (budget.left <= 0) break
      out.push(boundedCloneSnapshotValue(item, depth + 1, budget))
    }
    return out
  }
  const out: Record<string, unknown> = {}
  budget.left -= 2 // the container itself costs budget too (empty objects deduct nothing per-key) — see the array branch
  // for...in iterates keys lazily — unlike Object.keys() it does NOT materialize the full
  // key array up front, so a pathologically wide object can't spike before the per-key
  // budget loop stops it.
  const record = value as Record<string, unknown>
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    if (budget.left <= 0) break
    budget.left -= key.length
    out[key] = boundedCloneSnapshotValue(record[key], depth + 1, budget)
  }
  return out
}

/** Bound a "values" snapshot's `messages` for the wire/sidecar (display-only; returns
 * undefined when there is nothing to show). Tail-slices to the last N messages, then
 * bound-clones from NEWEST to oldest under a shared total budget — so the cost and the
 * payload are both bounded, and if the budget runs out it's the oldest messages that drop
 * (the recent activity always survives). Never throws. */
export function serializeWorkflowAgentSnapshotMessages(snapshot: unknown): unknown[] | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined
  const raw = (snapshot as { messages?: unknown }).messages
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const trimmed =
    raw.length > WORKFLOW_AGENT_SNAPSHOT_MAX_MESSAGES
      ? raw.slice(raw.length - WORKFLOW_AGENT_SNAPSHOT_MAX_MESSAGES)
      : raw
  // Absolute index of trimmed[0] in the FULL (pre-tail-slice) list. Stamp each kept message with its
  // absolute position so the renderer's stable fallback key (for messages with NO provider id) does
  // not drift as the tail window slides — otherwise React reuses the wrong bubble and tool results /
  // scroll positions misalign. Mirrors the main chat's annotateWorkerSnapshotIndexForRenderer.
  const sliceOffset = raw.length - trimmed.length
  const budget: SnapshotBudget = { left: WORKFLOW_AGENT_SNAPSHOT_TOTAL_CAP }
  try {
    const keptNewestFirst: unknown[] = []
    for (let index = trimmed.length - 1; index >= 0; index -= 1) {
      if (budget.left <= 0) break
      const cloned = boundedCloneSnapshotValue(trimmed[index], 0, budget)
      keptNewestFirst.push(annotateSnapshotIndexForRenderer(cloned, sliceOffset + index))
    }
    return keptNewestFirst.reverse()
  } catch {
    return undefined
  }
}

/** Renderer's stable fallback message-id key — MUST match electron-transport.ts's
 * WORKER_SNAPSHOT_INDEX_MESSAGE_KEY and the main chat's key in agent.ts, or the fallback id won't
 * line up and the renderer falls back to the (drifting) array index. */
const WORKER_SNAPSHOT_INDEX_MESSAGE_KEY = "cmb_worker_snapshot_index"

/** Stamp a CLONED snapshot message with its absolute pre-tail-slice index in
 * additional_kwargs.cmb_worker_snapshot_index. The arg is a fresh bounded-clone, so we build new
 * wrappers (no source mutation) and spend only a few extra chars per message (negligible vs the
 * display cap). Non-object clones (shouldn't happen for messages) pass through untouched. */
function annotateSnapshotIndexForRenderer(cloned: unknown, absoluteIndex: number): unknown {
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) return cloned
  const record = cloned as Record<string, unknown>
  const kwargs =
    record.kwargs && typeof record.kwargs === "object" && !Array.isArray(record.kwargs)
      ? (record.kwargs as Record<string, unknown>)
      : {}
  const additionalKwargs =
    kwargs.additional_kwargs &&
    typeof kwargs.additional_kwargs === "object" &&
    !Array.isArray(kwargs.additional_kwargs)
      ? (kwargs.additional_kwargs as Record<string, unknown>)
      : {}
  return {
    ...record,
    kwargs: {
      ...kwargs,
      additional_kwargs: {
        ...additionalKwargs,
        [WORKER_SNAPSHOT_INDEX_MESSAGE_KEY]: absoluteIndex
      }
    }
  }
}
