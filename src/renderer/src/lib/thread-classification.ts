import type { Thread } from "@/types"

export function isHarnessFeatureThread(thread: Thread | null | undefined): boolean {
  const harnessFeature = thread?.metadata?.harnessFeature
  if (!harnessFeature || typeof harnessFeature !== "object") {
    return false
  }

  const metadata = harnessFeature as Record<string, unknown>
  return typeof metadata.projectId === "string" && typeof metadata.slug === "string"
}

export function isHarnessProjectSessionThread(thread: Thread | null | undefined): boolean {
  const harnessProjectSession = thread?.metadata?.harnessProjectSession
  if (!harnessProjectSession || typeof harnessProjectSession !== "object") {
    return false
  }

  const metadata = harnessProjectSession as Record<string, unknown>
  return typeof metadata.projectId === "string" && typeof metadata.kind === "string"
}

export function isHarnessProjectModeThread(thread: Thread | null | undefined): boolean {
  return isHarnessFeatureThread(thread) || isHarnessProjectSessionThread(thread)
}

/** A candidate is resolved against the local Host before any managed controls mount. */
export function isLocalWorkConversation(thread: Thread | null | undefined): boolean {
  const m = thread?.metadata
  return Boolean(
    m?.botHostId === "local" &&
    typeof m.botWorkId === "string" &&
    m.botAudienceKey === "desktop" &&
    !m.botMockBindingId &&
    !m.botGroupId
  )
}

export function isManagedLocalWorkConversation(thread: Thread | null | undefined): boolean {
  const metadata = thread?.metadata
  return (
    isLocalWorkConversation(thread) &&
    !isHarnessProjectModeThread(thread) &&
    !metadata?.remoteState &&
    !metadata?.remoteReadOnly &&
    metadata?.targetKind !== "inbox" &&
    !metadata?.imDeliveryContext
  )
}

export function isBotThread(thread: Thread | null | undefined): boolean {
  return typeof thread?.metadata?.botId === "string" && thread.metadata.botId.length > 0
}

export function isRegularChatThread(thread: Thread | null | undefined): boolean {
  return (
    Boolean(thread) &&
    !isHarnessProjectModeThread(thread) &&
    (!isBotThread(thread) || isLocalWorkConversation(thread))
  )
}

export function findFirstChatThread(threads: Thread[]): Thread | null {
  return threads.find(isRegularChatThread) ?? null
}
