import { AsyncLocalStorage } from "node:async_hooks"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

type Permit = { plugin: string; check(): void; expires: number; live: boolean; used: boolean }
const permits = new AsyncLocalStorage<Permit>()

/** Main only: enter AFTER the actual drawing/control/nonce has passed native admission. */
export async function withUserViewAction<T>(
  plugin: string,
  check: () => void,
  run: () => Promise<T>
): Promise<T> {
  return captureUserViewAction(plugin, check)(run)
}

/** A genuine Client control may post its one message asynchronously; the deadline is not renewed. */
export function captureUserViewAction(plugin: string, check: () => void) {
  const permit: Permit = { plugin, check, expires: Date.now() + 15_000, live: false, used: false }
  let entered = false
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (entered)
      throw new ModFunctionError("MODS_UI_VIEW_REQUIRES_USER_ACTION")
    // Admission already accepted the native callback. Redraw/expiry only removes its
    // optional view capability; it must not cancel an otherwise lawful ordinary action.
    entered = true
    permit.live = true
    try {
      return await permits.run(permit, run)
    } finally {
      permit.live = false
    }
  }
}

/** Returns a recheck guard, never an authority object that can cross the guest boundary. */
export function consumeUserViewAction(plugin: string): () => void {
  const permit = permits.getStore()
  const check = () => {
    if (!permit || !permit.live || permit.plugin !== plugin || Date.now() > permit.expires)
      throw new ModFunctionError("MODS_UI_VIEW_REQUIRES_USER_ACTION")
    permit.check()
  }
  check()
  if (permit!.used) throw new ModFunctionError("MODS_UI_VIEW_INTENT_USED")
  permit!.used = true
  return check
}
