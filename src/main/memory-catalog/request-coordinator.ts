import type { WebContents } from "electron"

export class MemoryCatalogRequestAbortedError extends Error {
  readonly code = "MEMORY_CATALOG_REQUEST_ABORTED"

  constructor() {
    super("Memory catalog request was superseded or cancelled")
    this.name = "MemoryCatalogRequestAbortedError"
  }
}

interface ActiveRequest {
  controller: AbortController
}

export class MemoryCatalogRequestCoordinator {
  private readonly requestsByWebContents = new Map<number, Map<string, ActiveRequest>>()
  private readonly hookedWebContents = new WeakSet<WebContents>()

  private requestsFor(webContentsId: number): Map<string, ActiveRequest> {
    const existing = this.requestsByWebContents.get(webContentsId)
    if (existing) return existing
    const created = new Map<string, ActiveRequest>()
    this.requestsByWebContents.set(webContentsId, created)
    return created
  }

  private ensureDestroyedCleanup(webContents: WebContents): void {
    if (this.hookedWebContents.has(webContents)) return
    this.hookedWebContents.add(webContents)
    const webContentsId = webContents.id
    webContents.once("destroyed", () => this.cancel(webContentsId))
  }

  async run<T>(
    webContents: WebContents,
    scope: string,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    this.ensureDestroyedCleanup(webContents)
    const requests = this.requestsFor(webContents.id)
    requests.get(scope)?.controller.abort()
    const active: ActiveRequest = { controller: new AbortController() }
    requests.set(scope, active)
    try {
      const value = await operation(active.controller.signal)
      if (active.controller.signal.aborted) throw new MemoryCatalogRequestAbortedError()
      return value
    } finally {
      if (!active.controller.signal.aborted) active.controller.abort()
      if (requests.get(scope) === active) requests.delete(scope)
      if (requests.size === 0 && this.requestsByWebContents.get(webContents.id) === requests) {
        this.requestsByWebContents.delete(webContents.id)
      }
    }
  }

  cancel(webContentsId: number, scopePrefix?: string): number {
    const requests = this.requestsByWebContents.get(webContentsId)
    if (!requests) return 0
    let count = 0
    for (const [scope, active] of requests) {
      if (scopePrefix && scope !== scopePrefix && !scope.startsWith(`${scopePrefix}:`)) continue
      if (!active.controller.signal.aborted) {
        active.controller.abort()
        count += 1
      }
      requests.delete(scope)
    }
    if (requests.size === 0) this.requestsByWebContents.delete(webContentsId)
    return count
  }

  activeCount(webContentsId?: number): number {
    if (webContentsId !== undefined) {
      return this.requestsByWebContents.get(webContentsId)?.size ?? 0
    }
    let count = 0
    for (const requests of this.requestsByWebContents.values()) count += requests.size
    return count
  }
}

export const memoryCatalogRequestCoordinator = new MemoryCatalogRequestCoordinator()
