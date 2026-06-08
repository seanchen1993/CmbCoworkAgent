import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { TaskCardItem } from "../../../../shared/task-card-types"
import {
  emitWorkspaceTaskCardChanged,
  isSameWorkspacePath,
  WORKSPACE_TASK_CARD_CHANGED_EVENT,
  type WorkspaceTaskCardChangedDetail
} from "@/lib/workspace-task-card-events"

const SAVE_DEBOUNCE_MS = 250

export interface UseWorkspaceTaskCard {
  cardNumber: string
  loading: boolean
  /**
   * User-initiated change. Persists (immediately when a card object is picked,
   * debounced while typing). Used by the picker's onValueChange.
   */
  handleCardNumberChange: (nextValue: string, card?: TaskCardItem | null) => void
  /** Update the in-memory value only, without persisting (e.g. history prefill). */
  setCardNumberLocal: (nextValue: string) => void
  /** Persist the current (or given) value immediately, e.g. after a successful commit. */
  persistNow: (nextValue?: string) => void
}

/**
 * Shared per-workspace task-card state: load, debounced persistence, cross-component
 * sync via {@link WORKSPACE_TASK_CARD_CHANGED_EVENT}, and failure handling. Used by
 * both the inline Git commit panel and the header WorkspaceTaskCardControl so the two
 * stay in lockstep.
 */
export function useWorkspaceTaskCard(workspacePath?: string | null): UseWorkspaceTaskCard {
  const [cardNumber, setCardNumber] = useState("")
  const [loading, setLoading] = useState(false)
  // Mirror of cardNumber for use inside async callbacks (avoids stale closures).
  const latestRef = useRef("")
  // Last value known to be on disk; used to resync the UI if a save fails.
  const persistedRef = useRef("")
  const timerRef = useRef<number | null>(null)
  // Monotonic id of the most recent save; lets a stale save's result (success or
  // failure) bow out instead of clobbering a newer value the user already set.
  const saveSeqRef = useRef(0)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Record a new "current intent" and return its generation. Any save tagged with
  // an older generation is stale and must not touch the UI or broadcast — the bump
  // happens at the moment the value changes (incl. while a debounce timer is still
  // pending), not when the save actually runs.
  const bumpAndSet = useCallback((nextValue: string): number => {
    latestRef.current = nextValue
    setCardNumber(nextValue)
    return ++saveSeqRef.current
  }, [])

  const save = useCallback(
    async (nextValue: string, seq: number): Promise<void> => {
      if (!workspacePath?.trim()) return
      const normalizedValue = nextValue.trim()
      try {
        await window.api.autoCommit.saveWorkspaceCard(workspacePath, normalizedValue || undefined)
      } catch (e) {
        // A newer change superseded this save — leave the UI on the newer value.
        if (seq !== saveSeqRef.current) return
        // Otherwise resync the UI to what is actually on disk and surface the
        // failure, instead of silently leaving the in-memory value diverged.
        const fallback = persistedRef.current
        latestRef.current = fallback
        setCardNumber(fallback)
        toast.error(`任务卡保存失败：${e instanceof Error ? e.message : String(e)}`)
        return
      }
      // A newer change landed — let its save own the persisted value and the event.
      if (seq !== saveSeqRef.current) return
      persistedRef.current = normalizedValue
      emitWorkspaceTaskCardChanged({ workspacePath, cardNumber: normalizedValue })
    },
    [workspacePath]
  )

  const setCardNumberLocal = useCallback(
    (nextValue: string) => {
      bumpAndSet(nextValue)
    },
    [bumpAndSet]
  )

  const handleCardNumberChange = useCallback(
    (nextValue: string, card?: TaskCardItem | null) => {
      const seq = bumpAndSet(nextValue)
      if (card) {
        clearTimer()
        void save(nextValue, seq)
        return
      }
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        void save(nextValue, seq)
      }, SAVE_DEBOUNCE_MS)
    },
    [save, clearTimer, bumpAndSet]
  )

  const persistNow = useCallback(
    (nextValue?: string) => {
      const seq = bumpAndSet(nextValue ?? latestRef.current)
      clearTimer()
      void save(latestRef.current, seq)
    },
    [save, clearTimer, bumpAndSet]
  )

  // Load the saved card whenever the workspace changes.
  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      if (!workspacePath?.trim()) {
        persistedRef.current = ""
        latestRef.current = ""
        setCardNumber("")
        // Supersede any save still in flight for the previous workspace.
        saveSeqRef.current += 1
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const card = await window.api.autoCommit.getWorkspaceCard(workspacePath)
        if (cancelled) return
        const next = card.cardNumber ?? ""
        persistedRef.current = next
        latestRef.current = next
        setCardNumber(next)
        saveSeqRef.current += 1
      } catch {
        if (cancelled) return
        persistedRef.current = ""
        latestRef.current = ""
        setCardNumber("")
        saveSeqRef.current += 1
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
      clearTimer()
    }
  }, [workspacePath, clearTimer])

  // Sync when another component changes the card for the same workspace.
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<WorkspaceTaskCardChangedDetail>).detail
      if (!detail || !isSameWorkspacePath(detail.workspacePath, workspacePath)) return
      persistedRef.current = detail.cardNumber
      latestRef.current = detail.cardNumber
      setCardNumber(detail.cardNumber)
      // An external authoritative value supersedes any local save in flight.
      saveSeqRef.current += 1
    }
    window.addEventListener(WORKSPACE_TASK_CARD_CHANGED_EVENT, handler)
    return () => {
      window.removeEventListener(WORKSPACE_TASK_CARD_CHANGED_EVENT, handler)
    }
  }, [workspacePath])

  return { cardNumber, loading, handleCardNumberChange, setCardNumberLocal, persistNow }
}
