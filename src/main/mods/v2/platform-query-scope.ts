import { AsyncLocalStorage } from "node:async_hooks"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

interface QueryScope {
  signal: AbortSignal
  active: boolean
  parent?: QueryScope
}
const scopes = new AsyncLocalStorage<QueryScope>()
const methods = new Set([
  "platform.list",
  "platform.read",
  "platform.act",
  "platform.poll",
  "platform.unsubscribe",
  "fs.read",
  "fs.list",
  "fs.exists",
  "fs.stat",
  "state.get",
  "store.get",
  "store.keys",
  "session.id",
  "session.cwd",
  "session.root",
  "session.repo",
  "clock.now",
  "ui.open",
  "ui.invalidate",
  "ui.panes",
  "ui.focus",
  "ui.scroll",
  "ui.copy",
  "ui.resolve"
])

export function assertPlatformQueryMethod(method: string): void {
  const scope = scopes.getStore()
  if (!scope) return
  assertScope(scope)
  if (!methods.has(method)) throw new ModFunctionError("MODS_QUERY_EFFECT_DENIED")
}

export function platformQuerySignal(): AbortSignal | undefined {
  const scope = scopes.getStore()
  if (!scope) return undefined
  assertScope(scope)
  return scope.signal
}

function assertScope(scope: QueryScope): void {
  for (let current: QueryScope | undefined = scope; current; current = current.parent) {
    if (!current.active) throw new ModFunctionError("MODS_QUERY_EXPIRED")
    current.signal.throwIfAborted()
  }
}

/** Host entry only. Inherited async callbacks retain the restriction after this entry expires. */
export async function withPlatformQuery<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const parent = platformQuerySignal()
  const lifetime = new AbortController()
  const scope: QueryScope = {
    signal: AbortSignal.any([signal, lifetime.signal, ...(parent ? [parent] : [])]),
    active: true,
    parent: scopes.getStore()
  }
  try {
    return await scopes.run(scope, async () => {
      assertScope(scope)
      const result = await run()
      assertScope(scope)
      return result
    })
  } finally {
    scope.active = false
    lifetime.abort(new ModFunctionError("MODS_QUERY_EXPIRED"))
  }
}
