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

/** One selected Bot directory, driven by the existing host revision, never transcript polling. */
export function useBotWorks(
  client: BotClient,
  botId: string | undefined,
  selectedId: string | null,
  revision: number,
  audience = "desktop"
) {
  const [items, setItems] = useState<BotWorkSummary[]>([])
  const [priority, setPriority] = useState<BotWorkSummary[]>([])
  const displayed = useRef<BotWorkSummary[]>([])
  displayed.current = items
  const [selected, setSelected] = useState<BotWorkItem | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const scope = JSON.stringify([client.hostId, botId, audience, query])
  const [loadedScope, setLoadedScope] = useState("")
  const pending = useRef<Promise<void> | null>(null),
    dirty = useRef(false),
    mounted = useRef(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0),
    loadedPages = useRef(1),
    loadingMore = useRef<number | null>(null),
    current = useRef({ botId, selectedId })
  current.current = { botId, selectedId }
  const load = useCallback(async () => {
    const token = ++generation.current
    if (!botId || !client.works) {
      setItems([])
      setSelected(null)
      setCursor(null)
      return
    }
    setLoading(true)
    try {
      const [page, detail] = await Promise.all([
        client.works.list(botId, undefined, query),
        selectedId
          ? client.works.get(botId, selectedId).then(
              work => ({ work, error: null }),
              cause => {
                if (!isMissingSelectedWork(cause)) throw cause
                return { work: null, error: botErrorMessage(cause) }
              }
            )
          : { work: null, error: null }
      ])
      let nextCursor = page.nextCursor
      let refreshedItems = page.items
      if (query) {
        // Renames can move work into or out of a search. Reuse its query and
        // cursors for the loaded pages so both membership and order stay current.
        const matches = new Map(page.items.map(item => [item.id, item]))
        for (let index = 1; index < loadedPages.current && nextCursor; index++) {
          if (generation.current !== token) return
          const nextPage = await client.works.list(botId, nextCursor, query)
          for (const item of nextPage.items) {
            if (!matches.has(item.id)) matches.set(item.id, item)
          }
          nextCursor = nextPage.nextCursor
        }
        refreshedItems = [...matches.values()]
      } else if (loadedPages.current > 1) {
        const refreshed = new Map<string, BotWorkSummary>()
        const pageIds = new Set(page.items.map(item => item.id))
        const extra = displayed.current.filter(item => !pageIds.has(item.id)).map(item => item.id)
        for (let offset = 0; offset < extra.length; offset += 40) {
          if (generation.current !== token) return
          const batch = await client.works.summaries(botId, extra.slice(offset, offset + 40), true)
          for (const work of batch) {
            // A detached work can still hold a claim for unfinished deletion.
            if (!work.deletionCommitted && (work.conversation?.state !== "detached" || work.deletionPending))
              refreshed.set(work.id, work)
          }
        }
        refreshedItems = [...page.items, ...extra.flatMap(id => refreshed.get(id) ?? [])]
      }
      if (generation.current !== token) return
      setLoadedScope(scope)
      setPriority(page.priority)
      setItems(refreshedItems)
      if (query || loadedPages.current === 1) setCursor(nextCursor)
      setSelected(detail.work)
      setError(detail.error)
    } catch (cause) {
      if (generation.current === token) {
        setSelected(null)
        setError(botErrorMessage(cause))
      }
    } finally {
      if (generation.current === token) setLoading(false)
    }
  }, [client, botId, selectedId, query, scope])
  const latestLoad = useRef(load)
  latestLoad.current = load
  const refresh = useCallback(() => {
    dirty.current = true
    if (pending.current) return pending.current
    pending.current = Promise.resolve()
      .then(async () => {
        while (dirty.current && mounted.current) {
          dirty.current = false
          await latestLoad.current()
        }
      })
      .finally(() => {
        pending.current = null
      })
    return pending.current
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      dirty.current = false
      generation.current++
    }
  }, [])
  useEffect(() => {
    loadedPages.current = 1
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
  }, [load, refresh, revision])
  const more = async () => {
    const token = generation.current
    if (!botId || !cursor || !client.works || loadedScope !== scope || loading || pending.current ||
        loadingMore.current === token) return
    loadingMore.current = token
    setLoading(true)
    try {
      const page = await client.works.list(botId, cursor, query)
      if (token !== generation.current) return
      loadedPages.current++
      setItems((old) => [
        ...old,
        ...page.items.filter((item) => !old.some((v) => v.id === item.id))
      ])
      setCursor(page.nextCursor)
      setError(null)
    } catch (cause) {
      if (token === generation.current) setError(botErrorMessage(cause))
    } finally {
      if (loadingMore.current === token) loadingMore.current = null
      if (token === generation.current) setLoading(false)
    }
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
