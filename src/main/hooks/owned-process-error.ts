import { types } from "node:util"

/** Main-process identity only; Hook stdout and arbitrary error codes cannot assert ownership. */
export class HookProcessCleanupError extends Error {
  constructor() {
    super("HOOK_PROCESS_CLEANUP_UNCONFIRMED")
    this.name = "HookProcessCleanupError"
  }
}
export function findHookProcessCleanupError(error: unknown): HookProcessCleanupError | undefined {
  const seen = new Set<object>()
  let current = error
  for (let depth = 0; depth < 8 && types.isNativeError(current) && !seen.has(current); depth++) {
    if (current instanceof HookProcessCleanupError) return current
    seen.add(current)
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value
  }
  return undefined
}
