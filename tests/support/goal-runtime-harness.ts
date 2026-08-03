import {
  buildGoalJudgeUserPrompt,
  shouldDeferGoalForActiveBackgroundWork,
  type GoalEvaluationInput
} from "../../src/main/agent/goals/evaluator.ts"
import { GoalBackgroundEvidenceStash } from "../../src/main/agent/goals/evidence.ts"
import { GoalManager } from "../../src/main/agent/goals/goal-manager.ts"
import { InMemoryGoalStore } from "../../src/main/agent/goals/goal-store.ts"
import type { GoalContext, GoalJudgeDecision, GoalTurnOutcome, ThreadGoal } from "../../src/main/agent/goals/types.ts"

export interface FakeAgentTurn {
  assistantResponse: string
  toolCalls?: string[]
  toolEvidence?: string[]
  usedSkills?: string[]
  /** Mirrors workflowRunManager.isActive(threadId) at goal-eval time: when true,
   * a background dynamic workflow is still running for the thread and the loop
   * must DEFER this sub-turn (no evaluation, no turn consumed). */
  workflowActive?: boolean
  /** Mirrors coordinatorWorkerManager.hasRunningWorkersForThread(threadId): when
   * true, at least one coordinator/agent-team worker is still running for the
   * thread — same defer semantics as workflowActive; production ORs the two. */
  workersActive?: boolean
  /** Mirrors coordinatorWorkerManager.hasAutoRunnableNotifications(threadId): a
   * worker is terminal (NOT running) but its result has not yet been delivered
   * into the conversation via a notification turn. Must also defer — otherwise
   * the goal evaluates on incomplete evidence (the #1 "done-but-not-delivered"
   * gap). Production ORs this with the two "running" signals. */
  pendingWorkerNotifications?: boolean
  /** Mirrors coordinatorWorkerManager.hasTerminalWorkerAwaitingNotificationForThread:
   * the still-earlier gap where a worker is terminal and persisting but its
   * notification is not yet even enqueued. Same defer semantics. */
  terminalWorkerAwaitingNotification?: boolean
  /** Mirrors the workflow leg (hasDeliverablePendingNotification, excluding the
   * turn currently delivering it): a fast workflow run completed and left the
   * active set but its result is not yet in the conversation. Same defer
   * semantics. */
  pendingWorkflowNotification?: boolean
  /** Mirrors agent.ts pendingBackgroundResultEvidence: the evidence entry built
   * from a background result THIS turn delivered (workflow <task-notification>
   * or coordinator worker batch). If the turn defers, production parks it in
   * GoalBackgroundEvidenceStash so the eventual evaluation still sees it — the
   * harness mirrors that exactly (same class, same consume-once semantics). */
  backgroundResultEvidence?: string
}

export interface GoalHarnessTurnResult {
  beforeGoal: ThreadGoal
  evaluationInput: GoalEvaluationInput
  judgePrompt: string
  /** null when the sub-turn was deferred (no judge decision was produced). */
  decision: GoalJudgeDecision | null
  outcome: GoalTurnOutcome | null
  afterGoal: ThreadGoal | null
  /** True when a running workflow deferred this sub-turn: the goal was neither
   * evaluated nor advanced, and no turn budget was consumed. */
  deferred: boolean
}

/** A fake evaluator either returns a decision the "model" produced, or — to
 * mirror production's evaluateGoalWithRuntimeRetry onFinalFailure — a
 * runtime-SYNTHESIZED decision the evaluator never actually computed (all
 * retries exhausted). The latter must NOT discard the evidence stash: the goal
 * pauses with "evaluator unavailable, resume later" and the post-resume
 * re-evaluation still needs the batches. */
export type FakeGoalEvaluatorResult =
  | GoalJudgeDecision
  | { runtimeFailureDecision: GoalJudgeDecision }

export type FakeGoalEvaluator = (
  input: GoalEvaluationInput,
  judgePrompt: string,
  turnIndex: number
) => FakeGoalEvaluatorResult

export class GoalRuntimeHarness {
  readonly store: InMemoryGoalStore
  readonly manager: GoalManager
  /** Same class production uses (agent.ts goalBackgroundEvidenceStash): parks a
   * deferred delivery turn's background evidence until the evaluation runs. */
  readonly backgroundEvidenceStash = new GoalBackgroundEvidenceStash()

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

