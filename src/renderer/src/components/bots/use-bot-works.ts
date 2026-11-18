import { useCallback, useEffect, useRef, useState } from "react"
import { BotError, type BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem, BotWorkSummary } from "../../../../shared/bots/work"
import { botErrorMessage } from "@/lib/bot-error-message"

function isMissingSelectedWork(cause: unknown): boolean {
  if (cause instanceof BotError) return cause.code === "NOT_FOUND"
  // Electron preserves the message but drops the BotError code.
  return cause instanceof Error &&
    cause.message === "Error invoking remote method 'bots:work:get': BotError: 工作不属于当前 Bot"
}

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
    loadedPages = useRef(1)
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
          readDetail ? client.works.get(botId, selectedId!).then(
            work => ({ work, error: null }),
            cause => {
              if (!isMissingSelectedWork(cause)) throw cause
              return { work: null, error: botErrorMessage(cause) }
            }
          ) : Promise.resolve(undefined)
        ])
        if (generation.current !== token) return
        const merged = new Map(page.items.map(item => [item.id, item]))
        let nextCursor = page.nextCursor
        if (query) {
          const seen = new Set<string>()
          for (let index = 1; index < loadedPages.current && nextCursor && !seen.has(nextCursor); index++) {
            seen.add(nextCursor)
            const next = await client.works.list(botId, nextCursor, query)
            if (generation.current !== token) return
            for (const item of next.items) merged.set(item.id, item)
            nextCursor = next.nextCursor
          }
        } else {
          const older = loadedPages.current > 1 ? displayed.current : []
          const candidates = changed ?? new Set(older.map(item => item.id))
          for (const item of older)
            if (!merged.has(item.id) && !candidates.has(item.id)) merged.set(item.id, item)
          const extra = [...candidates].filter(id => !merged.has(id) && !removed.current.has(id))
          for (let offset = 0; offset < extra.length; offset += 40) {
            const ids = extra.slice(offset, offset + 40)
            const batch = await client.works.summaries(botId, ids, true)
            if (generation.current !== token) return
            const found = new Map(batch.map(item => [item.id, item]))
            for (const id of ids) {
              const item = found.get(id)
              if (item) merged.set(id, item)
            }
          }
          if (older.length && changed) {
            // Updating the last loaded page must keep its cursor and relative order.
            const ordered = new Map(page.items.map(item => [item.id, item]))
            for (const id of [...older.map(item => item.id), ...merged.keys()]) {
              const item = merged.get(id)
              if (item) ordered.set(id, item)
            }
            merged.clear()
            for (const [id, item] of ordered) merged.set(id, item)
          }
        }
        const visible = (item: BotWorkSummary) => !removed.current.has(item.id) && !item.deletionCommitted &&
          (item.conversation?.state !== "detached" || item.deletionPending)
        setLoadedScope(scope)
        setPriority(page.priority.filter(visible))
        setItems([...merged.values()].filter(visible))
        if (query || loadedPages.current === 1) setCursor(nextCursor)
        if (detail) setSelected(detail.work)
        if (!selectedId || removed.current.has(selectedId)) setSelected(null)
        setError(detail?.error ?? null)
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
    loadedPages.current = 1
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
          loadedPages.current = 1
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
        loadedPages.current++
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
