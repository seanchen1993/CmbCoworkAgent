import {
  buildAvailableProviderOccurrenceId,
  buildMessageRoleCollisionId,
  getMessageProviderOccurrence,
  getMessageProviderOccurrenceIdentity,
  getMessageProviderSourceId,
  getMessageRoleCollisionIdentity,
  getMessageRoleCollisionSourceId,
  normalizeCompleteMessageIds,
  normalizeMessageRoleCollisionIds
} from "../../../shared/message-role-collision"
import { liveStreamMessageRole, type LiveStreamMessage } from "./live-stream-messages"

type IdentifiedMessage = LiveStreamMessage & { id: string }
const identified = (message: LiveStreamMessage): message is IdentifiedMessage => Boolean(message.id)
const roleOf = (message: LiveStreamMessage): string => liveStreamMessageRole(message.type)
const providerKey = (message: IdentifiedMessage): string =>
  `${roleOf(message)}\u0000${getMessageProviderSourceId(message)}`

/** Identity-only checkpoint rebasing. Never rebuild a growing transcript for each old row. */
export function resolveRetainedCheckpointIdentities(
  persisted: readonly LiveStreamMessage[],
  stable?: readonly LiveStreamMessage[]
): { ids: Set<string>; identities: Set<string> } {
  const ids = new Set<string>()
  const identities = new Set<string>()
  const retain = (message: IdentifiedMessage): void => {
    ids.add(message.id)
    identities.add(getMessageProviderOccurrenceIdentity(message))
  }
  persisted.filter(identified).forEach(retain)
  if (stable === undefined) return { ids, identities }

  const identifiedStable = stable.filter(identified)
  const rawIds = new Set(persisted.filter(identified).map((message) => message.id.trim()))
  const rawProviders = new Set(persisted.filter(identified).map(providerKey))
  const disjoint = identifiedStable.every((message) => {
    const id = message.id.trim()
    const key = providerKey(message)
    if (
      !id ||
      getMessageProviderSourceId(message) !== id ||
      getMessageProviderOccurrence(message) !== undefined ||
      rawIds.has(id) ||
      rawProviders.has(key)
    ) {
      return false
    }
    rawIds.add(id)
    rawProviders.add(key)
    return true
  })
  if (disjoint) {
    identifiedStable.forEach(retain)
    return { ids, identities }
  }

  const baseline = normalizeCompleteMessageIds(persisted.filter(identified))
  const incoming = normalizeMessageRoleCollisionIds(baseline, identifiedStable)
  const snapshot = normalizeCompleteMessageIds(incoming)
  if (baseline.length === 0) {
    snapshot.forEach(retain)
    return { ids, identities }
  }

  interface Entry {
    message: IdentifiedMessage
    occurrence: number
  }
  const byOccurrence = new Map<string, Entry>()
  const byRenderId = new Map<string, Entry[]>()
  const highestTranscript = new Map<string, number>()
  const renderedOccurrenceIds = new Map<string, string>()
  const occupied = new Set<string>()
  const roleByRenderId = new Map<string, string>()
  const renderBySourceRole = new Map<string, string>()
  const registerRole = (message: IdentifiedMessage): void => {
    const internal =
      getMessageRoleCollisionSourceId(message) !== message.id ||
      getMessageProviderOccurrence({ id: message.id, type: message.type }) !== undefined
    if (
      internal &&
      getMessageProviderOccurrence(message) !== undefined &&
      (!roleByRenderId.has(message.id) || roleByRenderId.get(message.id) === roleOf(message))
    ) {
      roleByRenderId.set(message.id, roleOf(message))
      return
    }
    const identity = getMessageRoleCollisionIdentity(message)
    if (renderBySourceRole.has(identity)) return
    roleByRenderId.set(message.id, roleOf(message))
    renderBySourceRole.set(identity, message.id)
  }
  for (const message of baseline) {
    registerRole(message)
    const key = providerKey(message)
    const occurrence =
      getMessageProviderOccurrence(message) ?? (highestTranscript.get(key) ?? 0) + 1
    highestTranscript.set(key, Math.max(highestTranscript.get(key) ?? 0, occurrence))
    const occurrenceKey = `${key}\u0000${occurrence}`
    renderedOccurrenceIds.set(occurrenceKey, message.id)
    occupied.add(message.id)
    if (byOccurrence.has(occurrenceKey)) continue
    const entry = { message, occurrence }
    byOccurrence.set(occurrenceKey, entry)
    const renderKey = `${roleOf(message)}\u0000${message.id}`
    const entries = byRenderId.get(renderKey) ?? []
    entries.push(entry)
    byRenderId.set(renderKey, entries)
  }
  const rawCounts = new Map<string, number>()
  for (const message of incoming)
    rawCounts.set(message.id.trim(), (rawCounts.get(message.id.trim()) ?? 0) + 1)
  const highestIncoming = new Map<string, number>()
  for (let index = 0; index < snapshot.length; index++) {
    const message = snapshot[index]
    const raw = incoming[index]
    const key = providerKey(message)
    const inferred = getMessageProviderOccurrence(message) ?? (highestIncoming.get(key) ?? 0) + 1
    const declared = getMessageProviderOccurrence(raw)
    let match = declared === undefined ? undefined : byOccurrence.get(`${key}\u0000${declared}`)
    if (declared === undefined && rawCounts.get(raw.id.trim()) === 1) {
      const candidates = new Set<Entry>()
      for (const id of new Set([raw.id.trim(), message.id])) {
        for (const candidate of byRenderId.get(`${roleOf(message)}\u0000${id}`) ?? []) {
          if (
            !raw.provider_source_id?.trim() ||
            getMessageProviderSourceId(candidate.message) === raw.provider_source_id.trim()
          ) {
            candidates.add(candidate)
          }
        }
      }
      if (candidates.size === 1) match = candidates.values().next().value
    }
    match ??= byOccurrence.get(`${key}\u0000${inferred}`)
    highestIncoming.set(key, Math.max(highestIncoming.get(key) ?? 0, match?.occurrence ?? inferred))
    const occurrence =
      match?.occurrence ??
      (getMessageProviderOccurrence(message) !== undefined || inferred > 1
        ? inferred
        : (highestTranscript.get(key) ?? 0) + 1)
    const source =
      match?.message.provider_source_id?.trim() ??
      message.provider_source_id?.trim() ??
      getMessageProviderSourceId(message)
    const transcriptKey = `${roleOf(message)}\u0000${source}`
    highestTranscript.set(
      transcriptKey,
      Math.max(highestTranscript.get(transcriptKey) ?? 0, occurrence)
    )
    const occurrenceKey = `${transcriptKey}\u0000${occurrence}`
    let id = match?.message.id ?? renderedOccurrenceIds.get(occurrenceKey)
    if (!id) {
      // The canonical normalizer first rebases cross-role render IDs against the
      // growing transcript. Keep that index incrementally too, including IDs
      // whose spelling happens to resemble another role's internal alias.
      const role = roleOf(message)
      const internal =
        getMessageRoleCollisionSourceId(message) !== message.id ||
        getMessageProviderOccurrence({ id: message.id, type: message.type }) !== undefined
      const preserveInternal =
        internal &&
        getMessageProviderOccurrence(message) !== undefined &&
        (!roleByRenderId.has(message.id) || roleByRenderId.get(message.id) === role)
      id = preserveInternal
        ? message.id
        : renderBySourceRole.get(getMessageRoleCollisionIdentity(message))
      if (!id) {
        id = message.id
        if (roleByRenderId.has(id) && roleByRenderId.get(id) !== role) {
          const sourceId = getMessageRoleCollisionSourceId(message)
          id = buildMessageRoleCollisionId(sourceId, role)
          let suffix = 1
          while (roleByRenderId.has(id) && roleByRenderId.get(id) !== role) {
            id = buildMessageRoleCollisionId(sourceId, role, ++suffix)
          }
        }
      }
      if (occupied.has(id) || (occurrence > 1 && !message.provider_source_id?.trim())) {
        id = buildAvailableProviderOccurrenceId(
          getMessageProviderSourceId(message),
          roleOf(message),
          occurrence,
          occupied
        )
      }
    }
    occupied.add(id)
    renderedOccurrenceIds.set(occurrenceKey, id)
    const retained = {
      ...message,
      id,
      ...(match || id !== message.id ? { provider_source_id: source } : {}),
      ...(match || getMessageProviderOccurrence(message) !== undefined || occurrence > 1
        ? { provider_occurrence: occurrence }
        : {})
    }
    registerRole(retained)
    retain(retained)
  }
  return { ids, identities }
}
