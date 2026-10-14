import type { ModJson } from "../../../shared/mods/types"
import type { FunctionStreamOptions } from "./stream-dispatcher"
import { closeHostStreamActual } from "./host-stream-lifetime"

/** Publication is separate from the transport's original owner checks. */
export function protectFunctionStreamCore(
  core: FunctionStreamOptions["core"],
  publish: (value: ModJson, signal: AbortSignal) => Promise<ModJson>,
  assertLive: () => void
): FunctionStreamOptions["core"] {
  return async function* (input, context) {
    const guard = () => {
      context.signal.throwIfAborted()
      assertLive()
    }
    guard()
    const output = core(input, context)
    try {
      while (true) {
        guard()
        const item = await output.next()
        guard()
        const safe = await publish(item.value, context.signal)
        guard()
        if (item.done) return safe
        yield safe
      }
    } finally {
      await closeHostStreamActual(output)
    }
  }
}
