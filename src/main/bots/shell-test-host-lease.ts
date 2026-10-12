import { BotHostLock } from "./host-lock"

interface Scope {
  lock: BotHostLock
  references: number
  prepared?: Promise<void>
  retained: boolean
}
const scopes = new Map<string, Scope>()
/** Multiple Runtime fixtures in one process share the same actual Host lifetime
 * lock, as production tasks do. This coordinates test ownership only; it cannot
 * supply a native capability, bypass an approval or prove process closure. */
export function acquireShellTestHostLease(directory: string) {
  let scope = scopes.get(directory)
  if (!scope) {
    const lock = BotHostLock.acquire(directory)
    if (!lock) throw new Error("Actual Windows Shell fixture lock unavailable")
    scope = { lock, references: 0, retained: false }
    scopes.set(directory, scope)
  }
  const current = scope
  current.references++
  let released = false
  return {
    lock: current.lock,
    async prepare(operation: () => Promise<void>) {
      if (current.retained || released)
        throw new Error("Unproven Windows fixture resources retained")
      current.prepared ??= Promise.resolve().then(operation)
      await current.prepared
    },
    async assertCurrent(signal: AbortSignal) {
      signal.throwIfAborted()
      if (current.retained || released)
        throw new Error("Windows fixture admission is no longer current")
      await current.lock.checkCurrent()
    },
    retain() {
      current.retained = true
    },
    release() {
      if (released) return
      released = true
      if (--current.references === 0) {
        scopes.delete(directory)
        current.lock.release()
      }
    }
  }
}
