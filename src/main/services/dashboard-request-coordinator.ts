import { AsyncLocalStorage } from "node:async_hooks"
import type { WebContents } from "electron"

export class DashboardRequestCancelledError extends Error {
  readonly code = "DASHBOARD_REQUEST_CANCELLED"

  constructor() {
    super("Dashboard request was superseded or cancelled")
    this.name = "DashboardRequestCancelledError"
  }
}

interface DashboardRequestContext {
  signal: AbortSignal
}

interface ActiveRequest {
  controller: AbortController
}

export const dashboardRequestContext = new AsyncLocalStorage<DashboardRequestContext>()

export function getDashboardRequestSignal(): AbortSignal | undefined {
  return dashboardRequestContext.getStore()?.signal
}

export function isDashboardRequestCancelled(error: unknown): boolean {
  return (
    error instanceof DashboardRequestCancelledError ||
    (error instanceof Error &&
      (error.name === "DashboardRequestCancelledError" ||
        error.name === "DASHBOARD_ES_REQUEST_CANCELLED" ||
        ("code" in error &&
          (error.code === "DASHBOARD_REQUEST_CANCELLED" ||
            error.code === "DASHBOARD_ES_REQUEST_CANCELLED"))))
  )
}

export class DashboardRequestCoordinator {
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
    webContents.once("destroyed", () => {
      this.cancel(webContentsId)
    })
  }

  async run<T>(webContents: WebContents, family: string, operation: () => Promise<T>): Promise<T> {
    this.ensureDestroyedCleanup(webContents)
    const requests = this.requestsFor(webContents.id)
    requests.get(family)?.controller.abort()
    const active: ActiveRequest = { controller: new AbortController() }
    requests.set(family, active)

    try {
      const value = await dashboardRequestContext.run(
        { signal: active.controller.signal },
        operation
      )
      if (active.controller.signal.aborted) throw new DashboardRequestCancelledError()
      return value
    } finally {
      if (!active.controller.signal.aborted) active.controller.abort()
      if (requests.get(family) === active) requests.delete(family)
      if (requests.size === 0 && this.requestsByWebContents.get(webContents.id) === requests) {
        this.requestsByWebContents.delete(webContents.id)
      }
    }
  }

  cancel(webContentsId: number, families?: readonly string[]): number {
    const requests = this.requestsByWebContents.get(webContentsId)
    if (!requests) return 0
    const selected = families ? new Set(families) : null
    let cancelled = 0
    for (const [family, active] of requests) {
      if (
        selected &&
        !Array.from(selected).some((root) => family === root || family.startsWith(`${root}:`))
      ) {
        continue
      }
      if (!active.controller.signal.aborted) {
        active.controller.abort()
        cancelled += 1
      }
      requests.delete(family)
    }
    if (requests.size === 0) this.requestsByWebContents.delete(webContentsId)
    return cancelled
  }
}
