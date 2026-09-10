export const AGENT_OUTPUT_STYLE_VALUES = ["default", "concise", "explanatory", "learning"] as const

export type AgentOutputStyle = (typeof AGENT_OUTPUT_STYLE_VALUES)[number]

export const DEFAULT_AGENT_OUTPUT_STYLE: AgentOutputStyle = "default"

export function isAgentOutputStyle(value: unknown): value is AgentOutputStyle {
  return AGENT_OUTPUT_STYLE_VALUES.some((style) => style === value)
}

export function resolveAgentOutputStyle(
  value: unknown,
  legacyConciseModeEnabled = false
): AgentOutputStyle {
  if (isAgentOutputStyle(value)) return value
  return legacyConciseModeEnabled ? "concise" : DEFAULT_AGENT_OUTPUT_STYLE
}

export function resolveThreadOutputStyle(metadata: unknown): AgentOutputStyle {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return DEFAULT_AGENT_OUTPUT_STYLE
  }
  const record = metadata as Record<string, unknown>
  return resolveAgentOutputStyle(record.outputStyle, record.conciseModeEnabled === true)
}
