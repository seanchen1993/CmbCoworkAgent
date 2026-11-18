import type { Message } from "../types"

export function parseWorkerTurnScopedId(id: string): { rawId: string; turn: number } | undefined {
  const match = /^worker-turn-.*-(\d+)::(.+)$/.exec(id)
  return match ? { rawId: match[2], turn: Number(match[1]) } : undefined
}

export function sameWorkerRoleAndToolCall(left: Message, right: Message): boolean {
  return (
    left.role === right.role && (left.role !== "tool" || left.tool_call_id === right.tool_call_id)
  )
}

export function compatibleWorkerProviderIdentity(left: Message, right: Message): boolean {
  if (!left.worker_provider_identity || !right.worker_provider_identity) return true
  const leftSourceId = left.provider_source_id ?? left.id
  const rightSourceId = right.provider_source_id ?? right.id
  return (
    (parseWorkerTurnScopedId(leftSourceId)?.rawId ?? leftSourceId) ===
      (parseWorkerTurnScopedId(rightSourceId)?.rawId ?? rightSourceId) &&
    left.provider_occurrence === right.provider_occurrence
  )
}

/** Keeps legacy signature candidates separate from already identified rows. */
export function createWorkerSignatureMatches(messages: readonly Message[]) {
  const bySignature = new Map<
    string,
    { all: number[]; legacy: number[]; consumed: Set<number>; legacyConsumed: boolean }
  >()
  return {
    add(signature: string, index: number): void {
      const bucket = bySignature.get(signature) ?? {
        all: [],
        legacy: [],
        consumed: new Set(),
        legacyConsumed: false
      }
      bucket.all.push(index)
      if (!messages[index].worker_provider_identity) bucket.legacy.push(index)
      bySignature.set(signature, bucket)
    },
    take(
      signature: string,
      remainingBySignature: Map<string, number>,
      incoming: Message,
      claimed?: ReadonlySet<number>
    ): number | undefined {
      const bucket = bySignature.get(signature)
      if (!bucket) return undefined
      // Explicit matches are resolved by identity before consulting prose. Only
      // the legacy candidates can still represent this row without metadata.
      const explicit = incoming.worker_provider_identity === true
      if (explicit && bucket.legacy.length === 0) return undefined
      if (explicit) {
        bucket.legacy = bucket.legacy.filter(
          (candidate) =>
            !bucket.consumed.has(candidate) &&
            !claimed?.has(candidate) &&
            !messages[candidate].worker_provider_identity
        )
      } else if (bucket.legacyConsumed || claimed?.size) {
        bucket.all = bucket.all.filter(
          (candidate) => !bucket.consumed.has(candidate) && !claimed?.has(candidate)
        )
        bucket.legacyConsumed = false
      }
      const candidates = explicit ? bucket.legacy : bucket.all
      const remaining = remainingBySignature.get(signature) ?? 0
      const position = remaining <= 0 ? 0 : Math.max(0, candidates.length - remaining)
      const [index] = candidates.splice(position, 1)
      if (index !== undefined && !messages[index].worker_provider_identity)
        bucket.consumed.add(index)
      if (index !== undefined && explicit) bucket.legacyConsumed = true
      if (index !== undefined && remaining > 0) remainingBySignature.set(signature, remaining - 1)
      return index
    }
  }
}

/** Resolve complete worker content before the legacy sparse-fragment fallback. */
export function resolveWorkerSnapshotContent(
  existing: Message,
  incoming: Message
): Message["content"] | undefined {
  if (!incoming.worker_content_source) return undefined
  // Values can lag behind live chunks. Match the transport accumulator's prefix
  // replay protection; explicit wire snapshots can still truncate or clear text.
  if (
    incoming.worker_content_source === "values" &&
    typeof existing.content === "string" &&
    typeof incoming.content === "string" &&
    existing.content.startsWith(incoming.content)
  ) {
    return existing.content
  }
  return incoming.content
}
