/** Production host. Forced GC is available only in explicitly selected diagnostic runs. */
import "../../src/main/mods/v2/host-entry"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { FunctionGuestRuntime } from "../../src/main/mods/v2/guest-runtime"
import { installGuestDisposeDiagnostic } from "./mods-guest-dispose-diagnostic"

declare const __MODS_GUEST_DISPOSE_DIAGNOSTIC__: boolean
if (typeof __MODS_GUEST_DISPOSE_DIAGNOSTIC__ !== "undefined" && __MODS_GUEST_DISPOSE_DIAGNOSTIC__) {
  const path = join(tmpdir(), `guest-dispose-${process.pid}.jsonl`)
  const original = Object.getOwnPropertyDescriptor(FunctionGuestRuntime.prototype, "dispose")
  const diagnostic = installGuestDisposeDiagnostic(FunctionGuestRuntime.prototype, (record) => {
    appendFileSync(path, JSON.stringify(record) + "\n")
  })
  const installed = Object.getOwnPropertyDescriptor(FunctionGuestRuntime.prototype, "dispose")
  if (!installed || typeof installed.value !== "function" || installed.value === original?.value)
    throw Error("DIAGNOSTIC_HOST_INSTALL_FAILED")
  appendFileSync(
    path,
    JSON.stringify({
      diagnosticOnly: true,
      pid: process.pid,
      at: Date.now(),
      kind: "diagnostic-host-installed",
      methodInstalled: true
    }) + "\n"
  )
  process.once("exit", () => {
    const restored = diagnostic.restore()
    try {
      appendFileSync(
        path,
        JSON.stringify({
          diagnosticOnly: true,
          pid: process.pid,
          kind: "diagnostic-host-exit",
          restored,
          failures: diagnostic.failures
        }) + "\n"
      )
    } catch {
      // A diagnostic write must never prevent this owned utility process from exiting.
    }
  })
}

if (process.env.CMB_MODS_PERFORMANCE_GC === "diagnostic") {
  setFlagsFromString("--expose_gc")
  const collect = runInNewContext("gc") as () => void
  setInterval(() => {
    collect()
    appendFileSync(
      join(tmpdir(), "worker-gc.jsonl"),
      JSON.stringify({ at: Date.now(), pid: process.pid, memory: process.memoryUsage() }) + "\n"
    )
  }, 30000).unref()
}
