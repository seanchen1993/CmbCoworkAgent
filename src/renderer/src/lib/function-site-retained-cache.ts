import {
  modUiChangeAffects,
  type ModConfigurationChangeEvent,
  type ModUiChangeScope
} from "../../../shared/mods/types"
import { FunctionSitePresentationCache } from "./function-site-presentation"

interface Sources {
  configuration(listener: (event?: ModConfigurationChangeEvent) => void): () => void
  cards(listener: (event: { threadId: string; scope?: ModUiChangeScope }) => void): () => void
  threads(listener: () => void): () => void
  account(listener: () => void): () => void
  localConfiguration(listener: () => void): () => void
}

interface Entry {
  threadId: string
  workspace: string
  cache: FunctionSitePresentationCache
  live: boolean
  users: number
  expires: number
}

export interface RetainedFunctionSiteCache {
  cache: FunctionSitePresentationCache
  current(): boolean
  release(): void
  revoke(): void
}

/** Passive drawings only. Every new view still needs a fresh host capability decision. */
export class RetainedFunctionSiteCaches {
  private entries = new Map<string, Entry>()
  private stops: Array<() => void> = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private sequence = 0

  constructor(
    private readonly sources: Sources,
    private readonly maximum = 8,
    private readonly idleMilliseconds = 120000
  ) {}

  acquire(threadId: string, workspace: string): RetainedFunctionSiteCache {
    this.expire()
    // A directory replacement cannot later restore a prior incarnation's drawings.
    for (const [otherKey, entry] of this.entries)
      if (entry.threadId === threadId && entry.workspace !== workspace) this.remove(otherKey)
    // Concurrent panes must not share revocation or retry lifetimes. Reuse only an idle drawing.
    const idle = [...this.entries]
      .reverse()
      .find(
        ([, value]) => !value.users && value.threadId === threadId && value.workspace === workspace
      )
    const key = idle?.[0] ?? String(++this.sequence)
    let entry = idle?.[1]
    if (!entry) {
      const created: Entry = {
        threadId,
        workspace,
        live: true,
        users: 0,
        expires: Infinity,
        cache: new FunctionSitePresentationCache(() => created.live)
      }
      entry = created
      this.entries.set(key, entry)
    }
    entry.users++
    entry.expires = Infinity
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (!this.stops.length) this.listen()
    this.schedule()
    const value = entry
    let released = false
    return {
      cache: value.cache,
      current: () => value.live,
      revoke: () => {
        if (this.entries.get(key) === value) this.remove(key)
      },
      release: () => {
        if (released) return
        released = true
        if (--value.users > 0 || !value.live) return
        value.cache.releaseView()
        value.expires = Date.now() + this.idleMilliseconds
        this.trim()
        this.schedule()
      }
    }
  }

  discardDormant(threadId: string): void {
    for (const [key, entry] of this.entries)
      if (entry.threadId === threadId && !entry.users) this.remove(key)
  }

  private listen(): void {
    const revokeAll = () => {
      for (const key of [...this.entries.keys()]) this.remove(key)
    }
    this.stops = [
      this.sources.configuration((event) => {
        if (event?.scope !== "schema") revokeAll()
      }),
      this.sources.localConfiguration(revokeAll),
      this.sources.account(revokeAll),
      this.sources.threads(() => {
        // Mounted views already reconcile thread metadata; dormant drawings have no such owner.
        for (const [key, entry] of this.entries) if (!entry.users) this.remove(key)
      }),
      this.sources.cards((event) => {
        for (const entry of this.entries.values()) {
          if (entry.threadId !== event.threadId) continue
          if (event.scope?.startsWith("site-projection:"))
            entry.cache.invalidateProjection(event.scope.slice("site-projection:".length))
          else if (event.scope?.startsWith("site-presentations:"))
            entry.cache.invalidate(event.scope.slice("site-presentations:".length))
          else if (modUiChangeAffects(event.scope)) entry.cache.invalidate()
        }
      })
    ]
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.live = false
    this.entries.delete(key)
    entry.cache.invalidate()
    if (!this.entries.size) {
      for (const stop of this.stops.splice(0)) stop()
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maximum) break
      if (!entry.users) this.remove(key)
    }
  }

  private expire(): void {
    for (const [key, entry] of this.entries)
      if (!entry.users && entry.expires <= Date.now()) this.remove(key)
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    let deadline = Infinity
    for (const entry of this.entries.values())
      if (!entry.users) deadline = Math.min(deadline, entry.expires)
    if (deadline === Infinity) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.expire()
        this.schedule()
      },
      Math.max(1, deadline - Date.now())
    )
  }
}

const registries = new WeakMap<object, RetainedFunctionSiteCaches>()

export function discardRetainedFunctionSiteCache(threadId: string): void {
  registries.get(window.api)?.discardDormant(threadId)
}

export function acquireRetainedFunctionSiteCache(
  threadId: string,
  workspace: string
): RetainedFunctionSiteCache | null {
  const api = window.api
  // Older bridges cannot observe all invalidations, so retain their original mount-only cache.
  if (!api.mods.onCardsChanged || !api.threads?.onThreadsChanged || !api.models?.onUserInfoChanged)
    return null
  let registry = registries.get(api)
  if (!registry) {
    registry = new RetainedFunctionSiteCaches({
      configuration: (listener) => api.mods.onConfigurationChanged(listener),
      cards: (listener) => api.mods.onCardsChanged(listener),
      threads: (listener) => api.threads.onThreadsChanged(listener),
      account: (listener) => api.models.onUserInfoChanged(listener),
      localConfiguration: (listener) => {
        window.addEventListener("mods:configuration-changed", listener)
        return () => window.removeEventListener("mods:configuration-changed", listener)
      }
    })
    registries.set(api, registry)
  }
  return registry.acquire(threadId, workspace)
}
