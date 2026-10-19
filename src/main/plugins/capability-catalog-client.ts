import type { Worker } from "node:worker_threads"
import { harnessWorkerOptions } from "../harness-board/worker-limits"
import type { readNativeCapabilityCatalog, NativeCapabilityCatalog } from "./capability-catalog"

type Reader = typeof readNativeCapabilityCatalog
type Factory = () => Promise<Worker>
async function createWorker(): Promise<Worker> {
  const module = await import("./capability-catalog-worker?nodeWorker")
  return module.default(harnessWorkerOptions("project-capability-catalog"))
}

/** One bounded reader per explicit directory transaction. No cache and no execution retry. */
export class CapabilityCatalogWorkers {
  private active = 0
  constructor(private readonly factory: Factory = createWorker) {}

  async read<T>(work: (reader: Reader) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (this.active >= 2) throw Error("COMPOSITION_CATALOG_BUSY")
    this.active++
    let worker: Worker | undefined
    let failPending: ((error: Error) => void) | undefined
    let failed: Error | undefined
    let sequence = 0
    const fail = () => {
      failed = Error("COMPOSITION_CATALOG_BUSY")
      failPending?.(failed)
    }
    const abort = () => {
      fail()
      void worker?.terminate()
    }
    try {
      worker = await this.factory().catch(() => {
        throw Error("COMPOSITION_CATALOG_BUSY")
      })
      worker.unref()
      worker.on("error", fail)
      worker.on("exit", fail)
      signal?.addEventListener("abort", abort, { once: true })
      signal?.throwIfAborted()
      const reader: Reader = async (plugin, context, requestSignal) => {
        signal?.throwIfAborted()
        requestSignal?.throwIfAborted()
        if (failed) throw failed
        if (failPending) throw Error("COMPOSITION_CATALOG_BUSY")
        const current = worker!
        const id = ++sequence
        return new Promise<NativeCapabilityCatalog>((resolve, reject) => {
          const requestAbort = () => abort()
          const cleanup = () => {
            clearTimeout(timer)
            current.off("message", message)
            requestSignal?.removeEventListener("abort", requestAbort)
            failPending = undefined
          }
          const message = (response: {
            id: number
            result?: NativeCapabilityCatalog
            error?: string
          }) => {
            if (response.id !== id) return
            if (response.error || !response.result) return fail()
            cleanup()
            resolve(response.result)
          }
          // Startup/transport watchdog; each package scan retains its original 3 second budget.
          const timer = setTimeout(abort, 10000)
          failPending = (error) => {
            cleanup()
            reject(error)
          }
          current.on("message", message)
          requestSignal?.addEventListener("abort", requestAbort, { once: true })
          try {
            // Only host registry identity crosses the boundary. No plugin code is evaluated.
            const { id: pluginId, name, version, path, enabled } = plugin
            current.postMessage({
              id,
              plugin: { id: pluginId, name, version, path, enabled },
              context
            })
          } catch {
            fail()
          }
        })
      }
      const result = await work(reader)
      if (failed) throw failed
      signal?.throwIfAborted()
      return result
    } finally {
      signal?.removeEventListener("abort", abort)
      try {
        await worker?.terminate()
      } finally {
        this.active--
      }
    }
  }
}

export const capabilityCatalogWorkers = new CapabilityCatalogWorkers()
