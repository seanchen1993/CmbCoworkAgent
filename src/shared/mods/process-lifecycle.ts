/** Host observations only. No command, stdin, environment values or guest-supplied detail. */
export const PROCESS_LIFECYCLE_PHASES = [
  "preparing",
  "prepared",
  "authorizing",
  "policy-queued",
  "policy-entered",
  "policy-allowed",
  "approval-waiting",
  "approval-allowed",
  "approval-rejected",
  "authorized",
  "spawn-dispatched",
  "started",
  "closed",
  "publishing",
  "published",
  "not-started"
] as const

export type ProcessLifecyclePhase = (typeof PROCESS_LIFECYCLE_PHASES)[number]
export interface ProcessLifecycleEvent {
  phase: ProcessLifecyclePhase
  at: number
  requestDigest?: string
}
export interface ProcessLifecycle {
  version: 1
  events: ProcessLifecycleEvent[]
}
