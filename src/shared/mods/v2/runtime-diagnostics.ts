/** Main-produced observations, never source, execution or release authority. */
export const RUNTIME_LIFECYCLE_PHASES = Object.freeze([
  "child-start",
  "dispatched",
  "host-queued",
  "host-enter",
  "host-settled",
  "draining",
  "child-error",
  "child-exit"
] as const)
export const RUNTIME_LIFECYCLE_CODES = Object.freeze([
  "MODS_HOST_STOPPED",
  "MODS_HOST_EXITED",
  "MODS_HOST_ERROR",
  "MODS_HOST_UNRESPONSIVE",
  "MODS_HOST_TIMEOUT",
  "MODS_HOST_MEMORY",
  "MODS_UI_RESOLVE_TRANSPORT_ERROR",
  "ENOENT",
  "EACCES",
  "ERR_UTILITY_PROCESS_CRASHED",
  "OTHER"
] as const)
export type RuntimeLifecyclePhase = (typeof RUNTIME_LIFECYCLE_PHASES)[number]
export interface RuntimeLifecycleDiagnostic {
  readonly at: number
  readonly generation: number
  readonly pid?: number
  readonly phase: RuntimeLifecyclePhase
  readonly code?: (typeof RUNTIME_LIFECYCLE_CODES)[number]
  readonly exitCode?: number
  /** Logical requests; stop rejects them before physical child exit. */
  readonly pending: number
  /** Entered native host work, counted through the real host finally. */
  readonly hostCalls: number
  /** Entered host work belonging to a sealed physical lifetime. */
  readonly draining: number
}
