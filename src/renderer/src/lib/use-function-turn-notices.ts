import { useEffect, useState } from "react"
import { modUiChangeAffects } from "../../../shared/mods/types"
import { createLatestDisplayRead } from "./latest-display-read"
import type { FunctionTurnNotice } from "../../../shared/mods/v2/turn"

const EMPTY_NOTICES: readonly FunctionTurnNotice[] = []

export function useFunctionTurnNotices(
  threadId: string,
  enabled: boolean
): readonly FunctionTurnNotice[] {
  const [snapshot, setSnapshot] = useState<{ threadId: string; notices: FunctionTurnNotice[] }>()
  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Retire notices from the disabled scope before a later activation.
      setSnapshot(undefined)
      return
    }
    const reader = createLatestDisplayRead({
      read: () => window.api.mods.turnNotices(threadId),
      publish: notices => setSnapshot({ threadId, notices }),
      failed: () => setSnapshot({ threadId, notices: [] })
    })
    const refresh = reader.refresh
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId && modUiChangeAffects(event.scope, "records")) refresh()
    })
    window.addEventListener("mods:configuration-changed", refresh)
    refresh()
    return () => {
      reader.close()
      stop()
      window.removeEventListener("mods:configuration-changed", refresh)
    }
  }, [threadId, enabled])
  return enabled && snapshot?.threadId === threadId ? snapshot.notices : EMPTY_NOTICES
}
