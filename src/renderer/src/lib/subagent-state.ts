import type { Subagent } from "@/types"

const TERMINAL_SUBAGENT_STATUSES = new Set<Subagent["status"]>([
  "completed",
  "failed",
  "cancelled"
])

export function isTerminalSubagentStatus(status?: Subagent["status"]): boolean {
  return !!status && TERMINAL_SUBAGENT_STATUSES.has(status)
}

export function resolveIncomingSubagentStatus(input: {
  incomingStatus?: string
  existingStatus?: Subagent["status"]
  parentStreamHasStopped: boolean
}): Subagent["status"] {
  const incomingStatus = input.incomingStatus as Subagent["status"] | undefined
  if (
    input.existingStatus &&
    isTerminalSubagentStatus(input.existingStatus) &&
    (!incomingStatus || incomingStatus === "pending" || incomingStatus === "running")
  ) {
    return input.existingStatus
  }

  const status = incomingStatus || input.existingStatus || "running"
  return input.parentStreamHasStopped && status === "running" ? "cancelled" : status
}
