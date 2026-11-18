import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useBotWorks } from "@/components/bots/use-bot-works"
import { BotError, type BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem } from "../../../../shared/bots/work"

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as Array<() => void>
}))

vi.mock("react", () => {
  const unchanged = (previous: readonly unknown[], next: readonly unknown[]) =>
    previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]))
  return {
    useState(initial: unknown) {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = initial
      return [hooks.slots[index], (next: unknown) => {
        hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next
      }]
    },
    useRef(initial: unknown) {
      return (hooks.slots[hooks.cursor++] ??= { current: initial })
    },
    useCallback(callback: unknown, deps: readonly unknown[]) {
      const index = hooks.cursor++
      const previous = hooks.slots[index] as { deps: readonly unknown[]; callback: unknown } | undefined
      if (previous && unchanged(previous.deps, deps)) return previous.callback
      hooks.slots[index] = { deps, callback }
      return callback
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = hooks.cursor++
      const previous = hooks.slots[index] as { deps: readonly unknown[]; cleanup?: () => void } | undefined
      if (previous && unchanged(previous.deps, deps)) return
      hooks.effects.push(() => {
        previous?.cleanup?.()
        hooks.slots[index] = { deps, cleanup: effect() }
      })
    }
  }
})

beforeEach(() => {
  hooks.cursor = 0
  hooks.slots = []
  hooks.effects = []
})

function work(id: string): BotWorkItem {
  return {
    id, botId: "bot", threadId: `thread-${id}`, parentThreadId: "main", title: id,
    goal: "Original goal", audienceKey: "desktop", state: "active", threadInitialized: true,
    version: 1, createdAt: 0, updatedAt: 0, executionState: "completed", pendingPeers: 0, backgroundBusy: false
  }
}

const missingDetail = () => new Error(
  "Error invoking remote method 'bots:work:get': BotError: 工作不属于当前 Bot"
)

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  vi.stubGlobal("window", new EventTarget())
  const firstPage = Array.from({ length: 40 }, (_, index) => work(`first-${index}`))
  const later = ["unlinked", "deleted", "committed", "retry-cleanup", "surviving"].map(work)
  const rows = new Map([...firstPage, ...later].map(row => [row.id, row]))
  const list = vi.fn<NonNullable<BotClient["works"]>["list"]>(async (_botId, cursor) => ({
    priority: [],
    items: cursor ? later : firstPage.flatMap(row => rows.get(row.id) ?? []),
    nextCursor: cursor ? "older-page" : "second-page"
  }))
  const summaries = vi.fn<NonNullable<BotClient["works"]>["summaries"]>(async (_botId, ids, allowMissing) => {
    const found = ids.flatMap(id => rows.get(id) ?? [])
    if (found.length !== ids.length && !allowMissing)
      throw new BotError("NOT_FOUND", "工作摘要不属于当前 Bot")
    return found.reverse()
  })
  const get = vi.fn<NonNullable<BotClient["works"]>["get"]>(async (_botId, id) => {
    const row = rows.get(id)
    if (!row) throw missingDetail()
    return row
  })
  const client = { hostId: "local", subscribe: () => () => {}, works: { list, summaries, get } } as unknown as BotClient
  const render = (selectedId: string | null = null, revision = 0, audience = "desktop") => {
    hooks.cursor = 0
    const result = useBotWorks(client, "bot", selectedId, revision, audience)
    for (const effect of hooks.effects.splice(0)) effect()
    return result
  }
  const refresh = async (selectedId: string | null = null, revision = 0, audience = "desktop") => {
    await render(selectedId, revision, audience).refresh()
    return render(selectedId, revision, audience)
  }
  return { firstPage, later, rows, list, summaries, get, render, refresh }
}

it("refreshes loaded pages after unlink and original-thread deletion, retaining valid work and its order", async () => {
  const { firstPage, later, rows, summaries, render, refresh } = fixture()
  await (await refresh()).more()
  expect(render().items.slice(40)).toEqual(later)
  const [unlinked, deleted, committed, retryCleanup, surviving] = later
  const detached = (row: BotWorkItem): BotWorkItem => ({
    ...row,
    conversation: {
      ref: { kind: "local_thread", threadId: row.threadId, incarnation: { token: "original", legacyCreatedAt: 0 } },
      origin: "existing",
      state: "detached"
    }
  })
  rows.set(unlinked.id, detached(unlinked))
  rows.delete(deleted.id)
  rows.set(committed.id, { ...committed, deletionCommitted: true })
  const retry = { ...detached(retryCleanup), deletionPending: true as const }
  rows.set(retry.id, retry)
  const renamed = { ...surviving, title: "New title" }
  rows.set(surviving.id, renamed)

  const view = await refresh(surviving.id, 1)
  expect(summaries).toHaveBeenLastCalledWith("bot", later.map(row => row.id), true)
  expect(view.items).toEqual([...firstPage, retry, renamed])
  expect(view.selected).toEqual(renamed)
  expect(view.error).toBeNull()
  expect(view.cursor).toBe("older-page")
})

