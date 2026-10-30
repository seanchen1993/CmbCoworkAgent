/** Optional host receipts for the existing LocalSandbox process owner. No executor lives here. */
export interface BackgroundCommandStart {
  id: string
  threadId: string
  command: string
  cwd: string
  startedAt: number
  /** False for a service whose readiness is checked while it is still running. */
  notifyOnComplete?: boolean
}

export interface BackgroundCommandResult {
  id: string
  threadId: string
  output: string
  exitCode: number | null
  truncated: boolean
  cancelled: boolean
}

export interface BackgroundCommandLifecycle {
  /** The host resumes the original task instead of creating an independent completion turn. */
  retainSource?: boolean
  /** Opt in to tracked services whose exit does not create a completion turn. */
  allowSilentServices?: boolean
  /** Synchronous durable acceptance, before executeRaw can start. Throw to refuse execution. */
  accepted(command: BackgroundCommandStart): void
  /** Called only after execution AND process-tree termination settle. Must persist before notifying. */
  settled(result: BackgroundCommandResult): void
}
