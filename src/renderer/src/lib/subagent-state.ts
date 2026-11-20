import type { Subagent } from "@/types"

const TERMINAL_SUBAGENT_STATUSES = new Set<Subagent["status"]>([
  "completed",
  "failed",
  "cancelled"
])

export function isTerminalSubagentStatus(status?: Subagent["status"]): boolean {
  return !!status && TERMINAL_SUBAGENT_STATUSES.has(status)
}

function subagentDisplayTimestamp(subagent: Subagent): number {
  const value = subagent.completedAt ?? subagent.startedAt
  if (!value) return Number.NEGATIVE_INFINITY
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

/** Surface active work first, then show terminal history from newest to oldest. */
export function orderSubagentsForDisplay(subagents: readonly Subagent[]): Subagent[] {
  const running: Subagent[] = []
  const pending: Subagent[] = []
  const terminal: Array<{ subagent: Subagent; originalIndex: number }> = []
  subagents.forEach((subagent, originalIndex) => {
    if (subagent.status === "running") running.push(subagent)
    else if (subagent.status === "pending") pending.push(subagent)
    else terminal.push({ subagent, originalIndex })
  })
  terminal.sort((left, right) => {
    const leftTimestamp = subagentDisplayTimestamp(left.subagent)
    const rightTimestamp = subagentDisplayTimestamp(right.subagent)
    if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp
    const leftSpawnIndex = left.subagent.spawnIndex ?? Number.NEGATIVE_INFINITY
    const rightSpawnIndex = right.subagent.spawnIndex ?? Number.NEGATIVE_INFINITY
    if (leftSpawnIndex !== rightSpawnIndex) return rightSpawnIndex - leftSpawnIndex
    return right.originalIndex - left.originalIndex
  })
  return [...running, ...pending, ...terminal.map(({ subagent }) => subagent)]
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
