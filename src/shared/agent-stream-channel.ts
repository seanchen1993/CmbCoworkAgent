export function resolveAgentStreamRequestChannel(
  ambientChannel: string,
  streamRequestId: string | undefined
): string {
  const requestId = streamRequestId?.trim()
  return requestId ? `${ambientChannel}:request:${encodeURIComponent(requestId)}` : ambientChannel
}

export type AgentStreamEventSource = "request" | "ambient"
export type AgentStreamDeliveryDecision = "deliver" | "deliver-and-close" | "ignore"

export function classifyAgentStreamDelivery(
  source: AgentStreamEventSource,
  eventType: string
): AgentStreamDeliveryDecision {
  const terminal = eventType === "done" || eventType === "error"
  if (source === "ambient") return terminal ? "ignore" : "deliver"
  return terminal ? "deliver-and-close" : "deliver"
}