async function expandedSearch() {
  const f = fixture()
  const [oldMatch, olderDraft] = f.later
  const recent = f.firstPage.map(row => ({ ...row, title: `release ${row.title}` }))
  const older = { ...oldMatch, title: "release archive" }
  for (const row of [...recent, older]) f.rows.set(row.id, row)
  await f.refresh()
  f.list.mockImplementation(async (_botId, cursor, query = "") => {
    const matches = [...f.rows.values()].filter(row => row.title.includes(query))
    const offset = cursor === "search-page-2" ? 40 : 0
    return {
      priority: [],
      items: matches.slice(offset, offset + 40),
      nextCursor: matches.length > offset + 40 ? "search-page-2" : null
    }
  })
  f.render().setQuery("release")
  await (await f.refresh()).more()
  expect(f.render().items).toEqual([...recent, older])
  expect(f.render().cursor).toBeNull()
  f.list.mockClear()
  return { ...f, recent, older, olderDraft }
}

it("drops a renamed work from expanded search results when its title stops matching", async () => {
  const { rows, older, recent, list, summaries, refresh } = await expandedSearch()
  rows.set(older.id, { ...older, title: "Archived investigation" })

  const view = await refresh(null, 1)
  expect(view.items).toEqual(recent)
  expect(view.cursor).toBeNull()
  expect(list.mock.calls).toEqual([["bot", undefined, "release"]])
  expect(summaries).not.toHaveBeenCalled()
})

it("includes an older work renamed into the search after the last page was loaded", async () => {
  const { rows, older, olderDraft, recent, list, summaries, refresh } = await expandedSearch()
  const renamed = { ...olderDraft, title: "release retrospective" }
  rows.set(renamed.id, renamed)

  const view = await refresh(null, 1)
  expect(view.items).toEqual([...recent, older, renamed])
  expect(view.cursor).toBeNull()
  expect(list.mock.calls).toEqual([["bot", undefined, "release"], ["bot", "search-page-2", "release"]])
  expect(summaries).not.toHaveBeenCalled()
})

it("uses the new search cursor when changing audience during an expanded refresh", async () => {
  const { list, recent, render, refresh } = await expandedSearch()
  const newPage = { items: recent, priority: [], nextCursor: "new-audience-page-2" }
  let finishOldPage!: (page: typeof newPage) => void
  list.mockImplementationOnce(() => new Promise(resolve => { finishOldPage = resolve }))
  list.mockResolvedValueOnce(newPage)
  const old = render(null, 1).refresh()
  await Promise.resolve()
  const current = refresh(null, 2, "other-audience")
  finishOldPage({ ...newPage, nextCursor: "old-audience-page-2" })
  await old

  const view = await current
  expect(view.items).toEqual(recent)
  expect(view.cursor).toBe("new-audience-page-2")
  expect(list.mock.calls).toEqual([["bot", undefined, "release"], ["bot", undefined, "release"]])
})

it.each([
  ["typed", () => new BotError("NOT_FOUND", "工作不属于当前 Bot")],
  ["Electron", missingDetail]
] as const)("refreshes the directory when the selected detail is missing (%s)", async (_, missing) => {
  const { firstPage, rows, get, refresh } = fixture()
  const [original, valid] = firstPage
  expect((await refresh(original.id)).selected).toEqual(original)
  const renamed = { ...valid, title: "Updated after selection disappeared" }
  rows.delete(original.id)
  rows.set(valid.id, renamed)
  get.mockRejectedValueOnce(missing())
  const view = await refresh(original.id, 1)
  expect(view.items[0]).toEqual(renamed)
  expect(view.selected).toBeNull()
  expect(view.error).toBe("工作不属于当前 Bot")
  expect((await refresh(valid.id, 1)).selected).toEqual(renamed)
})

it.each(["detail", "summaries"] as const)("surfaces a storage error while reading %s", async source => {
  const { later, get, summaries, refresh } = fixture()
  await (await refresh()).more()
  const failure = new Error(`Error invoking remote method 'bots:work:${source === "detail" ? "get" : "summaries"}': Error: database is locked`)
  if (source === "detail") get.mockRejectedValueOnce(failure)
  else summaries.mockRejectedValueOnce(failure)
  const view = await refresh(later[0].id, 1)
  expect(view.error).toBe("database is locked")
  expect(view.selected).toBeNull()
})
