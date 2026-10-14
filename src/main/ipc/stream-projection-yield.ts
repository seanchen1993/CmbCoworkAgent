import { setTimeout } from "node:timers/promises"

/** Yield before expensive snapshot projection, never between its seal and publication. */
export async function yieldBeforeStreamProjection(signal: AbortSignal): Promise<void> {
  await setTimeout(8, undefined, { signal })
}
