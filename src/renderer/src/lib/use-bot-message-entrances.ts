import { useCallback, useState } from "react"
import { projectBotMessageEntrance, retireBotMessageEntrance } from "./bot-message-entrance"

export function useBotMessageEntrances(
  scope: string | null,
  ids: readonly string[],
  live: boolean
) {
  const [state, setState] = useState(() => projectBotMessageEntrance(null, scope, ids, live))
  const next = projectBotMessageEntrance(state, scope, ids, live)
  // Like Grok's entry hook, update the snapshot before committing new rows.
  if (next !== state) setState(next)
  const retire = useCallback(
    (id: string) => setState((value) => retireBotMessageEntrance(value, id)),
    []
  )
  return { entering: next.entering, retire }
}
