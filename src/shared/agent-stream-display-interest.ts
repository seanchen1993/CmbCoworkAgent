export const AGENT_STREAM_DISPLAY_INTERESTS = ["foreground", "background", "hidden"] as const

export type AgentStreamDisplayInterest = (typeof AGENT_STREAM_DISPLAY_INTERESTS)[number]

export function isAgentStreamDisplayInterest(
  value: unknown
): value is AgentStreamDisplayInterest {
  return (
    typeof value === "string" &&
    (AGENT_STREAM_DISPLAY_INTERESTS as readonly string[]).includes(value)
  )
}
