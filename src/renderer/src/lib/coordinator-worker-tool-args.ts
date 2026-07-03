const COORDINATOR_WORKER_TOOL_NAMES = new Set([
  "start_worker",
  "continue_worker",
  "cancel_worker"
])

const COORDINATOR_WORKER_ENUM_ARGS: Record<string, string[]> = {
  subagent_type: ["worker"],
  role: ["implementer", "verifier"],
  workload: ["read_only", "write", "verify"],
  continuation_intent: ["follow_up_after_notification", "redirect_running_worker"]
}

export function isCoordinatorWorkerToolName(toolName: string | undefined): boolean {
  return !!toolName && COORDINATOR_WORKER_TOOL_NAMES.has(toolName)
}

export function normalizeCoordinatorWorkerToolArgsForDisplay(
  toolName: string | undefined,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!isCoordinatorWorkerToolName(toolName)) return args
  return normalizeCoordinatorWorkerArgValue(args) as Record<string, unknown>
}

function normalizeCoordinatorWorkerArgValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return normalizeCoordinatorWorkerStringArg(key, value)
  }

  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeCoordinatorWorkerArgValue(item, key))
    if (key === "consumed_notification_ids") {
      const seen = new Set<string>()
      return normalized.filter((item) => {
        if (typeof item !== "string") return true
        if (seen.has(item)) return false
        seen.add(item)
        return true
      })
    }
    return normalized
  }

  if (!value || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, item]) => [
      entryKey,
      normalizeCoordinatorWorkerArgValue(item, entryKey)
    ])
  )
}

function normalizeCoordinatorWorkerStringArg(key: string | undefined, value: string): string {
  const enumValues = key ? COORDINATOR_WORKER_ENUM_ARGS[key] : undefined
  if (enumValues) {
    const matched = enumValues.find((candidate) => value === candidate || value === `${candidate}${candidate}`)
    if (matched) return matched
  }
  return value
}
