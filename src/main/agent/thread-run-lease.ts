export type LocalThreadRunOwner = "desktop" | "im" | "scheduler"

export interface LocalThreadRunLease {
  threadId: string
  owner: LocalThreadRunOwner
  runId: string
  acquiredAt: string
}

export type LocalThreadRunLeaseReleasedListener = (lease: LocalThreadRunLease) => void

export type LocalThreadRunLeaseClaim =
  | {
      acquired: true
      lease: LocalThreadRunLease
      disposition: "new" | "existing" | "handoff"
    }
  | {
      acquired: false
      conflict: LocalThreadRunLease
    }

export interface ClaimLocalThreadRunLeaseInput {
  threadId: string
  owner: LocalThreadRunOwner
  runId: string
  /**
   * Exact same-owner compare-and-swap. Callers may hand off only the physical
   * run they already own; omitting or mismatching this id never steals a lease.
   */
  handoffFromRunId?: string
  acquiredAt?: string
}

const activeLeases = new Map<string, LocalThreadRunLease>()
const releaseListeners = new Set<LocalThreadRunLeaseReleasedListener>()

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function copyLease(lease: LocalThreadRunLease): LocalThreadRunLease {
  return { ...lease }
}

function notifyReleased(lease: LocalThreadRunLease): void {
  queueMicrotask(() => {
    for (const listener of releaseListeners) {
      try {
        listener(copyLease(lease))
      } catch (error) {
        console.error("[ThreadRunLease] Release listener failed:", error)
      }
    }
  })
}

export function onLocalThreadRunLeaseReleased(
  listener: LocalThreadRunLeaseReleasedListener
): () => void {
  releaseListeners.add(listener)
  return () => releaseListeners.delete(listener)
}

export function getLocalThreadRunLease(threadId: string): LocalThreadRunLease | undefined {
  const lease = activeLeases.get(threadId)
  return lease ? copyLease(lease) : undefined
}

export function claimLocalThreadRunLease(
  input: ClaimLocalThreadRunLeaseInput
): LocalThreadRunLeaseClaim {
  const threadId = requireIdentifier(input.threadId, "threadId")
  const runId = requireIdentifier(input.runId, "runId")
  const current = activeLeases.get(threadId)

  if (current?.owner === input.owner && current.runId === runId) {
    return {
      acquired: true,
      lease: copyLease(current),
      disposition: "existing"
    }
  }

  if (current) {
    const canHandoff =
      current.owner === input.owner &&
      typeof input.handoffFromRunId === "string" &&
      input.handoffFromRunId === current.runId
    if (!canHandoff) {
      return { acquired: false, conflict: copyLease(current) }
    }
  }

  const lease: LocalThreadRunLease = {
    threadId,
    owner: input.owner,
    runId,
    acquiredAt: input.acquiredAt ?? new Date().toISOString()
  }
  activeLeases.set(threadId, lease)
  return {
    acquired: true,
    lease: copyLease(lease),
    disposition: current ? "handoff" : "new"
  }
}

export function releaseLocalThreadRunLease(
  threadId: string,
  owner: LocalThreadRunOwner,
  runId: string
): boolean {
  const current = activeLeases.get(threadId)
  if (!current || current.owner !== owner || current.runId !== runId) return false
  activeLeases.delete(threadId)
  notifyReleased(current)
  return true
}

export function assertLocalThreadRunLease(
  threadId: string,
  owner: LocalThreadRunOwner,
  runId: string
): void {
  const current = activeLeases.get(threadId)
  if (current?.owner === owner && current.runId === runId) return
  const actual = current ? `${current.owner}/${current.runId}` : "none"
  throw new Error(
    `Local Thread run lease mismatch for ${threadId}: expected ${owner}/${runId}, actual ${actual}`
  )
}

export function isLocalThreadRunOwnedByAnotherSource(
  threadId: string,
  owner: LocalThreadRunOwner
): boolean {
  const current = activeLeases.get(threadId)
  return Boolean(current && current.owner !== owner)
}
