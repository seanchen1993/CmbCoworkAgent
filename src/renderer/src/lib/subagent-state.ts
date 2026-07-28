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
  existingRestoredFromPromptOnly?: boolean
  incomingObservedLive?: boolean
  parentStreamIsActive?: boolean
  parentStreamHasStopped: boolean
}): Subagent["status"] {
  const incomingStatus = input.incomingStatus as Subagent["status"] | undefined
  const canRevivePromptOnlyPlaceholder =
    input.existingStatus === "cancelled" &&
    input.existingRestoredFromPromptOnly === true &&
    input.incomingObservedLive === true &&
    input.parentStreamIsActive === true &&
    !input.parentStreamHasStopped &&
    (incomingStatus === "pending" || incomingStatus === "running")
  if (
    input.existingStatus &&
    isTerminalSubagentStatus(input.existingStatus) &&
    !canRevivePromptOnlyPlaceholder &&
    (!incomingStatus || incomingStatus === "pending" || incomingStatus === "running")
  ) {
    return input.existingStatus
  }

  const status = incomingStatus || input.existingStatus || "running"
  return input.parentStreamHasStopped && status === "running" ? "cancelled" : status
}

/**
 * Merge an authoritative snapshot for the current run without discarding
 * terminal cards restored from older transcript buckets. The transport resets
 * its active-subagent registry between streams, so a snapshot cannot be
 * authoritative for historical executions.
 */
export function mergeSubagentSnapshotWithHistory(
  existingSubagents: Subagent[],
  incomingSubagents: Subagent[],
  options: {
    parentStreamHasStopped: boolean
    parentStreamIsActive?: boolean
    fallbackCompletedAt?: Date
  }
): Subagent[] {
  const incomingById = new Map<string, Subagent>()
  for (const incoming of incomingSubagents) incomingById.set(incoming.id, incoming)

  const merged: Subagent[] = []
  const handledIds = new Set<string>()
  const mergeIncoming = (incoming: Subagent, existing?: Subagent): Subagent => {
    const effectiveStatus = resolveIncomingSubagentStatus({
      incomingStatus: incoming.status,
      existingStatus: existing?.status,
      existingRestoredFromPromptOnly: existing?.restoredFromPromptOnly,
      incomingObservedLive: incoming.observedLive,
      parentStreamIsActive: options.parentStreamIsActive,
      parentStreamHasStopped: options.parentStreamHasStopped
    })
    const revivedPromptOnlyPlaceholder =
      existing?.restoredFromPromptOnly === true &&
      incoming.observedLive === true &&
      options.parentStreamIsActive === true &&
      !options.parentStreamHasStopped &&
      (incoming.status === "pending" || incoming.status === "running")
    const incomingIsAuthoritative =
      revivedPromptOnlyPlaceholder || isTerminalSubagentStatus(incoming.status)
    return {
      ...existing,
      ...incoming,
      id: incoming.id,
      toolCallId: incoming.toolCallId ?? existing?.toolCallId,
      name: incoming.name || existing?.name || "Subagent",
      description: incoming.description ?? existing?.description ?? "",
      status: effectiveStatus,
      startedAt: incoming.startedAt ?? existing?.startedAt,
      completedAt:
        incoming.completedAt ??
        (effectiveStatus === "cancelled"
          ? options.fallbackCompletedAt ?? existing?.completedAt
          : existing?.completedAt),
      subagentType: incoming.subagentType ?? existing?.subagentType,
      currentTool: incoming.currentTool ?? existing?.currentTool,
      lastActivityAt: incoming.lastActivityAt ?? existing?.lastActivityAt,
      spawnIndex: incoming.spawnIndex ?? existing?.spawnIndex,
      observedLive: incoming.observedLive ?? existing?.observedLive,
      restoredFromPromptOnly: incomingIsAuthoritative
        ? undefined
        : (incoming.restoredFromPromptOnly ?? existing?.restoredFromPromptOnly)
    }
  }

  for (const existing of existingSubagents) {
    const incoming = incomingById.get(existing.id)
    if (incoming) {
      merged.push(mergeIncoming(incoming, existing))
      handledIds.add(existing.id)
    } else if (isTerminalSubagentStatus(existing.status)) {
      merged.push(existing)
    }
  }

  for (const incoming of incomingSubagents) {
    if (handledIds.has(incoming.id)) continue
    merged.push(mergeIncoming(incoming))
    handledIds.add(incoming.id)
  }
  return merged
}
