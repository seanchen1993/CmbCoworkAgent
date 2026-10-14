import type { EvaluationResult, EvaluationStartInput, EvaluationView } from "./evaluation-api"

export interface SkillEvaluationView {
  id: string
  digest: string
  skillId: string
  name: string
  maxExecutions: number
  candidateId: string
  baselineDigest: string
  candidateDigest: string
  baselineText: string | null
  candidateText: string
  sourceTraceIds: string[]
  state:
    | "prepared"
    | "evaluating"
    | "adopting"
    | "adopted"
    | "rolling-back"
    | "rolled-back"
    | "unknown"
    | "discarded"
  evaluation?: EvaluationView
  recoveryDirectory?: string
}
export interface SkillEvaluationApi {
  list(threadId: string): Promise<
    EvaluationResult<{
      workspace: string
      candidates: { candidateId: string; name: string; skillId: string }[]
      records: SkillEvaluationView[]
      capacity?: {
        limit: number
        entries: {
          id: string
          digest: string
          name: string
          workspace: string
          threadId: string
          canDiscard: boolean
          canForgetHistory?: boolean
          recoveryDirectory?: string
        }[]
      }
    }>
  >
  prepare(input: {
    threadId: string
    expectedWorkspace: string
    candidateId: string
    fixture: EvaluationStartInput["baseline"]
    agentStepId: string
  }): Promise<EvaluationResult<SkillEvaluationView>>
  start(input: {
    threadId: string
    expectedWorkspace: string
    id: string
    expectedDigest: string
    tasks: EvaluationStartInput["tasks"]
    budget: EvaluationStartInput["budget"]
  }): Promise<EvaluationResult<SkillEvaluationView>>
  change(input: {
    threadId: string
    expectedWorkspace: string
    id: string
    expectedDigest: string
    action: "adopt" | "rollback" | "cancel" | "discard" | "forget-history"
    acknowledgeRecoveryLoss?: true
  }): Promise<EvaluationResult<SkillEvaluationView>>
}
