import { posix, win32 } from "node:path"

export type ReplacementSettlementOutcome = "settled" | "timed_out"

export interface RunSettlementPhase {
  name: string
  run: () => void | Promise<void>
  shouldRun?: () => boolean
  timeoutMs?: number
}

interface RunSettlementPhasesOptions {
  phases: readonly RunSettlementPhase[]
  resolveSettlement: () => void
  onPhaseError?: (phaseName: string, error: unknown) => void
}

interface SingleFlightBatchState<Batch> {
  pending: Batch | undefined
  worker: (batch: Batch) => Promise<void>
}

export interface SingleFlightBatchCoalescerOptions {
  schedule: (operation: () => Promise<void>) => void
  onError?: (error: unknown) => void
}

export function normalizeAbsolutePathKey(
  candidatePath: string,
  workspacePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const pathApi = platform === "win32" ? win32 : posix
  const absolutePath = pathApi.isAbsolute(candidatePath)
    ? candidatePath
    : pathApi.resolve(workspacePath, candidatePath)
  const normalized = pathApi.normalize(absolutePath).replace(/\\/g, "/")
  const normalizedRoot = pathApi.parse(absolutePath).root.replace(/\\/g, "/")
  const withoutTrailingSeparators =
    normalized.length > normalizedRoot.length ? normalized.replace(/\/+$/, "") : normalized
  return platform === "win32" ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators
}

export function isPathInsideAnyDirectory(
  candidatePath: string,
  directoryPaths: readonly string[],
  workspacePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const candidateKey = normalizeAbsolutePathKey(candidatePath, workspacePath, platform)
  return directoryPaths.some((directoryPath) => {
    const directoryKey = normalizeAbsolutePathKey(directoryPath, workspacePath, platform)
    return candidateKey === directoryKey || candidateKey.startsWith(`${directoryKey}/`)
  })
}

/**
 * Compare-and-release ownership for resources whose external cleanup API has
 * no owner token of its own. A late predecessor therefore cannot clear a
 * successor's claim for the same logical key.
 */
export class OwnedClaimFence<Key, Owner> {
  private readonly owners = new Map<Key, Owner>()

  claim(key: Key, owner: Owner): void {
    this.owners.set(key, owner)
  }

  release(key: Key, owner: Owner, onRelease: () => void): boolean {
    if (this.owners.get(key) !== owner) return false
    this.owners.delete(key)
    onRelease()
    return true
  }
}

/**
 * Keeps at most one active worker and one aggregate pending batch per key. New
 * work arriving while a batch is active is merged into the pending aggregate,
 * rather than replacing an intermediate turn or launching concurrent work.
 */
export class SingleFlightBatchCoalescer<Key, Batch> {
  private readonly states = new Map<Key, SingleFlightBatchState<Batch>>()

  constructor(private readonly options: SingleFlightBatchCoalescerOptions) {}

  enqueue(
    key: Key,
    batch: Batch,
    merge: (current: Batch, incoming: Batch) => Batch,
    worker: (batch: Batch) => Promise<void>
  ): void {
    const existing = this.states.get(key)
    if (existing) {
      try {
        existing.pending = existing.pending ? merge(existing.pending, batch) : batch
      } catch (error) {
        try {
          this.options.onError?.(error)
        } catch {
          // Diagnostics must not let optional batch work fail the caller.
        }
        return
      }
      existing.worker = worker
      return
    }

    const state: SingleFlightBatchState<Batch> = {
      pending: batch,
      worker
    }
    this.states.set(key, state)
    const drain = async (): Promise<void> => {
      try {
        while (state.pending !== undefined) {
          const next = state.pending
          state.pending = undefined
          try {
            await state.worker(next)
          } catch (error) {
            try {
              this.options.onError?.(error)
            } catch {
              // Diagnostics must not strand the next aggregate batch.
            }
          }
        }
      } finally {
        if (this.states.get(key) === state) this.states.delete(key)
      }
    }
    try {
      this.options.schedule(drain)
    } catch (error) {
      if (this.states.get(key) === state) this.states.delete(key)
      try {
        this.options.onError?.(error)
      } catch {
        // Diagnostics must not retain a batch whose scheduler failed.
      }
    }
  }

  hasPending(key: Key): boolean {
    return this.states.has(key)
  }
}

class RunSettlementPhaseTimeoutError extends Error {
  constructor(phaseName: string, timeoutMs: number) {
    super(`Run settlement phase "${phaseName}" exceeded ${timeoutMs}ms`)
    this.name = "RunSettlementPhaseTimeoutError"
  }
}

function reportSettlementPhaseError(
  onPhaseError: RunSettlementPhasesOptions["onPhaseError"],
  phaseName: string,
  error: unknown
): void {
  try {
    onPhaseError?.(phaseName, error)
  } catch {
    // Diagnostics must never become another settlement fence.
  }
}

async function runBoundedSettlementPhase(
  phase: RunSettlementPhase
): Promise<void> {
  if (phase.timeoutMs === undefined) {
    await phase.run()
    return
  }

  const operation = Promise.resolve().then(phase.run)
  const timeoutMs = Math.max(0, phase.timeoutMs)
  // Keep an explicit rejection observer after Promise.race has timed out. The
  // underlying local persistence call cannot be cancelled, but a late failure
  // must not surface as an unhandled rejection.
  void operation.catch(() => {})

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new RunSettlementPhaseTimeoutError(phase.name, timeoutMs)),
          timeoutMs
        )
        timeoutTimer.unref?.()
      })
    ])
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
}

/**
 * Runs terminal cleanup as isolated, bounded best-effort phases. A failed or
 * stalled phase cannot prevent later ownership cleanup, and the physical run's
 * settlement promise is released from the outermost finally block.
 */
export async function runSettlementPhases({
  phases,
  resolveSettlement,
  onPhaseError
}: RunSettlementPhasesOptions): Promise<void> {
  try {
    for (const phase of phases) {
      if (phase.shouldRun) {
        try {
          if (!phase.shouldRun()) continue
        } catch (error) {
          reportSettlementPhaseError(onPhaseError, `${phase.name}:guard`, error)
          continue
        }
      }

      try {
        await runBoundedSettlementPhase(phase)
      } catch (error) {
        reportSettlementPhaseError(onPhaseError, phase.name, error)
      }
    }
  } finally {
    try {
      resolveSettlement()
    } catch (error) {
      reportSettlementPhaseError(onPhaseError, "resolve-settlement", error)
    }
  }
}

export class TimedOutPredecessorFence {
  private readonly pending = new Map<string, Set<Promise<void>>>()

  track(threadId: string, settled: Promise<void>): void {
    const entries = this.pending.get(threadId) ?? new Set<Promise<void>>()
    if (entries.has(settled)) return
    entries.add(settled)
    this.pending.set(threadId, entries)
    void settled.finally(() => {
      const current = this.pending.get(threadId)
      current?.delete(settled)
      if (current?.size === 0) this.pending.delete(threadId)
    })
  }

  hasPending(threadId: string): boolean {
    return (this.pending.get(threadId)?.size ?? 0) > 0
  }
}

export function canUseBoundedCheckpointRecovery(
  outcome: ReplacementSettlementOutcome,
  hasTimedOutPredecessor: boolean
): boolean {
  return outcome === "settled" && !hasTimedOutPredecessor
}
