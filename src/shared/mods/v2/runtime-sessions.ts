export interface FunctionRuntimeSession {
  workspace: string
  threadId: string
  /** Native chat title for choosing the intended session; never used as control authority. */
  title?: string
  generation: number
  autoReclaimable?: boolean
  guestEntered?: boolean
  /** Drawing owners only; zero does not imply the guest VM can be discarded. */
  mountedSites?: number
  /** Read-only native counters for this resident combination, never inferred from author status. */
  diagnostics?: import("../development").DevelopmentRuntimeDiagnostics & {
    backgroundResources: number
  }
  /** Added by the trusted IPC boundary; no authority is inferred from renderer values. */
  incarnationKey?: string
  state: "loading" | "resident" | "discovery" | "releasing" | "stopped" | "failed"
  blocker?: string
  canRelease: boolean
  canResume: boolean
  error?: string
}

export interface FunctionRuntimeSessions {
  limit: number
  resident: number
  retiring: number
  reserved: number
  error?: string
  stoppedTotal: number
  omitted: number
  sessions: FunctionRuntimeSession[]
}

/** Native UI control only; never exposed as a guest SDK capability. */
export interface FunctionRuntimeSessionsApi {
  runtimeSessions(currentThreadId?: string): Promise<FunctionRuntimeSessions>
  releaseRuntimeSession(session: FunctionRuntimeSession): Promise<FunctionRuntimeSessions>
  resumeRuntimeSession(session: FunctionRuntimeSession): Promise<FunctionRuntimeSessions>
}
