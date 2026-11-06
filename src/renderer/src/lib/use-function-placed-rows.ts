import { useEffect, useState } from "react"
import type { FunctionPlacedEntry } from "../../../shared/mods/v2/placed"
import { useFunctionDesktopOwner } from "./function-desktop-owner"
import { createLatestDisplayRead } from "./latest-display-read"

const EMPTY: readonly FunctionPlacedEntry[] = []
/** Resident discovery only; mounting a chat never starts or approves a plugin. */
export function useFunctionPlacedRows(
  threadId: string,
  enabled: boolean,
  current: () => boolean
): readonly FunctionPlacedEntry[] {
  const binding = useFunctionDesktopOwner(threadId)
  const [state, setState] = useState<{ binding: typeof binding; rows: FunctionPlacedEntry[] }>()
  useEffect(() => {
    if (!enabled || !binding || !window.api.mods.placedRows) return
    const reader = createLatestDisplayRead({
      read: () => window.api.mods.placedRows(threadId, binding.owner),
      publish: rows => { if (current()) setState({ binding, rows }) },
      failed: () => setState({ binding, rows: [] })
    })
    const refresh = reader.refresh
    const stop = window.api.mods.onCardsChanged((event) => {
      if (
        event.threadId === threadId &&
        (event.scope === "placed" || !event.scope || event.scope.startsWith("source-"))
      )
        refresh()
    })
    refresh()
    return () => {
      reader.close()
      stop()
    }
  }, [threadId, binding, enabled, current])
  return enabled && current() && binding && state?.binding === binding ? state.rows : EMPTY
}
