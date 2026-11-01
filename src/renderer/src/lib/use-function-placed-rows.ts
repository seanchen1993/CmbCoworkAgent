import { useEffect, useState } from "react"
import type { FunctionPlacedEntry } from "../../../shared/mods/v2/placed"
import { useFunctionDesktopOwner } from "./function-desktop-owner"

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
    let live = true,
      revision = 0
    const refresh = () => {
      const request = ++revision
      void window.api.mods.placedRows(threadId, binding.owner).then(
        (rows) => {
          if (live && request === revision && current()) setState({ binding, rows })
        },
        () => {
          if (live && request === revision) setState({ binding, rows: [] })
        }
      )
    }
    const stop = window.api.mods.onCardsChanged((event) => {
      if (
        event.threadId === threadId &&
        (event.scope === "placed" || !event.scope || event.scope.startsWith("source-"))
      )
        refresh()
    })
    refresh()
    return () => {
      live = false
      stop()
    }
  }, [threadId, binding, enabled, current])
  return enabled && current() && binding && state?.binding === binding ? state.rows : EMPTY
}
