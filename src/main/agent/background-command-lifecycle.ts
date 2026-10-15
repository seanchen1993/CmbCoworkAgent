/** Optional host receipts for the existing LocalSandbox process owner. No executor lives here. */
export interface BackgroundCommandStart {
  id: string
  threadId: string
  command: string
  cwd: string
  startedAt: number
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
  /** Synchronous durable acceptance, before executeRaw can start. Throw to refuse execution. */
  accepted(command: BackgroundCommandStart): void
  /** Called only after execution AND process-tree termination settle. Must persist before notifying. */
  settled(result: BackgroundCommandResult): void
}
