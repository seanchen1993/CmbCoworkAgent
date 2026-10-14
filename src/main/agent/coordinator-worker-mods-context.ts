/** Read-only attribution for an actual coordinator worker run, never execution permission. */
export interface CoordinatorWorkerModsContext {
  readonly workerThreadId: string
  readonly parentThreadId: string
  readonly workspace: string
  readonly signal: AbortSignal
  assertCurrent(): void
}

// The producer owns the private ALS and mints entries only inside its original launch path.
export { readCoordinatorWorkerModsContext } from "./coordinator-worker-manager"
