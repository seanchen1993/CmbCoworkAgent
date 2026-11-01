import assert from "node:assert/strict"

/** Diagnostic host only. It never changes a guest's budget or calls back into its VM. */
export function installGuestDisposeDiagnostic(
  prototype: object,
  emit: (record: Record<string, unknown>) => void
): { restore(): boolean; readonly failures: readonly string[] } {
  const original = Object.getOwnPropertyDescriptor(prototype, "dispose")
  assert(
    original && "value" in original && typeof original.value === "function",
    "DIAGNOSTIC_OWN_DISPOSE_DATA_METHOD_REQUIRED"
  )
  const originalMethod = original.value
  const failures: string[] = []
  const fail = (code: string) => {
    if (failures.length < 16) failures.push(code)
  }
  const same = (value: PropertyDescriptor | undefined) =>
    value !== undefined &&
    ["value", "writable", "get", "set", "enumerable", "configurable"].every(
      (key) => value[key as keyof PropertyDescriptor] === original[key as keyof PropertyDescriptor]
    )
  const restore = (): boolean => {
    try {
      const current = Object.getOwnPropertyDescriptor(prototype, "dispose")
      if (same(current)) return true
      if (current?.value !== wrappedDispose) {
        fail("restore-owner-conflict")
        return false
      }
      Object.defineProperty(prototype, "dispose", original)
      const restored = same(Object.getOwnPropertyDescriptor(prototype, "dispose"))
      if (!restored) fail("restore-identity-mismatch")
      return restored
    } catch {
      fail("restore-failed")
      return false
    }
  }
  const data = (receiver: unknown, key: string): unknown => {
    try {
      if (!receiver || (typeof receiver !== "object" && typeof receiver !== "function"))
        return "unknown"
      const descriptor = Object.getOwnPropertyDescriptor(receiver, key)
      return descriptor && "value" in descriptor ? descriptor.value : "unknown"
    } catch {
      fail(`field-unavailable:${key}`)
      return "unknown"
    }
  }
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : "unknown"
  function wrappedDispose(this: unknown, ...args: unknown[]): unknown {
    // Read plain host data before restoring. Never inspect frames, arguments, heap handles or VM state.
    try {
      const cpuMs = number(data(this, "cpuMs"))
      const cpuWindow = number(data(this, "cpuWindow"))
      const disposed = data(this, "disposed")
      const now = performance.now()
      const restored = restore()
      try {
        emit({
          diagnosticOnly: true,
          pid: process.pid,
          at: Date.now(),
          code:
            args[0] === undefined
              ? "MODS_UNLOADED"
              : typeof args[0] === "string"
                ? args[0]
                : "unknown",
          guestFailure:
            args[1] === undefined ? false : typeof args[1] === "boolean" ? args[1] : "unknown",
          cpuMs,
          cpuWindow,
          windowAgeMs: typeof cpuWindow === "number" ? now - cpuWindow : "unknown",
          alreadyDisposed: typeof disposed === "boolean" ? disposed : "unknown",
          originalMethodRestoredBeforeCall: restored,
          diagnosticFailures: [...failures],
          stack: new Error("Guest dispose diagnostic").stack
        })
      } catch {
        fail("emit-failed")
      }
    } catch {
      fail("observation-failed")
      restore()
    }
    // Original return and thrown object take precedence over every diagnostic failure.
    return Reflect.apply(originalMethod, this, args)
  }
  Object.defineProperty(prototype, "dispose", { ...original, value: wrappedDispose })
  return { restore, failures }
}
