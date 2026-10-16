import type { AuthoringDocument, AuthoringScope } from "./authoring"

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
  error?: string
  capabilities: string[]
}

export interface DevelopmentStatus {
  workspace: string
  threadId: string
  enabled: boolean
  /** Original request observations only; no approval or execution authority. */
  request?: {
    runId: string; startedAt: number; operations: number; candidates: number; groupId?: string
  } | { error: "DEVELOPMENT_BUDGET_UNCONFIRMED" }
  drafts: Array<{ id: string; name: string; revision: number; digest: string }>
  trials: DevelopmentTrialStatus[]
}

/** Renderer controls are deliberately separate from the model's draft/trial request tool. */
export interface DevelopmentApi {
  status(input: { threadId: string }): Promise<DevelopmentStatus>
  setEnabled(input: AuthoringScope & { enabled: boolean }): Promise<DevelopmentStatus>
  approve(
    input: AuthoringScope & { id: string; revision: number; digest: string }
  ): Promise<DevelopmentStatus>
  stop(input: AuthoringScope & { id: string }): Promise<DevelopmentStatus>
  promote(input: AuthoringScope & { id: string; revision: number }): Promise<AuthoringDocument>
  onChanged(callback: (event: { threadId: string }) => void): () => void
}
