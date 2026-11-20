import type { ResourceLimits, WorkerOptions } from "node:worker_threads"

/**
 * Harness workers parse plugin-controlled JSON and filesystem projections. Keep one shared
 * heap boundary so adding a new worker cannot silently reintroduce an unbounded renderer task.
 */
export const HARNESS_WORKER_RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  maxOldGenerationSizeMb: 192,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4
})

export function harnessWorkerOptions(name: string): WorkerOptions {
  return { name, resourceLimits: HARNESS_WORKER_RESOURCE_LIMITS }
}
