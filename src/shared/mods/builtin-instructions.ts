/** Host observations, never an authorization or a second instruction-loading path. */
export interface BuiltinInstructionEntry {
  path: string
  layer: "user" | "project" | "local" | "plugin"
  scope: string
  workspace: string
  delivery: "injected" | "truncated" | "omitted" | "unknown"
  reason: string
}

export interface BuiltinInstructionsSnapshot {
  schemaVersion: 1
  threadId: string
  runId: string
  workspace: string
  capturedAt: number
  origin: "host" | "plugin" | "disabled"
  status: "observed" | "unknown"
  /** Assembly does not prove a model call occurred or later prompt hooks preserved it. */
  observation: "host-context-assembly"
  entries: BuiltinInstructionEntry[]
  limitations: string[]
  finalRequests?: BuiltinInstructionsFinalObservation[]
  agentId?: string
  childSource?: "independent-runtime" | "task-model-boundary"
  children?: BuiltinInstructionsSnapshot[]
}

export interface BuiltinInstructionsFinalObservation {
  requestId: string
  observedAt: number
  result: "confirmed" | "modified" | "unknown"
  reason: string
}

export interface BuiltinInstructionsReadResult {
  status: "observed" | "unknown"
  snapshot?: BuiltinInstructionsSnapshot
  message: string
}
