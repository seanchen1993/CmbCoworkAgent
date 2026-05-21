export type GoalStatus = "active" | "paused" | "complete"

export type GoalJudgeVerdict = "complete" | "continue" | "blocked"

export const RUNTIME_RESTORED_ACTIVE_GOAL_REASON = "runtime restored active goal"

export interface GoalLedger {
  progress: string[]
  evidence: string[]
  blockers: string[]
}

export interface GoalExplicitSkillContext {
  name: string
  path: string
}

export interface GoalContext {
  explicitSkill?: GoalExplicitSkillContext
  transportSummary?: string
  legacyTransportSummaryMigration?: {
    objective?: string
    completionCondition?: string
  }
}

export interface ThreadGoal {
  threadId: string
  goalId: string
  activeWindowId: string
  objective: string
  completionCondition: string
  context: GoalContext
  status: GoalStatus
  turnsUsed: number
  maxTurns: number
  lastVerdict: string | null
  lastReason: string | null
  pausedReason: string | null
  consecutiveParseFailures: number
  ledger: GoalLedger
  createdAt: number
  updatedAt: number
}

export interface GoalJudgeDecision {
  verdict: GoalJudgeVerdict
  reason: string
  blockerType?: "needs_user_input" | "other"
  nextPrompt?: string
  ledgerPatch?: Partial<GoalLedger>
  parseFailed?: boolean
}

export interface GoalTurnOutcome {
  goal: ThreadGoal
  shouldContinue: boolean
  continuationPrompt?: string
  notice: string
}

export interface GoalStore {
  get(threadId: string): ThreadGoal | null
  upsert(goal: ThreadGoal): ThreadGoal
  delete(threadId: string): void
}

export const EMPTY_GOAL_LEDGER: GoalLedger = {
  progress: [],
  evidence: [],
  blockers: []
}
