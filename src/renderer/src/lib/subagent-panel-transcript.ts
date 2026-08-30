import type { Message } from "../types"
import {
  mergePaginatedSubagentTranscript,
  mergeTranscriptMessage
} from "./subagent-transcripts"

export interface SubagentPanelTranscriptProjection {
  messages: Message[]
  contentVersion: number
  structureVersion: number
  openingPromptIds: ReadonlySet<string>
}

interface ProjectionCache extends SubagentPanelTranscriptProjection {
  persistedPage: readonly Message[]
  liveMessages: readonly Message[]
  liveContentVersion: number
  liveTailSnapshot: Message | undefined
  mergedIndexById: Map<string, number>
  providerIdentityKeys: Set<string>
  providerRoleKeys: Set<string>
  replacementIds: Set<string>
  replacementPrefixes: string[]
}

function sameTailIdentity(left: Message, right: Message): boolean {
  return (
    left.id === right.id &&
    left.role === right.role &&
    left.provider_source_id === right.provider_source_id &&
    left.provider_occurrence === right.provider_occurrence &&
    left.tool_call_id === right.tool_call_id
  )
}

function prefixHasImmutableProvenance(
  previous: readonly Message[],
  next: readonly Message[],
  prefixLength: number
): boolean {
  if (prefixLength <= 0) return true
  const indexes = new Set([0, Math.floor((prefixLength - 1) / 2), prefixLength - 1])
  for (const index of indexes) {
    if (previous[index] !== next[index]) return false
  }
  return true
}

function isOpeningPrompt(message: Message): boolean {
  return (
    message.role === "user" &&
    (message.id.startsWith("subagent-prompt-") || Boolean(message.subagent_tool_call_id))
  )
}

function hasReplacementInstructions(message: Message): boolean {
  return Boolean(
    message.replaced_message_ids?.length ||
      message.replaced_message_id_prefixes?.length ||
      message.compatible_replaced_message_id_prefixes?.length
  )
}

function providerRoleKey(message: Message): string | null {
  return message.provider_source_id
    ? `${message.role}\u0000${message.provider_source_id}`
    : null
}

function providerIdentityKey(message: Message): string | null {
  const roleKey = providerRoleKey(message)
  return roleKey && message.provider_occurrence !== undefined
    ? `${roleKey}\u0000${message.provider_occurrence}`
    : null
}

function hasExistingReplacementAlias(cache: ProjectionCache, messageId: string): boolean {
  return (
    cache.replacementIds.has(messageId) ||
    cache.replacementPrefixes.some((prefix) => messageId.startsWith(prefix))
  )
}

function hasProviderIdentityCollision(cache: ProjectionCache, message: Message): boolean {
  const roleKey = providerRoleKey(message)
  if (!roleKey) return false
  const identityKey = providerIdentityKey(message)
  return identityKey
    ? cache.providerIdentityKeys.has(identityKey)
    : cache.providerRoleKeys.has(roleKey)
}

function buildProjectionIndexes(messages: readonly Message[]): Pick<
  ProjectionCache,
  | "mergedIndexById"
  | "providerIdentityKeys"
  | "providerRoleKeys"
  | "replacementIds"
  | "replacementPrefixes"
> {
  const mergedIndexById = new Map<string, number>()
  const providerIdentityKeys = new Set<string>()
  const providerRoleKeys = new Set<string>()
  const replacementIds = new Set<string>()
  const replacementPrefixes: string[] = []
  messages.forEach((message, index) => {
    mergedIndexById.set(message.id, index)
    const roleKey = providerRoleKey(message)
    const identityKey = providerIdentityKey(message)
    if (roleKey) providerRoleKeys.add(roleKey)
    if (identityKey) providerIdentityKeys.add(identityKey)
    message.replaced_message_ids?.forEach((id) => {
      if (id) replacementIds.add(id)
    })
    replacementPrefixes.push(
      ...(message.replaced_message_id_prefixes ?? []).filter(Boolean),
      ...(message.compatible_replaced_message_id_prefixes ?? []).filter(Boolean)
    )
  })
  return {
    mergedIndexById,
    providerIdentityKeys,
    providerRoleKeys,
    replacementIds,
    replacementPrefixes
  }
}