    // Mirror the real goal loop (agent.ts): running background work (workflow
    // run OR coordinator worker) OR a terminal-but-undelivered worker result
    // (pending auto-runnable notification) defers the sub-turn — do NOT evaluate
    // or record a decision, so no turn budget is consumed and the goal stays
    // active for the notification turn to re-drive later. Production ORs the same
    // three signals; uses the same shared predicate as the production guard.
    if (
      shouldDeferGoalForActiveBackgroundWork(
        (turn.workflowActive ?? false) ||
          (turn.workersActive ?? false) ||
          (turn.pendingWorkerNotifications ?? false) ||
          (turn.terminalWorkerAwaitingNotification ?? false) ||
          (turn.pendingWorkflowNotification ?? false)
      )
    ) {
      // Mirror agent.ts: a deferring DELIVERY turn parks its own delivered
      // result before breaking — the notification is already acked and never
      // re-fires, so without this the evidence dies with the turn and the
      // eventual evaluation judges on a partial batch set. The turn's ORDINARY
      // tool evidence is parked too (workflow-mode main agents have fs tools —
      // verification greps in a deferred turn would equally die), combined into
      // one "supplementary" entry: cap overflow evicts supplementary entries
      // before ANY batch.
      // Tool-call NAMES ride along too: a call with empty/filtered output never
      // forms an evidence entry, yet mechanism goals ask "was X called at all".
      if ((turn.toolEvidence?.length ?? 0) > 0 || (turn.toolCalls?.length ?? 0) > 0) {
        this.backgroundEvidenceStash.stash(
          threadId,
          beforeGoal.goalId,
          [
            (turn.toolCalls?.length ?? 0) > 0
              ? `Deferred sub-turn tool calls: ${(turn.toolCalls ?? []).join(", ")}`
              : "",
            (turn.toolEvidence?.length ?? 0) > 0
              ? `Tool evidence from an earlier deferred sub-turn:\n${(turn.toolEvidence ?? []).join("\n\n")}`
              : ""
          ]
            .filter(Boolean)
            .join("\n\n"),
          "supplementary"
        )
      }
      if (turn.backgroundResultEvidence) {
        this.backgroundEvidenceStash.stash(
          threadId,
          beforeGoal.goalId,
          turn.backgroundResultEvidence
        )
      }
      const evaluationInput: GoalEvaluationInput = {
        goal: beforeGoal,
        assistantResponse: turn.assistantResponse,
        toolCalls: turn.toolCalls ?? [],
        toolEvidence: turn.toolEvidence ?? [],
        usedSkills: turn.usedSkills ?? []
      }
      return {
        beforeGoal,
        evaluationInput,
        judgePrompt: buildGoalJudgeUserPrompt(evaluationInput),
        decision: null,
        outcome: null,
        afterGoal: this.manager.get(threadId),
        deferred: true
      }
    }

    // Mirror agent.ts evidence assembly, oldest first: stashed batches from
    // earlier deferred delivery turns, then this turn's own delivered result,
    // then the turn's ordinary tool evidence. Production PEEKs here and
    // discards only after the verdict is recorded (the evaluator await is a
    // failure window; a failed attempt must leave the batches intact) — the
    // harness mirrors that ordering.
    const evaluationInput: GoalEvaluationInput = {
      goal: beforeGoal,
      assistantResponse: turn.assistantResponse,
      toolCalls: turn.toolCalls ?? [],
      toolEvidence: [
        ...this.backgroundEvidenceStash.peek(threadId, beforeGoal.goalId),
        ...(turn.backgroundResultEvidence ? [turn.backgroundResultEvidence] : []),
        ...(turn.toolEvidence ?? [])
      ],
      usedSkills: turn.usedSkills ?? []
    }
    const judgePrompt = buildGoalJudgeUserPrompt(evaluationInput)

    const evaluatorResult = evaluator(evaluationInput, judgePrompt, turnIndex)
    const evaluatorRuntimeFailed = "runtimeFailureDecision" in evaluatorResult
    const decision = evaluatorRuntimeFailed
      ? evaluatorResult.runtimeFailureDecision
      : evaluatorResult
    const outcome = this.manager.recordJudgeDecision(threadId, decision, {
      expectedGoalId: beforeGoal.goalId,
      expectedActiveWindowId: beforeGoal.activeWindowId
    })
    // Mirror agent.ts: discard the peeked batches only once a verdict that
    // actually SAW them was recorded — a runtime-synthesized failure verdict
    // (evaluator never ran) keeps the stash for the post-resume re-evaluation,
    // and re-parks THIS turn's own contributions (its notification is acked on
    // normal turn completion and never re-fires).
    if (outcome && !evaluatorRuntimeFailed) {
      this.backgroundEvidenceStash.discard(threadId)
    } else if (outcome && evaluatorRuntimeFailed) {
      if ((turn.toolEvidence?.length ?? 0) > 0 || (turn.toolCalls?.length ?? 0) > 0) {
        this.backgroundEvidenceStash.stash(
          threadId,
          beforeGoal.goalId,
          [
            (turn.toolCalls?.length ?? 0) > 0
              ? `Deferred sub-turn tool calls: ${(turn.toolCalls ?? []).join(", ")}`
              : "",
            (turn.toolEvidence?.length ?? 0) > 0
              ? `Tool evidence from an earlier deferred sub-turn:\n${(turn.toolEvidence ?? []).join("\n\n")}`
              : ""
          ]
            .filter(Boolean)
            .join("\n\n"),
          "supplementary"
        )
      }
      if (turn.backgroundResultEvidence) {
        this.backgroundEvidenceStash.stash(
          threadId,
          beforeGoal.goalId,
          turn.backgroundResultEvidence
        )
      }
    }
    return {
      beforeGoal,
      evaluationInput,
      judgePrompt,
      decision,
      outcome,
      afterGoal: this.manager.get(threadId),
      deferred: false
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
      // A deferred sub-turn is not a settle: the goal stays active (waiting for
      // the workflow). The next turn models the resume, so keep going.
      if (result.deferred) continue
      if (!result.outcome?.shouldContinue) break
    }
    return results
  }
}
