import { useEffect, useState } from "react"
import type { FunctionTurnNotice } from "../../../shared/mods/v2/turn"

const EMPTY_NOTICES: readonly FunctionTurnNotice[] = []

export function useFunctionTurnNotices(threadId: string): readonly FunctionTurnNotice[] {
  const [snapshot, setSnapshot] = useState<{ threadId: string; notices: FunctionTurnNotice[] }>()
  useEffect(() => {
    let live = true
    let sequence = 0
    const refresh = () => {
      const request = ++sequence
      void window.api.mods.turnNotices(threadId).then(
        (notices) => {
          if (live && sequence === request) setSnapshot({ threadId, notices })
        },
        () => {
          if (live && sequence === request) setSnapshot({ threadId, notices: [] })
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
  }, [threadId])
  return snapshot?.threadId === threadId ? snapshot.notices : EMPTY_NOTICES
}
