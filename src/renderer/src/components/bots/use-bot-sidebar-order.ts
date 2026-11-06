import { useState } from "react"
import { retainSidebarOrder } from "@/lib/bot-sidebar-view"

/** Reading clears the dot immediately, but the selected row keeps its sorting tier until leaving. */
export function useHeldSidebarUnread(key: string | null, unread: boolean) {
  const [held, setHeld] = useState({ key, unread })
  const retainUnread = unread || (held.key === key && held.unread)
  if (held.key !== key || held.unread !== retainUnread) setHeld({ key, unread: retainUnread })
  return retainUnread ? key : null
}

export function useStableSidebarOrder<T>(
  items: readonly T[],
  key: (item: T) => string,
  paused: boolean,
  scope: string
) {
  const [previous, setPrevious] = useState(() => ({ scope, keys: items.map(key) }))
  const result =
    paused && previous.scope === scope ? retainSidebarOrder(items, previous.keys, key) : [...items]
  const keys = result.map(key)
  if (
    previous.scope !== scope ||
    previous.keys.length !== keys.length ||
    keys.some((id, index) => id !== previous.keys[index])
  )
    setPrevious({ scope, keys })
  return result
}