/**
 * Caches the expensive persisted-page/live overlay. The fast paths require
 * immutable-prefix provenance and only accept an exact tail replacement or a
 * unique append; aliases, old-page changes, reorders, and ambiguous identities
 * fall back to the canonical full merge.
 */
export function createSubagentPanelTranscriptProjector(): (
  persistedPage: readonly Message[],
  liveMessages: readonly Message[],
  allowTailFastPath?: boolean,
  liveContentVersion?: number
) => SubagentPanelTranscriptProjection {
  let cache: ProjectionCache | null = null
  let lastProjectionUsedFastPath = false

  return (persistedPage, liveMessages, allowTailFastPath = true, liveContentVersion = 0) => {
    if (
      cache?.persistedPage === persistedPage &&
      cache.liveMessages === liveMessages &&
      cache.liveContentVersion === liveContentVersion &&
      (allowTailFastPath || !lastProjectionUsedFastPath)
    ) {
      return cache
    }

    if (
      allowTailFastPath &&
      cache?.persistedPage === persistedPage &&
      liveMessages.length > 0
    ) {
      const previousLive = cache.liveMessages
      const previousTail = cache.liveTailSnapshot
      const nextTail = liveMessages.at(-1)!
      const sameLengthPrefixIsStable =
        liveMessages.length === previousLive.length &&
        (previousLive === liveMessages
          ? cache.liveContentVersion !== liveContentVersion
          : prefixHasImmutableProvenance(previousLive, liveMessages, liveMessages.length - 1))

      if (
        previousTail &&
        sameLengthPrefixIsStable &&
        sameTailIdentity(previousTail, nextTail) &&
        !hasReplacementInstructions(nextTail)
      ) {
        const mergedIndex = cache.mergedIndexById.get(previousTail.id)
        const mergedMessage = mergedIndex === undefined ? undefined : cache.messages[mergedIndex]
        if (
          mergedIndex !== undefined &&
          mergedMessage &&
          mergedMessage.role === nextTail.role &&
          mergedMessage.provider_source_id === nextTail.provider_source_id &&
          mergedMessage.provider_occurrence === nextTail.provider_occurrence
        ) {
          cache.messages[mergedIndex] = mergeTranscriptMessage(
            mergedMessage,
            nextTail
          )
          cache = {
            ...cache,
            liveMessages,
            liveContentVersion,
            liveTailSnapshot: nextTail,
            contentVersion: cache.contentVersion + 1
          }
          lastProjectionUsedFastPath = true
          return cache
        }
      }

      if (
        liveMessages.length === previousLive.length + 1 &&
        prefixHasImmutableProvenance(previousLive, liveMessages, previousLive.length) &&
        cache.mergedIndexById.has(nextTail.id) === false &&
        !hasExistingReplacementAlias(cache, nextTail.id) &&
        !hasProviderIdentityCollision(cache, nextTail) &&
        !isOpeningPrompt(nextTail) &&
        !hasReplacementInstructions(nextTail)
      ) {
        cache.messages.push(nextTail)
        cache.mergedIndexById.set(nextTail.id, cache.messages.length - 1)
        const roleKey = providerRoleKey(nextTail)
        const identityKey = providerIdentityKey(nextTail)
        if (roleKey) cache.providerRoleKeys.add(roleKey)
        if (identityKey) cache.providerIdentityKeys.add(identityKey)
        cache = {
          ...cache,
          liveMessages,
          liveContentVersion,
          liveTailSnapshot: nextTail,
          contentVersion: cache.contentVersion + 1,
          structureVersion: cache.structureVersion + 1
        }
        lastProjectionUsedFastPath = true
        return cache
      }
    }

    const messages = mergePaginatedSubagentTranscript(
      persistedPage as Message[],
      liveMessages as Message[]
    )
    cache = {
      persistedPage,
      liveMessages,
      liveContentVersion,
      liveTailSnapshot: liveMessages.at(-1),
      messages,
      ...buildProjectionIndexes(messages),
      openingPromptIds: new Set(
        liveMessages.filter(isOpeningPrompt).map((message) => message.id)
      ),
      contentVersion: (cache?.contentVersion ?? 0) + 1,
      structureVersion: (cache?.structureVersion ?? 0) + 1
    }
    lastProjectionUsedFastPath = false
    return cache
  }
}
