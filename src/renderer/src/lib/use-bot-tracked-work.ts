import { useEffect, useMemo, useState } from "react"
import {
  botTrackedWorkTarget,
  botTrackedWorkKey,
  type BotTrackedWorkTarget
} from "../../../shared/bot-work-pages"
import {
  botTrackedWorkError,
  observeBotTrackedWorkRegistration,
  type BotTrackedWorkIssue
} from "./bot-tracked-work"
import { useBotWorkspaceStore } from "./bot-workspace-store"

/** Undefined means not yet observed, never terminal or deleted. */
export function useBotTrackedWork(target?: BotTrackedWorkTarget) {
  const key = target ? botTrackedWorkKey(target) : ""
  const encoded = target ? JSON.stringify(target) : ""
  const stableTarget = useMemo(
    () => (encoded ? botTrackedWorkTarget.parse(JSON.parse(encoded)) : undefined),
    [encoded]
  )
  const supported = useBotWorkspaceStore((state) => state.snapshot?.work?.projection === "paged")
  const hostId = useBotWorkspaceStore((state) => state.host?.hostId)
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch)
  const scope = JSON.stringify([hostId, dataEpoch, encoded])
  const value = useBotWorkspaceStore((state) => (key ? state.trackedWork[key] : undefined))
  const [issue, setIssue] = useState<BotTrackedWorkIssue>()
  const error = botTrackedWorkError(issue, scope, !!supported && !!stableTarget)
  useEffect(() => {
    if (!supported || !stableTarget) return
    let active = true
    const store = useBotWorkspaceStore.getState()
    const stop = observeBotTrackedWorkRegistration(
      scope,
      () => store.trackWork(stableTarget),
      store.watchTrackedWorkCapacity,
      (next) => {
        queueMicrotask(() => {
          if (active) setIssue(next)
        })
      }
    )
    return () => {
      active = false
      stop()
    }
  }, [supported, stableTarget, scope])
  return { supported, value, loading: !!supported && !!target && !value && !error, error }
}
