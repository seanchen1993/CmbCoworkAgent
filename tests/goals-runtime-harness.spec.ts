/**
 * Test-only Goal runtime harness.
 *
 * This simulates the important end-to-end loop without real LLM calls:
 * fake agent turn -> judge prompt construction -> fake evaluator decision ->
 * GoalManager state transition -> optional continuation prompt.
 *
 * Run:
 *   npx tsx tests/goals-runtime-harness.spec.ts
 */

import { GoalRuntimeHarness, type FakeGoalEvaluator } from "./support/goal-runtime-harness.ts"
import type { GoalJudgeDecision } from "../src/main/agent/goals/types.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function assertIncludes(haystack: string | undefined, needle: string, message: string): void {
  if (!haystack?.includes(needle)) {
    throw new Error(`${message}: missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`)
  }
}

function continueDecision(overrides: Partial<GoalJudgeDecision> = {}): GoalJudgeDecision {
  return {
    verdict: "continue",
    reason: "还需要继续检查 controller 的日志调用。",
    nextPrompt: "继续读取 controller 文件并用 rg 验证 log 调用。",
    ledgerPatch: {
      progress: ["已定位 controller 目录"],
      evidence: ["read_file AuthController.java"],
      blockers: []
    },
    ...overrides
  }
}

function testContinueThenCompleteLoop(): void {
  const threadId = "thread-goal-runtime-complete"
  const harness = new GoalRuntimeHarness({ maxTurns: 5 })
  const started = harness.start(threadId, "检查 controller 层是否还有日志打印，若有请删除", {
    context: {
      transportSummary: "附件：spec.md；显式技能：audit"
    }
  })

  let evaluatorCalls = 0
  const evaluator: FakeGoalEvaluator = (input, prompt, turnIndex) => {
    evaluatorCalls += 1
    assertEqual(input.goal.goalId, started.goalId, "fake evaluator should receive current goal")
    assertIncludes(prompt, "附件：spec.md；显式技能：audit", "judge prompt should include launch context summary")
    assertIncludes(prompt, "Tool calls observed this turn:", "judge prompt should include tool call section")
    assertIncludes(prompt, "Current-turn conversation evidence", "judge prompt should include evidence section")
    if (turnIndex === 0) {
      assertIncludes(prompt, "read_file AuthController.java", "first turn should expose tool call evidence")
      return continueDecision()
    }
    assertIncludes(prompt, "rg log.info src/main", "second turn should expose verification command")
    return {
      verdict: "complete",
      reason: "已验证 controller 中没有残留 log.info 调用。",
      ledgerPatch: {
        progress: ["已完成日志残留检查"],
        evidence: ["rg log.info src/main -- no matches"]
      }
    }
  }

  const results = harness.runUntilSettled(
    threadId,
    [
      {
        assistantResponse: "我已读取 AuthController，还需要继续检查其它 controller。",
        toolCalls: ["read_file AuthController.java"],
        toolEvidence: ["AuthController.java contains no log.info"],
        usedSkills: ["audit"]
      },
      {
        assistantResponse: "验证摘要：所有 controller 均无 log.info 残留。",
        toolCalls: ["execute rg log.info src/main"],
        toolEvidence: ["rg log.info src/main returned no matches"],
        usedSkills: ["audit"]
      }
    ],
    evaluator
  )

  assertEqual(evaluatorCalls, 2, "loop should evaluate both turns")
  assertEqual(results.length, 2, "loop should stop after completion")
  assertEqual(results[0].outcome?.shouldContinue, true, "first decision should continue")
  assertIncludes(
    results[0].outcome?.continuationPrompt,
    "<untrusted_evaluator_next_step_advisory>",
    "continue decision should produce continuation prompt with next step advisory"
  )
  assertIncludes(
    results[0].outcome?.continuationPrompt,
    "继续读取 controller 文件并用 rg 验证 log 调用。",
    "continuation prompt should carry evaluator next step"
  )

  const finalGoal = harness.goal(threadId)
  assertEqual(finalGoal?.status, "complete", "goal should complete after complete verdict")
  assertEqual(finalGoal?.turnsUsed, 2, "completed goal should count both evaluated turns")
  assert(finalGoal?.ledger.progress.includes("已定位 controller 目录"), "ledger should keep first turn progress")
  assert(finalGoal?.ledger.progress.includes("已完成日志残留检查"), "ledger should merge final progress")
  assert(finalGoal?.ledger.evidence.includes("rg log.info src/main -- no matches"), "ledger should keep verification evidence")
}

function testBlockedNeedsUserInputStopsLoop(): void {
  const threadId = "thread-goal-runtime-blocked"
  const harness = new GoalRuntimeHarness()
  harness.start(threadId, "cl")

  const results = harness.runUntilSettled(
    threadId,
    [
      {
        assistantResponse: "我不确定 cl 是什么意思，需要用户澄清。",
        toolCalls: []
      },
      {
        assistantResponse: "这一轮不应继续执行。",
        toolCalls: []
      }
    ],
    () => ({
      verdict: "blocked",
      reason: "目标 cl 不明确，需要用户补充说明。",
      blockerType: "needs_user_input",
      ledgerPatch: {
        blockers: ["目标 cl 不明确"]
      }
    })
  )

  assertEqual(results.length, 1, "needs_user_input should stop auto loop")
  assertEqual(results[0].outcome?.shouldContinue, false, "blocked decision should not continue")
  const goal = harness.goal(threadId)
  assertEqual(goal?.status, "paused", "needs_user_input should pause goal")
  assertIncludes(goal?.pausedReason ?? "", "needs_user_input:", "pause reason should mark user-input blocker")
  assert(goal?.ledger.blockers.includes("目标 cl 不明确"), "blocker ledger should be preserved")
}

