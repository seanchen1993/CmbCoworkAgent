import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ElectronApplication } from "playwright"

/** Test-only observation. Delegates exact native arguments and returns the original Promise. */
export async function startWorkspaceAccessDiagnostic(
  app: ElectronApplication,
  artifacts: string,
  workspace: string
): Promise<() => Promise<void>> {
  if (process.env.CMB_FULL_APP_WORKSPACE_DIAGNOSTIC !== "1") return async () => {}
  const key = `full-app-workspace-diagnostic:${randomUUID()}`
  await app.evaluate(
    (_electron, input) => {
      // esbuild may reference this helper when serializing function declarations.
      Reflect.set(globalThis, "__name", (value: unknown) => value)
      const fs = process.getBuiltinModule("node:fs/promises")
      const perf = process.getBuiltinModule("node:perf_hooks")
      const identity = (value: string) => {
        const path = value.replaceAll("\\", "/")
        return process.platform === "win32" ? path.toLowerCase() : path
      }
      const wanted = identity(input.workspace)
      const events: unknown[] = []
      const pending = new Set<number>()
      let dropped = 0
      let sequence = 0
      const record = (event: Record<string, unknown>) => {
        if (events.length === 2048) {
          events.shift()
          dropped++
        }
        events.push({ at: Date.now(), monotonicMs: perf.performance.now(), ...event })
      }
      const originals = { realpath: fs.realpath, stat: fs.stat }
      const wrappers = new Map<string, unknown>()
      for (const operation of ["realpath", "stat"] as const) {
        const original = originals[operation]
        const wrapper = function (this: unknown, ...args: unknown[]) {
          if (typeof args[0] !== "string" || identity(args[0]) !== wanted)
            return Reflect.apply(original, this, args)
          const id = ++sequence
          pending.add(id)
          record({ phase: "start", operation, id, path: "exact-complete-root" })
          let result: Promise<unknown>
          try {
            result = Reflect.apply(original, this, args)
          } catch (error) {
            pending.delete(id)
            record({
              phase: "sync-throw",
              operation,
              id,
              code: error instanceof Error ? Reflect.get(error, "code") : undefined
            })
            throw error
          }
          void result
            .then(
              () => {
                pending.delete(id)
                record({ phase: "resolved", operation, id })
              },
              (error) => {
                pending.delete(id)
                record({
                  phase: "rejected",
                  operation,
                  id,
                  code: error instanceof Error ? Reflect.get(error, "code") : undefined
                })
              }
            )
            .catch(() => {})
          return result
        }
        wrappers.set(operation, wrapper)
        Reflect.set(fs, operation, wrapper)
      }
      const histogram = perf.monitorEventLoopDelay({ resolution: 20 })
      histogram.enable()
      let previous = perf.performance.now()
      const timer = setInterval(() => {
        const now = perf.performance.now()
        record({
          phase: "event-loop-window",
          elapsedMs: now - previous,
          maxDelayMs: histogram.max / 1e6,
          pending: [...pending]
        })
        previous = now
        histogram.reset()
      }, 250)
      timer.unref()
      record({
        phase: "installed",
        uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? "default",
        node: process.versions.node
      })
      Reflect.set(globalThis, Symbol.for(input.key), () => {
        clearInterval(timer)
        histogram.disable()
      const restored: Array<{ operation: string; exact: boolean }> = []
        for (const operation of ["realpath", "stat"] as const) {
          const exact = fs[operation] === wrappers.get(operation)
          if (exact) Reflect.set(fs, operation, originals[operation])
          restored.push({ operation, exact })
        }
        record({ phase: "stopped", pending: [...pending] })
        return { diagnosticOnly: true, naturalAcceptance: false, events, dropped, restored }
      })
    },
    { key, workspace }
  )
  return async () => {
    let result: unknown
    try {
      result = await app.evaluate((_electron, symbolKey) => {
        const stop = Reflect.get(globalThis, Symbol.for(symbolKey))
        if (typeof stop !== "function") throw new Error("Workspace diagnostic handle missing")
        try {
          return stop()
        } finally {
          Reflect.deleteProperty(globalThis, Symbol.for(symbolKey))
        }
      }, key)
    } catch (error) {
      result = { diagnosticOnly: true, naturalAcceptance: false, collectionFailed: String(error) }
    }
    await writeFile(
      join(artifacts, "workspace-access-diagnostic.json"),
      JSON.stringify(result, null, 2)
    )
  }
}
