import type { HarnessEvaluationCase, HarnessEvaluationComparison } from "./evaluation"

export interface EvaluationTask {
  id: string
  goal: string
}
export interface EvaluationStartInput {
  threadId: string
  expectedWorkspace: string
  baseline: { id: string; revision: number; digest: string }
  candidate: { id: string; revision: number; digest: string }
  tasks: EvaluationTask[]
  /** Explicit upper bounds across both variants; not a monetary spending limit. */
  budget: { timeoutMs: number; maxExecutions: number }
}
export interface EvaluationView {
  id: string
  workspace: string
  threadId: string
  createdAt: number
  state: "running" | "complete" | "cancelled" | "interrupted"
  provider: "real" | "controlled"
  tasks: EvaluationTask[]
  baseline: { name: string; digest: string; cases: HarnessEvaluationCase[] }
  candidate: { name: string; digest: string; cases: HarnessEvaluationCase[] }
  budget: EvaluationStartInput["budget"]
  /** Present only when the host proves this exact report is safely disposable. */
  discardDigest?: string
  activeRunId?: string
  comparison: HarnessEvaluationComparison
  /** Fixed public reasons; no provider exceptions, credentials or command output. */
  reasons: string[]
}
export type EvaluationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "INVALID" | "BUSY" | "STALE" | "LIMIT" | "CANCELLED" | "FAILED" }
export interface EvaluationApi {
  list(
    threadId: string
  ): Promise<EvaluationResult<{ workspace: string; evaluations: EvaluationView[] }>>
  discard(input: {
    threadId: string
    expectedWorkspace: string
    evaluationId: string
    expectedDigest: string
  }): Promise<EvaluationResult<void>>
  start(input: EvaluationStartInput): Promise<EvaluationResult<EvaluationView>>
  cancel(input: {
    threadId: string
    expectedWorkspace: string
    evaluationId: string
  }): Promise<EvaluationResult<void>>
}