function testParseFailureBackstopPausesAfterThreeTurns(): void {
  const threadId = "thread-goal-runtime-parse-failure"
  const harness = new GoalRuntimeHarness({ maxTurns: 10 })
  harness.start(threadId, "持续检查直到完成")

  const results = harness.runUntilSettled(
    threadId,
    [
      { assistantResponse: "第 1 轮", toolCalls: [] },
      { assistantResponse: "第 2 轮", toolCalls: [] },
      { assistantResponse: "第 3 轮", toolCalls: [] },
      { assistantResponse: "不应该执行第 4 轮", toolCalls: [] }
    ],
    () => ({
      verdict: "continue",
      reason: "Evaluator returned invalid schema: missing reason.",
      parseFailed: true
    })
  )

  assertEqual(results.length, 3, "three consecutive parse failures should stop loop")
  const goal = harness.goal(threadId)
  assertEqual(goal?.status, "paused", "parse-failure backstop should pause goal")
  assertEqual(goal?.consecutiveParseFailures, 3, "parse failure counter should reach three")
  assertEqual(
    goal?.pausedReason,
    "Evaluator returned invalid JSON 3 turns in a row.",
    "pause reason should explain invalid JSON backstop"
  )
}

function testTurnBudgetStopsContinuation(): void {
  const threadId = "thread-goal-runtime-budget"
  const harness = new GoalRuntimeHarness({ maxTurns: 2 })
  harness.start(threadId, "最多两轮后暂停")

  const results = harness.runUntilSettled(
    threadId,
    [
      { assistantResponse: "第 1 轮，还没完成。", toolCalls: ["read_file A.java"] },
      { assistantResponse: "第 2 轮，还没完成。", toolCalls: ["read_file B.java"] },
      { assistantResponse: "第 3 轮不应执行。", toolCalls: [] }
    ],
    () => continueDecision({ reason: "仍未完成，需要继续。" })
  )

  assertEqual(results.length, 2, "turn budget should stop before third fake turn")
  assertEqual(results[0].outcome?.shouldContinue, true, "first turn should continue")
  assertEqual(results[1].outcome?.shouldContinue, false, "second turn should hit budget")
  const goal = harness.goal(threadId)
  assertEqual(goal?.status, "paused", "budget exhaustion should pause goal")
  assertEqual(goal?.pausedReason, "Turn budget exhausted (2/2).", "budget pause reason should include count")
}

function testEvaluatorRuntimeFailurePausesWithoutContinuation(): void {
  const threadId = "thread-goal-runtime-evaluator-failure"
  const harness = new GoalRuntimeHarness({ maxTurns: 5 })
  harness.start(threadId, "检查 controller 日志并确认无残留")

  const results = harness.runUntilSettled(
    threadId,
    [
      {
        assistantResponse: "已读取 AuthController，还需要 evaluator 判断下一步。",
        toolCalls: ["read_file AuthController.java"],
        toolEvidence: ["AuthController.java read ok"]
      },
      {
        assistantResponse: "不应该在 evaluator runtime failure 后继续第二轮。",
        toolCalls: ["execute rg log src/main"]
      }
    ],
    () => ({
      verdict: "blocked",
      reason: "评估器暂时不可用。Goal 已暂停，请稍后使用 /goal resume 重试。"
    })
  )

  assertEqual(results.length, 1, "evaluator runtime failure should stop auto continuation")
  assertEqual(results[0].outcome?.shouldContinue, false, "blocked evaluator failure must not continue")
  assert(
    !results[0].outcome?.continuationPrompt,
    "blocked evaluator failure must not produce a continuation prompt"
  )
  const goal = harness.goal(threadId)
  assertEqual(goal?.status, "paused", "evaluator runtime failure should pause goal")
  assertEqual(goal?.turnsUsed, 1, "failed evaluator turn should still be accounted")
  assertEqual(
    goal?.pausedReason,
    "评估器暂时不可用。Goal 已暂停，请稍后使用 /goal resume 重试。",
    "paused reason should explain evaluator runtime failure"
  )
}

function testStaleWindowDecisionCannotMutateResumedGoal(): void {
  const threadId = "thread-goal-runtime-stale-window"
  const harness = new GoalRuntimeHarness()
  const original = harness.start(threadId, "检查并修复日志")
  harness.manager.pause(threadId, "user-paused")
  const resumed = harness.manager.resume(threadId)

  assert(resumed, "resume should return a goal")
  assertEqual(resumed?.goalId, original.goalId, "resume keeps logical goal id")
  assert(
    resumed?.activeWindowId !== original.activeWindowId,
    "resume should rotate active window id"
  )

  const staleOutcome = harness.manager.recordJudgeDecision(
    threadId,
    {
      verdict: "complete",
      reason: "旧窗口迟到的 evaluator 结果。"
    },
    {
      expectedGoalId: original.goalId,
      expectedActiveWindowId: original.activeWindowId
    }
  )

  assertEqual(staleOutcome, null, "stale active window decision should be ignored")
  const goal = harness.goal(threadId)
  assertEqual(goal?.status, "active", "resumed goal should remain active")
  assertEqual(goal?.turnsUsed, 0, "stale decision must not consume a turn")
  assertEqual(goal?.lastReason, null, "stale decision must not overwrite last reason")
}

function run(): void {
  testContinueThenCompleteLoop()
  testBlockedNeedsUserInputStopsLoop()
  testParseFailureBackstopPausesAfterThreeTurns()
  testTurnBudgetStopsContinuation()
  testEvaluatorRuntimeFailurePausesWithoutContinuation()
  testStaleWindowDecisionCannotMutateResumedGoal()
  console.log("goals-runtime-harness.spec.ts passed")
}

run()
