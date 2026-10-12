import { botApi } from "@/lib/bot-api"
import { useCallback, useEffect, useRef, useState } from "react"
import type { BotSearchKind, BotSearchMatch } from "../../../shared/bot-search"
import type { BotPaletteTab } from "./bot-command-palette"

const contentKinds = ["message", "file", "link", "routine"] as const
interface SearchState {
  key: string
  matches: BotSearchMatch[]
  cursors: Partial<Record<BotSearchKind, string | null>>
  busy: boolean
  scanned: number
  error: string | null
  paused: boolean
}
const empty = (key: string): SearchState => ({
  key,
  matches: [],
  cursors: {},
  busy: false,
  scanned: 0,
  error: null,
  paused: false
})

/** Bounded rounds over the existing paged search; obsolete responses never publish. */
export function useBotPaletteSearch(query: string, tab: BotPaletteTab, enabled: boolean) {
  const key = JSON.stringify([query.trim(), tab, enabled])
  const [state, setState] = useState(() => empty(key))
  const generation = useRef({ value: 0 })
  const run = useCallback(
    async (initial: SearchState, token: number) => {
      const kinds: BotSearchKind[] =
        tab === "all" ? [...contentKinds] : contentKinds.filter((kind) => kind === tab)
      let next = { ...initial, busy: true, paused: false, error: null as string | null }
      setState(next)
      try {
        // At most eight bounded pages per source per request. Sparse histories
        // expose Continue instead of scanning an entire database on every key.
        for (let round = 0; round < 8; round++) {
          if (token !== generation.current.value) return
          const pending = kinds.filter((kind) => next.cursors[kind] !== null)
          if (!pending.length) break
          const pages = await Promise.all(
            pending.map(async (kind) => ({
              kind,
              page: await botApi.search({
                query: query.trim(),
                kind,
                ...(next.cursors[kind] ? { cursor: next.cursors[kind]! } : {})
              })
            }))
          )
          if (token !== generation.current.value) return
          const matches = new Map(next.matches.map((match) => [`${match.kind}:${match.id}`, match]))
          const cursors = { ...next.cursors }
          let scanned = next.scanned
          for (const { kind, page } of pages) {
            for (const match of page.matches) matches.set(`${match.kind}:${match.id}`, match)
            cursors[kind] = page.cursor
            scanned += page.scanned
          }
          next = { ...next, cursors, scanned, matches: [...matches.values()] }
          setState(next)
          if (next.matches.length >= initial.matches.length + 50) break
        }
      } catch (error) {
        next = { ...next, error: error instanceof Error ? error.message : "内容搜索失败" }
      } finally {
        if (token === generation.current.value) setState({ ...next, busy: false })
      }
    },
    [query, tab]
  )
  useEffect(() => {
    const fence = generation.current
    const token = ++fence.value
    const initial = empty(key)
    setState(initial)
    if (!enabled || !query.trim() || tab === "action" || tab === "bot" || tab === "group") return
    const timer = setTimeout(() => void run(initial, token), 220)
    return () => {
      clearTimeout(timer)
      fence.value++
    }
  }, [key, query, tab, enabled, run])
  const visible = state.key === key ? state : empty(key)
  return {
    ...visible,
    more: visible.paused || Object.values(visible.cursors).some((cursor) => cursor !== null),
    retry: () => {
      if (!visible.busy) void run(visible, ++generation.current.value)
    },
    pause: () => {
      generation.current.value++
      setState((current) => ({ ...current, busy: false, paused: true }))
    }
  }
}
