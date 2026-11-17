import { useCallback, useEffect, useRef, useState } from "react"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem, BotWorkSummary } from "../../../../shared/bots/work"
import { botErrorMessage } from "@/lib/bot-error-message"

/** Scoped invalidation; one request chain per mounted directory, never transcript polling. */
export function useBotWorks(
  client: BotClient,
  botId: string | undefined,
  selectedId: string | null,
  revision: number,
  audience = "desktop"
) {
  const [items, setItems] = useState<BotWorkSummary[]>([])
  const [priority, setPriority] = useState<BotWorkSummary[]>([])
  const displayed = useRef(items)
  displayed.current = items
  const [selected, setSelected] = useState<BotWorkItem | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const scope = JSON.stringify([client.hostId, botId, audience, query])
  const [loadedScope, setLoadedScope] = useState("")
  const pending = useRef<Promise<void> | null>(null),
    dirty = useRef(false),
    mounted = useRef(true)
  // null means explicit full refresh. Scoped events only read the changed loaded IDs.
  const changedIds = useRef<Set<string> | null>(null),
    removed = useRef(new Set<string>())
  const scopedEvents = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0),
    expanded = useRef(false)
  const current = useRef({ botId, selectedId, audience })
  current.current = { botId, selectedId, audience }
  const load = useCallback(
    async (changed: Set<string> | null) => {
      const token = ++generation.current
      if (!botId || !client.works) {
        setItems([])
        setSelected(null)
        setCursor(null)
        return
      }
      setLoading(true)
      try {
        const readDetail =
          !!selectedId && !removed.current.has(selectedId) && (!changed || changed.has(selectedId))
        const [page, detail] = await Promise.all([
          client.works.list(botId, undefined, query),
          readDetail ? client.works.get(botId, selectedId!) : Promise.resolve(undefined)
        ])
        const pageIds = new Set(page.items.map((item) => item.id))
        const candidates =
          changed ?? new Set(expanded.current ? displayed.current.map((item) => item.id) : [])
        const extra = [...candidates].filter((id) => !pageIds.has(id) && !removed.current.has(id))
        const refreshed = new Map<string, BotWorkSummary>()
        for (let offset = 0; offset < extra.length; offset += 40) {
          if (generation.current !== token) return
          for (const item of await client.works.summaries(botId, extra.slice(offset, offset + 40)))
            refreshed.set(item.id, item)
        }
        if (generation.current !== token) return
        setLoadedScope(scope)
        setPriority(page.priority.filter((item) => !removed.current.has(item.id)))
        const needle = query.trim().toLowerCase()
        setItems((old) => {
          const merged = new Map(page.items.map((item) => [item.id, item]))
          if (expanded.current)
            for (const item of old) if (!merged.has(item.id)) merged.set(item.id, item)
          // Also include newly created rows outside the first page of a burst. Their
          // IDs come from the bounded scope event, never from an all-history scan.
          for (const [id, item] of refreshed) merged.set(id, item)
          return [...merged.values()].filter(
            (item) =>
              !removed.current.has(item.id) &&
              item.conversation?.state !== "detached" &&
              (!needle || item.title.toLowerCase().includes(needle))
          )
        })
        if (!expanded.current) setCursor(page.nextCursor)
        if (detail !== undefined) setSelected(detail)
        if (!selectedId || removed.current.has(selectedId)) setSelected(null)
        setError(null)
      } catch (cause) {
        if (generation.current === token) {
          setSelected(null)
          setError(botErrorMessage(cause))
        }
      } finally {
        if (generation.current === token) setLoading(false)
      }
    },
    [client, botId, selectedId, query, scope]
  )
  const latestLoad = useRef(load)
  latestLoad.current = load
  const drain = useCallback(() => {
    dirty.current = true
    if (pending.current) return pending.current
    pending.current = Promise.resolve()
      .then(async () => {
        while (dirty.current && mounted.current) {
          dirty.current = false
          const ids = changedIds.current
          changedIds.current = new Set()
          await latestLoad.current(ids)
        }
      })
      .finally(() => {
        pending.current = null
      })
    return pending.current
  }, [])
  const refresh = useCallback(() => {
    changedIds.current = null
    return drain()
  }, [drain])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      dirty.current = false
      generation.current++
    }
  }, [])
  useEffect(() => {
    scopedEvents.current = false
    return client.subscribe((event) => {
      if (!event.workChanges) return
      scopedEvents.current = true
    })
  }, [client])
  useEffect(() => {
    expanded.current = false
    removed.current.clear()
    setItems([])
    setPriority([])
    setCursor(null)
    setSelected(null)
    return () => {
      generation.current++
    }
  }, [client, botId, audience, query])
  useEffect(() => {
    setSelected(null)
  }, [botId, selectedId])
  useEffect(() => {
    void refresh()
    return () => {
      generation.current++
    }
  }, [load, refresh])
  useEffect(() => {
    if (!scopedEvents.current) void refresh()
  }, [revision, refresh])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = client.subscribe((event) => {
      if (!event.workChanges) return // Legacy hosts still use the snapshot revision above.
      const changes = event.workChanges.filter(
        (change) =>
          change.botId === botId &&
          change.audience === (audience === "desktop" ? audience : `im:${audience}`)
      )
      if (!changes.length) return
      for (const change of changes) {
        if (change.reset) {
          // Restart cursor paging explicitly when a large transaction changes the directory.
          expanded.current = false
          changedIds.current = null
          removed.current.clear()
        } else {
          for (const id of change.workIds) {
            changedIds.current?.add(id)
            removed.current.delete(id)
          }
          for (const id of change.removedIds) removed.current.add(id)
        }
      }
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          void drain()
        }, 100)
    })
    const focus = () => {
      void refresh()
    }
    window.addEventListener("focus", focus)
    return () => {
      stop()
      clearTimeout(timer)
      window.removeEventListener("focus", focus)
    }
  }, [client, botId, audience, drain, refresh])
  const more = async () => {
    if (!botId || !cursor || !client.works || loading || pending.current) return
    const token = generation.current
    setLoading(true)
    pending.current = (async () => {
      try {
        const page = await client.works!.list(botId, cursor, query)
        if (token !== generation.current) return
        expanded.current = true
        setItems((old) => {
          const ids = new Set(old.map((item) => item.id))
          return [
            ...old,
            ...page.items.filter((item) => !ids.has(item.id) && !removed.current.has(item.id))
          ]
        })
        setCursor(page.nextCursor)
        setError(null)
      } catch (cause) {
        if (token === generation.current) setError(botErrorMessage(cause))
      } finally {
        if (token === generation.current) setLoading(false)
        pending.current = null
        if (dirty.current && mounted.current) void drain()
      }
    })()
    return pending.current
  }
  return {
    priority: loadedScope === scope ? priority : [],
    items:
      loadedScope === scope
        ? items.map((item) => (selected?.id === item.id ? selected : item))
        : [],
    selected: selected?.botId === botId && selected?.id === selectedId ? selected : null,
    cursor: loadedScope === scope ? cursor : null,
    query,
    setQuery,
    error,
    loading,
    refresh,
    more,
    current
  }
}
