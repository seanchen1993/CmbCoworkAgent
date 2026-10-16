export type CapabilityUsage = "universal" | "chat" | "project"
export type CapabilityUsageContext = "chat" | "project"

/** Compatibility only; applicability never grants runtime authority. */
export function parseCapabilityUsage(
  value: unknown,
  fallback: CapabilityUsage = "universal"
): CapabilityUsage {
  if (value === undefined) return fallback
  if (value !== "universal" && value !== "chat" && value !== "project")
    throw Error("CAPABILITY_USAGE_INVALID")
  return value
}

export function capabilityUsageLabel(usage?: CapabilityUsage): string {
  return { universal: "通用", chat: "仅限对话", project: "仅限项目" }[parseCapabilityUsage(usage)]
}

export function isCapabilityUsageAllowed(
  usage: CapabilityUsage | undefined,
  context: CapabilityUsageContext
): boolean {
  if (context !== "chat" && context !== "project") throw Error("CAPABILITY_CONTEXT_INVALID")
  const parsed = parseCapabilityUsage(usage)
  return parsed === "universal" || parsed === context
}
