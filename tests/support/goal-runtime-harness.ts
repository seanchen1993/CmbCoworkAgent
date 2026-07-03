import { buildGoalJudgeUserPrompt, type GoalEvaluationInput } from "../../src/main/agent/goals/evaluator.ts"
import { GoalManager } from "../../src/main/agent/goals/goal-manager.ts"
import { InMemoryGoalStore } from "../../src/main/agent/goals/goal-store.ts"
import type { GoalContext, GoalJudgeDecision, GoalTurnOutcome, ThreadGoal } from "../../src/main/agent/goals/types.ts"

export interface FakeAgentTurn {
  assistantResponse: string
  toolCalls?: string[]
  toolEvidence?: string[]
  usedSkills?: string[]
}

export interface GoalHarnessTurnResult {
  beforeGoal: ThreadGoal
  evaluationInput: GoalEvaluationInput
  judgePrompt: string
  decision: GoalJudgeDecision
  outcome: GoalTurnOutcome | null
  afterGoal: ThreadGoal | null
}

export type FakeGoalEvaluator = (
  input: GoalEvaluationInput,
  judgePrompt: string,
  turnIndex: number
) => GoalJudgeDecision

export class GoalRuntimeHarness {
  readonly store: InMemoryGoalStore
  readonly manager: GoalManager

  constructor(options: { maxTurns?: number } = {}) {
    this.store = new InMemoryGoalStore()
    this.manager = new GoalManager(this.store, options.maxTurns)
  }

  start(
    threadId: string,
    objective: string,
    options: { context?: GoalContext; maxTurns?: number } = {}
  ): ThreadGoal {
    return this.manager.set(threadId, objective, options)
  }

  goal(threadId: string): ThreadGoal | null {
    return this.manager.get(threadId)
  }

  runTurn(
    threadId: string,
    turn: FakeAgentTurn,
    evaluator: FakeGoalEvaluator,
    turnIndex = 0
  ): GoalHarnessTurnResult {
    const beforeGoal = this.manager.getActive(threadId)
    if (!beforeGoal) {
      throw new Error(`No active goal for thread ${threadId}`)
    }

    const evaluationInput: GoalEvaluationInput = {
      goal: beforeGoal,
      assistantResponse: turn.assistantResponse,
      toolCalls: turn.toolCalls ?? [],
      toolEvidence: turn.toolEvidence ?? [],
      usedSkills: turn.usedSkills ?? []
    }
    const judgePrompt = buildGoalJudgeUserPrompt(evaluationInput)
    const decision = evaluator(evaluationInput, judgePrompt, turnIndex)
    const outcome = this.manager.recordJudgeDecision(threadId, decision, {
      expectedGoalId: beforeGoal.goalId,
      expectedActiveWindowId: beforeGoal.activeWindowId
    })
    return {
      beforeGoal,
      evaluationInput,
      judgePrompt,
      decision,
      outcome,
      afterGoal: this.manager.get(threadId)
    }
  }

  runUntilSettled(
    threadId: string,
    turns: FakeAgentTurn[],
    evaluator: FakeGoalEvaluator
  ): GoalHarnessTurnResult[] {
    const results: GoalHarnessTurnResult[] = []
    for (let i = 0; i < turns.length; i += 1) {
      const result = this.runTurn(threadId, turns[i], evaluator, i)
      results.push(result)
      if (!result.outcome?.shouldContinue) break
    }
    return results
  }
}
