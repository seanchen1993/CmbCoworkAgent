/** Instrumented-only diagnostics. Wrappers may alter guarded fast-path selection and timings. */
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ElectronApplication } from "playwright"
import { withModsMainCpuProfile } from "./mods-main-cpu-profile-diagnostic"

export async function withProjectMainIoDiagnostic<T>(
  app: ElectronApplication,
  artifacts: string,
  body: () => Promise<T>
): Promise<T> {
  if (process.env.CMB_PROJECT_E2E_IO_DIAGNOSTIC !== "1")
    return withModsMainCpuProfile(app, artifacts, body)
  const key = `project-main-io:${randomUUID()}`
  await app.evaluate((_electron, key) => {
    const fs = process.getBuiltinModule("node:fs")
    const asynchronous = process.getBuiltinModule("node:fs/promises")
    const counts = new Map<string, { calls: number; totalMs: number; maxMs: number }>()
    const restore: Array<() => void> = []
    const category = (path: unknown) => {
      if (typeof path !== "string") return "non-path"
      const value = path.replaceAll("\\", "/")
      if (value.includes("/legacy-packages/") || value.includes("/local-projects/packages/")) return "retained-source"
      if (value.includes("/knowledge/")) return "chosen-knowledge"
      if (value.includes("/plugin-data/")) return "mutable-plugin-data"
      if (value.includes("/project-compositions/")) return "composition-data"
      return "other"
    }
    const record = (name: string, kind: string, started: number) => {
      const id = `${name}:${kind}`, elapsed = performance.now() - started
      const row = counts.get(id) ?? { calls: 0, totalMs: 0, maxMs: 0 }
      row.calls++
      row.totalMs += elapsed
      row.maxMs = Math.max(row.maxMs, elapsed)
      counts.set(id, row)
    }
    const patch = (owner: object, name: string, asynchronous: boolean) => {
      const original = Reflect.get(owner, name)
      if (typeof original !== "function") return
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (!descriptor?.writable) return
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const started = performance.now(), kind = category(args[0])
        if (asynchronous) {
          let result: unknown
          try { result = Reflect.apply(original, this, args) }
          catch (error) { record(name, kind, started); throw error }
          return Promise.resolve(result).finally(() => record(name, kind, started))
        }
        try { return Reflect.apply(original, this, args) }
        finally { record(name, kind, started) }
      }
      // Preserve native/custom-promisify entry points used by original filesystem callers.
      for (const key of Reflect.ownKeys(original)) {
        if (typeof key === "string" && ["name", "length", "arguments", "caller", "prototype"].includes(key)) continue
        const value = Object.getOwnPropertyDescriptor(original, key)
        if (value) Object.defineProperty(wrapped, key, value)
      }
      Object.defineProperty(owner, name, { ...descriptor, value: wrapped })
      restore.push(() => Object.defineProperty(owner, name, descriptor))
    }
    // Do not patch identity-protected statSync/realpathSync. Their calls remain unobserved.
    for (const name of ["readFileSync", "openSync", "fsyncSync", "lstatSync", "readdirSync"])
      patch(fs, name, false)
    for (const name of ["readFile", "open", "lstat", "stat", "readdir", "realpath"])
      patch(asynchronous, name, true)
    Reflect.set(globalThis, Symbol.for(key), { counts, restore, started: performance.now() })
  }, key)
  try {
    return await withModsMainCpuProfile(app, artifacts, body)
  } finally {
    try {
      const result = await app.evaluate((_electron, key) => {
        const state = Reflect.get(globalThis, Symbol.for(key)) as {
          counts: Map<string, { calls: number; totalMs: number; maxMs: number }>
          restore: Array<() => void>; started: number
        }
        try {
          return { elapsedMs: performance.now() - state.started,
            counters: Object.fromEntries(state.counts),
            scope: "Instrumented-only main JS filesystem diagnostics; wrapping APIs may change guarded fast-path selection or timings. Unsuitable for native timing comparison. Identity-protected statSync/realpathSync are unobserved; async timings include waits, native/SQLite calls need the separate CPU profile." }
        } finally {
          for (const restore of state.restore.reverse()) restore()
          Reflect.deleteProperty(globalThis, Symbol.for(key))
        }
      }, key)
      await writeFile(join(artifacts, "main-io-diagnostic.json"), JSON.stringify(result, null, 2))
    } catch {
      // Diagnostic failures do not replace the original business outcome.
      console.warn("Main IO diagnostic unavailable; retain the original business result")
    }
  }
}
