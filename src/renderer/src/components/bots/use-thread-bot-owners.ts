import { useEffect, useMemo, useState } from "react"
import type { BotThreadOwner } from "../../../../shared/bots/conversation"

/** Only the rendered sidebar rows, one bounded metadata request at a time. */
export function useThreadBotOwners(threadIds: readonly string[]) {
  const key = JSON.stringify([...new Set(threadIds)].sort())
  const [loaded, setLoaded] = useState<{ key: string; owners: BotThreadOwner[] }>({
    key: "",
    owners: []
  })
  useEffect(() => {
    const client = window.api.bots,
      read = client.conversations?.owners
    const ids = JSON.parse(key) as string[]
    if (!read || !ids.length) return
    let alive = true,
      pending = false,
      dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      if (!alive || pending) return
      dirty = false
      pending = true
      try {
        const owners: BotThreadOwner[] = []
        for (let offset = 0; alive && offset < ids.length; offset += 64)
          owners.push(...(await read(ids.slice(offset, offset + 64))))
        if (alive)
          setLoaded((old) =>
            old.key === key && JSON.stringify(old.owners) === JSON.stringify(owners)
              ? old
              : { key, owners }
          )
      } catch {
        // A stale badge must not claim ownership after a failed lookup.
        if (alive)
          setLoaded((old) => (old.key === key && !old.owners.length ? old : { key, owners: [] }))
      } finally {
        pending = false
        if (alive && dirty) schedule()
      }
    }
    const schedule = () => {
      dirty = true
      if (!alive || pending || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void load()
      }, 150)
    }
    const unsubscribe = client.subscribe((event) => {
      if (!event.memoryBotId && !event.reactionTarget) schedule()
    })
    void load()
    return () => {
      alive = false
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [key])
  return useMemo(
    () => new Map(loaded.key === key ? loaded.owners.map((owner) => [owner.threadId, owner]) : []),
    [key, loaded]
  )
}
