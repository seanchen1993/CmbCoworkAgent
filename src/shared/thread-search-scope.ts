import { isRemoteInboxMetadata, REMOTE_INBOX_WORKSPACE_NAME } from "./remote-inbox-workspace"

interface ThreadClassification {
  metadata?: Record<string, unknown> | null
}

function readMetadataObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function isHarnessFeatureThread(thread: ThreadClassification | null | undefined): boolean {
  const feature = readMetadataObject(thread?.metadata?.harnessFeature)
  return typeof feature?.projectId === "string" && typeof feature?.slug === "string"
}

export function isHarnessProjectSessionThread(
  thread: ThreadClassification | null | undefined
): boolean {
  const session = readMetadataObject(thread?.metadata?.harnessProjectSession)
  return typeof session?.projectId === "string" && typeof session?.kind === "string"
}

export function isHarnessProjectModeThread(
  thread: ThreadClassification | null | undefined
): boolean {
  return isHarnessFeatureThread(thread) || isHarnessProjectSessionThread(thread)
}

/** A candidate is resolved against the local Host before any managed controls mount. */
export function isLocalWorkConversation(thread: ThreadClassification | null | undefined): boolean {
  const m = thread?.metadata
  return Boolean(
    m?.botHostId === "local" &&
    typeof m.botWorkId === "string" &&
    ((m.botAudienceKey === "desktop" && !m.botMockBindingId) ||
      (typeof m.botMockBindingId === "string" &&
        (m.botMockTransport === "im" ||
          (m.botMockTransport == null &&
            typeof m.botAudienceKey === "string" &&
            m.botAudienceKey.startsWith("im:"))))) &&
    !m.botGroupId
  )
}

export function isBotThread(thread: ThreadClassification | null | undefined): boolean {
  return typeof thread?.metadata?.botId === "string" && thread.metadata.botId.length > 0
}

export function isRegularChatThread(thread: ThreadClassification | null | undefined): boolean {
  return (
    Boolean(thread) &&
    !isHarnessProjectModeThread(thread) &&
    (!isBotThread(thread) || isLocalWorkConversation(thread))
  )
}

export function matchesOrdinaryThreadScope(
  thread: ThreadClassification,
  workspacePath?: string | null
): boolean {
  if (!isRegularChatThread(thread)) return false
  if (workspacePath === undefined) return true
  const storedPath = thread.metadata?.workspacePath
  if (workspacePath === null) return typeof storedPath !== "string" || !storedPath.trim()
  return storedPath === workspacePath
}

export function getDisplayThreadTitle(thread: {
  thread_id: string
  title?: string | null
  metadata?: Record<string, unknown>
  remoteInbox?: boolean
}): string {
  if (thread.remoteInbox ?? isRemoteInboxMetadata(thread.metadata)) return REMOTE_INBOX_WORKSPACE_NAME
  const title = thread.title?.trim()
  if (!title || title === "..." || title === "…") {
    return thread.thread_id.length <= 20 ? thread.thread_id : thread.thread_id.slice(0, 20) + "..."
  }

  if (title.startsWith("[Heartbeat]")) return title.slice(12).trim()
  if (title.startsWith("[定时]")) return title.slice(5).trim()
  if (title.startsWith("[远端机器人] ")) return `(远端) ${title.slice(8).trim()}`
  if (title.startsWith("[机器人] ")) return title.slice(6).trim()
  return title
}
