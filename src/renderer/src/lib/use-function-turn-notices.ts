import { useEffect, useState } from "react"
import type { FunctionTurnNotice } from "../../../shared/mods/v2/turn"
import type { ModsThreadScope } from "./mods-thread-scope"

const EMPTY_NOTICES: readonly FunctionTurnNotice[] = []
export function useFunctionTurnNotices(
  threadId: string,
  scope: ModsThreadScope | null = null
): readonly FunctionTurnNotice[] {
  const admitted = scope?.threadId === threadId ? scope : null
  const [snapshot, setSnapshot] = useState<{
    scope: ModsThreadScope
    notices: FunctionTurnNotice[]
  }>()
  useEffect(() => {
    if (!admitted) return
    let live = true
    let sequence = 0
    const refresh = () => {
      if (!live) return
      const request = ++sequence
      void window.api.mods.turnNotices(threadId).then(
        (notices) => {
          if (live && sequence === request) setSnapshot({ scope: admitted, notices })
        },
        () => {
          if (live && sequence === request) setSnapshot({ scope: admitted, notices: [] })
        }
      )
    }
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId) refresh()
    })
    window.addEventListener("mods:configuration-changed", refresh)
    refresh()
    return () => {
      live = false
      stop()
      window.removeEventListener("mods:configuration-changed", refresh)
    }
  }, [threadId, admitted])
  return admitted && snapshot?.scope === admitted ? snapshot.notices : EMPTY_NOTICES
}
