import { resolveAgentModeFromMetadata } from "../../shared/agent-mode-metadata"

/** Original thread identity remains recognizable when a historical work is detached. */
export function hasOrdinaryBotConversationShape(metadata: Record<string, unknown>): boolean {
  if (metadata.threadType || metadata.heartbeat || metadata.heartbeatSession) return false
  return ![
    "botId", "botHostId", "botWorkId", "botGroupId", "botMockBindingId", "botLocalConversation",
    "harnessFeature", "harnessProjectSession", "imDeliveryContext", "remoteImContext", "targetKind",
    "remoteState", "remoteReadOnly", "remoteThread", "isHeartbeat", "scheduledTaskId", "partnerInputOnly"
  ].some(key => metadata[key] != null)
}

/** Admission for new Bot operations; reading does not require a live directory. */
export function isOrdinaryBotConversation(metadata: Record<string, unknown>): boolean {
  return resolveAgentModeFromMetadata(metadata) === "normal" && hasOrdinaryBotConversationShape(metadata)
}
