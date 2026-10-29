import { Worker } from "node:worker_threads"
import type { AuthoringPreviewAnalysis } from "./authoring-preflight"
import {
  AuthoringCompileError,
  readAuthoringCompileDiagnostics
} from "./authoring-compile-diagnostics"
import { AuthoringStructureError, authoringStructureCode } from "./authoring-structure-diagnostics"

/** Analysis has no authority to run guest code. Cancellation waits for actual Worker exit. */
export class AuthoringPreflightClient {
  private worker?: Worker
  private stopping?: Promise<void>
  private closed = false
  constructor(private readonly entry: string) {}

  async stop(): Promise<void> {
    this.closed = true
    if (!this.stopping) {
      const worker = this.worker
      this.stopping = worker ? worker.terminate().then(() => {}) : Promise.resolve()
    }
    await this.stopping
  }

  run(directory: string, signal: AbortSignal): Promise<AuthoringPreviewAnalysis> {
    if (this.closed || this.worker) return Promise.reject(Error("AUTHORING_PREFLIGHT_CLOSED"))
    signal.throwIfAborted()
    const worker = new Worker(this.entry, {
      workerData: { directory },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
      // The analyzer needs no credentials. Libraries resolve beside the fixed application entry.
      env: Object.fromEntries(
        ["SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"].flatMap((key) =>
          process.env[key] ? [[key, process.env[key]!]] : []
        )
      )
    })
    this.worker = worker
    worker.stdout?.resume()
    worker.stderr?.resume()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (value?: AuthoringPreviewAnalysis, error?: Error) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", abort)
        void this.stop().then(() => {
          if (signal.aborted) reject(Error("AUTHORING_PREVIEW_CANCELLED"))
          else if (error) reject(error)
          else resolve(value!)
        }, reject)
      }
      const abort = () => finish(undefined, Error("AUTHORING_PREVIEW_CANCELLED"))
      signal.addEventListener("abort", abort, { once: true })
      worker.once("error", () => finish(undefined, Error("AUTHORING_PREFLIGHT_FAILED")))
      worker.once("exit", () => finish(undefined, Error("AUTHORING_PREFLIGHT_EXITED")))
      worker.once("message", (message: unknown) => {
        try {
          const row = message as {
            ok?: boolean
            text?: string
            diagnostics?: unknown
            structureCode?: unknown
          }
          const structureCode = authoringStructureCode(row?.structureCode)
          if (row?.ok === false && structureCode) {
            finish(undefined, new AuthoringStructureError(structureCode))
            return
          }
          const diagnostics = readAuthoringCompileDiagnostics(row?.diagnostics)
          if (row?.ok === false && diagnostics.length > 0) {
            finish(undefined, new AuthoringCompileError(diagnostics))
            return
          }
          if (!row?.ok || typeof row.text !== "string" || row.text.length > 2 * 1024 * 1024)
            throw Error("AUTHORING_PREFLIGHT_FAILED")
          finish(JSON.parse(row.text) as AuthoringPreviewAnalysis)
        } catch {
          finish(undefined, Error("AUTHORING_PREFLIGHT_FAILED"))
        }
      })
      if (signal.aborted) abort()
    })
  }
}
