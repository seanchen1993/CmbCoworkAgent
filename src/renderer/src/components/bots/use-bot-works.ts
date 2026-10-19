import { useCallback, useEffect, useRef, useState } from "react"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem, BotWorkSummary } from "../../../../shared/bots/work"
import { botErrorMessage } from "@/lib/bot-error-message"

/** One selected Bot directory, driven by the existing host revision, never transcript polling. */
export function useBotWorks(
  client: BotClient,
  botId: string | undefined,
  selectedId: string | null,
  revision: number
) {
  const [items, setItems] = useState<BotWorkSummary[]>([])
  const [priority, setPriority] = useState<BotWorkSummary[]>([])
  const displayed = useRef<BotWorkSummary[]>([])
  displayed.current = items
  const [selected, setSelected] = useState<BotWorkItem | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const scope = JSON.stringify([client.hostId, botId, query])
  const [loadedScope, setLoadedScope] = useState("")
  const pending = useRef<Promise<void> | null>(null),
    dirty = useRef(false),
    mounted = useRef(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0),
    expanded = useRef(false),
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
        selectedId ? client.works.get(botId, selectedId) : Promise.resolve(null)
      ])
      const refreshed: BotWorkSummary[] = []
      const extra = expanded.current
        ? displayed.current
            .filter((item) => !page.items.some((v) => v.id === item.id))
            .map((item) => item.id)
        : []
      for (let offset = 0; offset < extra.length; offset += 40) {
        if (generation.current !== token) return
        refreshed.push(...(await client.works.summaries(botId, extra.slice(offset, offset + 40))))
      }
      if (generation.current !== token) return
      setLoadedScope(scope)
      setPriority(page.priority)
      setItems((old) =>
        expanded.current
          ? [
              ...page.items,
              ...old
                .filter((item) => !page.items.some((v) => v.id === item.id))
                .map((item) => refreshed.find((v) => v.id === item.id) ?? item)
            ]
          : page.items
      )
      if (!expanded.current) setCursor(page.nextCursor)
      setSelected(detail)
      setError(null)
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
    expanded.current = false
    setItems([])
    setPriority([])
    setCursor(null)
    setSelected(null)
    return () => {
      generation.current++
    }
  }, [client, botId, query])
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
    if (!botId || !cursor || !client.works || loading || pending.current) return
    const token = generation.current
    setLoading(true)
    try {
      const page = await client.works.list(botId, cursor, query)
      if (token !== generation.current) return
      expanded.current = true
      setItems((old) => [
        ...old,
        ...page.items.filter((item) => !old.some((v) => v.id === item.id))
      ])
      setCursor(page.nextCursor)
      setError(null)
    } catch (cause) {
      if (token === generation.current) setError(botErrorMessage(cause))
    } finally {
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
