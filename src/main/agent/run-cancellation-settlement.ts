import { AsyncLocalStorage } from "node:async_hooks"

interface CancellationSettlement {
  effectDispatched: boolean
  cancelled: boolean
  admissionClosed: boolean
  physicallySettled: boolean
  unconfirmed: boolean
}

// An original producer's conservative veto, not authorization or a second execution ledger.
// In particular, a successful command receipt cannot prove that its process tree has stopped.
const settlements = new AsyncLocalStorage<CancellationSettlement>()

export function createRunCancellationSettlement() {
  let started = false
  const state: CancellationSettlement = {
    effectDispatched: false,
    cancelled: false,
    admissionClosed: false,
    physicallySettled: false,
    unconfirmed: false
  }
  return {
    read: () => ({ requested: state.cancelled, confirmed: confirmed(state) }),
    run: async <T>(run: () => Promise<T>): Promise<T> => {
      if (started) throw Error("AGENT_RUN_CANCELLATION_FRAME_REUSED")
      started = true
      if (settlements.getStore()) markRunCancellationEffectDispatched()
      return settlements.run(state, async () => {
        try {
          return await run()
        } finally {
          // Detached callbacks retain this frame; no new cancelled-run effect may start.
          state.admissionClosed = true
        }
      })
    }
  }
}

export function withRunCancellationSettlement<T>(run: () => Promise<T>): Promise<T> {
  return createRunCancellationSettlement().run(run)
}

function confirmed(state: CancellationSettlement): boolean {
  return (
    state.cancelled &&
    state.admissionClosed &&
    state.physicallySettled &&
    !state.effectDispatched &&
    !state.unconfirmed
  )
}

/** Called synchronously BEFORE entering any tool, Hook, or Function SDK effect. */
export function markRunCancellationEffectDispatched(): void {
  const state = settlements.getStore()
  markEffect(state)
}

function markEffect(state: CancellationSettlement | undefined): void {
  if (!state) return
  state.effectDispatched = true
  if (state.cancelled && state.admissionClosed) throw Error("AGENT_RUN_EFFECT_ADMISSION_CLOSED")
}

/** Transport callbacks can run outside the dispatching async context. Capture, never rebind. */
export function observeRunCancellationEffect<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const state = settlements.getStore()
  return (...args) => {
    markEffect(state)
    return callback(...args)
  }
}

/** Bound to the original AbortController, not a renderer-supplied project/operation. */
export function captureRunCancellationRequest(callback?: () => void): () => void {
  const state = settlements.getStore()
  return () => {
    if (state) {
      state.cancelled = true
      state.admissionClosed = true
    }
    try {
      callback?.()
    } catch (error) {
      if (state) state.unconfirmed = true
      throw error
    }
  }
}

export function invalidateRunCancellationSettlement(): void {
  const state = settlements.getStore()
  if (state) state.unconfirmed = true
}

export function recordRunCancellation(): void {
  const state = settlements.getStore()
  if (!state) return
  state.cancelled = true
  state.admissionClosed = true
}

/** Only the original physical owner calls this after its awaited settlement phases. */
export function confirmRunCancellationSettlement(confirmed: boolean): void {
  const state = settlements.getStore()
  if (!state || !state.cancelled) return
  if (!confirmed) state.unconfirmed = true
  state.physicallySettled =
    confirmed && state.admissionClosed && !state.effectDispatched && !state.unconfirmed
}

export function settledRunCancellationTerminal(): {
  outcome: "error" | "unknown"
  code: string
} {
  const state = settlements.getStore()
  return state && confirmed(state)
    ? { outcome: "error", code: "cancelled_before_effect_dispatch" }
    : { outcome: "unknown", code: "unknown" }
}
