import type { AuthoringDocument, AuthoringScope } from "./authoring"

export type DevelopmentWaitingReason =
  | "turn-finishing"
  | "turn-interrupted"
  | "conversation-busy"
  | "waiting-for-idle"

export type DevelopmentValidation = "session-local" | "authorized-real"
export type DevelopmentMode = "normal" | "creator"
export interface DevelopmentCompositionStatus {
  phase: "queued" | "applying" | "active" | "failed" | "cancelled"
  name: string
  pluginNames: string[]
  error?: string
  canUndo?: boolean
  canCancel?: boolean
  savedName?: string
}

export interface DevelopmentReuseStatus {
  phase: "preparing" | "needs-approval" | "applying" | "active" | "failed" | "unknown"
  planId?: string
  name: string
  draftId: string
  revision: number
  sourceDigest: string
  compiledDigest?: string
  targetProfileDigest?: string
  capabilities: string[]
  installationId?: string
  savedProfileId?: string
  error?: string
}

/** Current native observations only; missing counts are unknown, never an inferred zero. */
export interface DevelopmentRuntimeDiagnostics {
  providers?: number
  subscriptions?: number
  inFlight?: number
  unknownRequests?: number
  completedRequests?: number
  failedRequests?: number
  cancelledRequests?: number
  backgroundResources?: number
  pages?: number
  generation?: number
}

export interface DevelopmentTrialStatus {
  componentId: string
  draftId: string
  revision: number
  bundleDigest: string
  compiledDigest: string
  phase:
    | "needs-approval"
    | "queued"
    | "preflight"
    | "retiring"
    | "active"
    | "stopped"
    | "failed"
    | "unknown"
  activeRevision?: number
  activeDigest?: string
  waitingReason?: DevelopmentWaitingReason
  error?: string
  capabilities: string[]
  validation?: DevelopmentValidation
  purpose?: string
  addedCapabilities?: string[]
  diagnostics?: DevelopmentRuntimeDiagnostics
  canUndo?: boolean
}

export interface DevelopmentStatus {
  workspace: string
  threadId: string
  enabled: boolean
  /** Optional only for compatibility with older hosts. Normal keeps approved Mods running. */
  mode?: DevelopmentMode
  /** Observations linked to the original chat run; never restores approval or execution. */
  request?: { runId: string; startedAt: number; operations: number; candidates: number; groupId?: string } |
    { error: "DEVELOPMENT_BUDGET_UNCONFIRMED" }
  composition?: DevelopmentCompositionStatus
  reuse?: DevelopmentReuseStatus
  undo?: { phase: "queued" | "applying" | "active" | "failed"; error?: string }
  drafts: Array<{ id: string; name: string; revision: number; digest: string }>
  trials: DevelopmentTrialStatus[]
}

/** Renderer controls are deliberately separate from the model's draft/trial request tool. */
export interface DevelopmentApi {
  status(input: { threadId: string }): Promise<DevelopmentStatus>
  setEnabled(input: AuthoringScope & { enabled: boolean }): Promise<DevelopmentStatus>
  setMode(input: AuthoringScope & { mode: DevelopmentMode }): Promise<DevelopmentStatus>
  approve(
    input: AuthoringScope & {
      id: string
      revision: number
      digest: string
      sourceDigest?: string
    }
  ): Promise<DevelopmentStatus>
  stop(input: AuthoringScope & { id: string }): Promise<DevelopmentStatus>
  promote(input: AuthoringScope & { id: string; revision: number }): Promise<AuthoringDocument>
  requestReuse(input: AuthoringScope & { id: string; revision: number }): Promise<DevelopmentStatus>
  approveReuse(input: AuthoringScope & {
    planId: string
    sourceDigest: string
    compiledDigest: string
    targetProfileDigest: string
  }): Promise<DevelopmentStatus>
  undoComposition(input: AuthoringScope): Promise<DevelopmentStatus>
  cancelComposition(input: AuthoringScope): Promise<DevelopmentStatus>
  undoTrial(input: AuthoringScope): Promise<DevelopmentStatus>
  onChanged(callback: (event: { threadId: string }) => void): () => void
}
