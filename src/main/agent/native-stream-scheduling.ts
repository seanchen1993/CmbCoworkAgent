import { performance } from "node:perf_hooks"
import { setTimeout } from "node:timers/promises"
import { measureHostRuntimeAsync } from "../services/host-runtime-timing"

/** Bound uninterrupted frame work, without imposing the OS timer quantum on every token. */
export function createNativeStreamScheduler(): (force?: boolean) => Promise<void> | undefined {
  let resumedAt = -Infinity
  return (force = false) => {
    if (!force && performance.now() - resumedAt < 8) return undefined
    return measureHostRuntimeAsync("streamSchedule", async () => {
      await setTimeout(0)
      resumedAt = performance.now()
    })
  }
}
