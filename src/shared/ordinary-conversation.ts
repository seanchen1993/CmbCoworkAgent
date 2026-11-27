/** The ordinary identity remains recognizable after a local work detaches its thread. */
export function hasOrdinaryBotConversationShape(metadata: Record<string, unknown>): boolean {
  if (metadata.threadType || metadata.heartbeat || metadata.heartbeatSession) return false
  return ![
    "botId", "botHostId", "botWorkId", "botGroupId", "botMockBindingId", "botLocalConversation",
    "harnessFeature", "harnessProjectSession", "imDeliveryContext", "remoteImContext", "targetKind",
    "remoteState", "remoteReadOnly", "remoteThread", "isHeartbeat", "scheduledTaskId", "partnerInputOnly"
  ].some(key => metadata[key] != null)
}
