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
import { formatGoalEvaluatorRuntimeFailureReason } from "../src/main/agent/goals/evaluator-runtime.ts"
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

function assertNotIncludes(haystack: string | undefined, needle: string, message: string): void {
  if (haystack?.includes(needle)) {
    throw new Error(`${message}: unexpected ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`)
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
    assertIncludes(
      prompt,
      "附件：spec.md；显式技能：audit",
      "judge prompt should include launch context summary"
    )
    assertIncludes(
      prompt,
      "Tool calls observed this turn:",
      "judge prompt should include tool call section"
    )
    assertIncludes(
      prompt,
      "Current-turn conversation evidence",
      "judge prompt should include evidence section"
    )
    if (turnIndex === 0) {
      assertIncludes(
        prompt,
        "read_file AuthController.java",
        "first turn should expose tool call evidence"
      )
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
  assert(
    finalGoal?.ledger.progress.includes("已定位 controller 目录"),
    "ledger should keep first turn progress"
  )
  assert(
    finalGoal?.ledger.progress.includes("已完成日志残留检查"),
    "ledger should merge final progress"
  )
  assert(
    finalGoal?.ledger.evidence.includes("rg log.info src/main -- no matches"),
    "ledger should keep verification evidence"
  )
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
  assertIncludes(
    goal?.pausedReason ?? "",
    "needs_user_input:",
    "pause reason should mark user-input blocker"
  )
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
  assertEqual(
    goal?.pausedReason,
    "Turn budget exhausted (2/2).",
    "budget pause reason should include count"
  )
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
      reason: "评估器暂时不可用。请稍后使用 /goal resume 重试。"
    })
  )

  assertEqual(results.length, 1, "evaluator runtime failure should stop auto continuation")
  assertEqual(
    results[0].outcome?.shouldContinue,
    false,
    "blocked evaluator failure must not continue"
  )
  assert(
    !results[0].outcome?.continuationPrompt,
    "blocked evaluator failure must not produce a continuation prompt"
  )
  const goal = harness.goal(threadId)
  assertEqual(goal?.status, "paused", "evaluator runtime failure should pause goal")
  assertEqual(goal?.turnsUsed, 1, "failed evaluator turn should still be accounted")
  assertEqual(
    goal?.pausedReason,
    "评估器暂时不可用。请稍后使用 /goal resume 重试。",
    "paused reason should explain evaluator runtime failure"
  )
}

function testEvaluatorRuntimeFailureNoticeKeepsSanitizedSummary(): void {
  const threadId = "thread-goal-runtime-evaluator-failure-summary"
  const harness = new GoalRuntimeHarness({ maxTurns: 5 })
  harness.start(threadId, "检查 controller 日志并确认无残留")

  const secret = "sk-abcdefghijklmnopqrstuvwxyz"
  const reason = formatGoalEvaluatorRuntimeFailureReason(
    new Error(`Request timed out with token=${secret} after 30000ms`)
  )
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
      reason
    })
  )

  assertEqual(results.length, 1, "evaluator runtime failure summary should stop auto loop")
  assertEqual(
    results[0].outcome?.shouldContinue,
    false,
    "blocked evaluator failure summary must not continue"
  )
  const goal = harness.goal(threadId)
  assertEqual(goal?.status, "paused", "evaluator runtime failure summary should pause goal")
  assertIncludes(
    goal?.pausedReason,
    "Request timed out",
    "paused reason should include sanitized evaluator failure summary"
  )
  assertIncludes(
    results[0].outcome?.notice,
    "Goal 已暂停：评估器暂时不可用：Request timed out",
    "notice should include sanitized evaluator failure summary"
  )
  assertNotIncludes(goal?.pausedReason, secret, "paused reason should redact evaluator secrets")
  assertNotIncludes(results[0].outcome?.notice, secret, "notice should redact evaluator secrets")
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

function testActiveWorkflowDefersGoalInsteadOfNagging(): void {
  const threadId = "thread-goal-runtime-workflow-defer"
  const harness = new GoalRuntimeHarness({ maxTurns: 3 })
  harness.start(threadId, "用动态工作流检视当前变更并修复发现的问题")

  // The evaluator would say "continue" while waiting — proving it is the DEFER
  // (not a lucky verdict) that stops the nag. It only completes once the
  // workflow result has been surfaced.
  const evaluator: FakeGoalEvaluator = (_input, _prompt, turnIndex) =>
    turnIndex >= 2
      ? { verdict: "complete", reason: "已根据工作流结果完成检视与修复。" }
      : { verdict: "continue", reason: "仍在等待工作流结果。", nextPrompt: "继续。" }

  // Turn 0: agent launched the workflow; it is still RUNNING -> defer.
  const launched = harness.runTurn(
    threadId,
    {
      assistantResponse: "已启动动态工作流检视变更，等待结果。",
      toolCalls: ["Workflow"],
      workflowActive: true
    },
    evaluator,
    0
  )
  assert(launched.deferred, "running workflow should defer the sub-turn")
  assertEqual(launched.decision, null, "deferred sub-turn must not produce a judge decision")
  assertEqual(launched.outcome, null, "deferred sub-turn must not record an outcome")
  assertEqual(launched.afterGoal?.status, "active", "goal stays active while workflow runs")
  assertEqual(launched.afterGoal?.turnsUsed, 0, "deferred sub-turn must not consume turn budget")

  // Turn 1: workflow STILL running (a second trigger fired) -> defer again. The
  // goal must not creep toward the maxTurns=3 budget while merely waiting — this
  // is the exact "notification hasn't arrived, keeps nagging" case being fixed.
  const stillWaiting = harness.runTurn(
    threadId,
    { assistantResponse: "工作流仍在运行，继续等待。", workflowActive: true },
    evaluator,
    1
  )
  assert(stillWaiting.deferred, "still-running workflow should defer again")
  assertEqual(stillWaiting.afterGoal?.turnsUsed, 0, "repeated waiting must not burn the budget")

  // Turn 2: workflow finished; its notification turn delivered the result and
  // the agent synthesized it (workflowActive=false) -> normal evaluation.
  const resumed = harness.runTurn(
    threadId,
    {
      assistantResponse: "工作流返回：发现并修复了 2 个问题，已验证。",
      toolCalls: ["TaskOutput"],
      toolEvidence: ["workflow result: 2 findings fixed; typecheck PASS"],
      workflowActive: false
    },
    evaluator,
    2
  )
  assert(!resumed.deferred, "finished workflow must allow normal evaluation")
  assertEqual(resumed.decision?.verdict, "complete", "resume turn should evaluate to complete")
  assertEqual(resumed.outcome?.shouldContinue, false, "completed goal should not continue")
  assertEqual(resumed.afterGoal?.status, "complete", "goal should complete after workflow result")
  assertEqual(
    resumed.afterGoal?.turnsUsed,
    1,
    "only the real evaluated turn consumes budget; deferred waits do not"
  )
}

function testActiveCoordinatorWorkersDeferGoalInsteadOfNagging(): void {
  const threadId = "thread-goal-runtime-workers-defer"
  const harness = new GoalRuntimeHarness({ maxTurns: 3 })
  harness.start(threadId, "用 agent team 并行完成需求拆解与实现")

  // Evaluator would keep saying "continue" while workers run — the DEFER (not a
  // lucky verdict) must be what prevents the nag, mirroring the workflow test.
  const evaluator: FakeGoalEvaluator = (_input, _prompt, turnIndex) =>
    turnIndex >= 2
      ? { verdict: "complete", reason: "全部 worker 已交付并通过验证。" }
      : { verdict: "continue", reason: "worker 仍在执行。", nextPrompt: "继续。" }

  // Turn 0: coordinator spawned workers; some still RUNNING -> defer.
  const spawned = harness.runTurn(
    threadId,
    {
      assistantResponse: "已派发 3 个 worker 并行处理，等待结果。",
      toolCalls: ["agent", "agent", "agent"],
      workersActive: true
    },
    evaluator,
    0
  )
  assert(spawned.deferred, "running coordinator workers should defer the sub-turn")
  assertEqual(spawned.decision, null, "deferred sub-turn must not produce a judge decision")
  assertEqual(spawned.afterGoal?.status, "active", "goal stays active while workers run")
  assertEqual(spawned.afterGoal?.turnsUsed, 0, "deferred sub-turn must not consume turn budget")

  // Turn 1: first worker's notification turn lands, but OTHER workers are still
  // running -> keep deferring the VERDICT while its result is processed. The
  // multi-worker set must fully settle before the goal is judged.
  const partial = harness.runTurn(
    threadId,
    {
      assistantResponse: "worker-1 已完成：拆解文档就绪。其余 worker 仍在执行。",
      toolEvidence: ["worker-1 result: 需求拆解完成"],
      workersActive: true
    },
    evaluator,
    1
  )
  assert(partial.deferred, "partially-finished worker set should still defer")
  assertEqual(partial.afterGoal?.turnsUsed, 0, "waiting on remaining workers must not burn budget")

  // Turn 2: last worker's notification turn — worker set terminal BEFORE the
  // notification is enqueued (manager invariant), so workersActive=false here
  // and the goal finally evaluates with the full result set.
  const settled = harness.runTurn(
    threadId,
    {
      assistantResponse: "全部 worker 完成：实现+测试通过，已汇总交付。",
      toolEvidence: ["worker-2 result: 实现完成", "worker-3 result: 测试通过"],
      workersActive: false
    },
    evaluator,
    2
  )
  assert(!settled.deferred, "fully-terminal worker set must allow normal evaluation")
  assertEqual(settled.decision?.verdict, "complete", "settle turn should evaluate to complete")
  assertEqual(settled.afterGoal?.status, "complete", "goal should complete after all workers settle")
  assertEqual(
    settled.afterGoal?.turnsUsed,
    1,
    "only the real evaluated turn consumes budget; worker waits do not"
  )
}

function testTerminalButUndeliveredWorkerResultDefersGoal(): void {
  // The #1 "done-but-not-delivered" gap: a worker is terminal (NOT running, so
  // the running-check passes) but its result has not yet been delivered into the
  // conversation via its notification turn. Evaluating now would judge on
  // incomplete evidence. The pending-auto-runnable-notification signal must also
  // defer, and it must NOT consume budget while waiting.
  const threadId = "thread-goal-runtime-undelivered"
  const harness = new GoalRuntimeHarness({ maxTurns: 3 })
  harness.start(threadId, "用 agent team 完成任务并汇总")

  const evaluator: FakeGoalEvaluator = (_input, _prompt, turnIndex) =>
    turnIndex >= 1
      ? { verdict: "complete", reason: "worker 结果已全部送达并通过。" }
      : { verdict: "continue", reason: "结果尚未送达。", nextPrompt: "继续。" }

  // Turn 0: this turn delivered W1's result; W2 completed AFTER this turn's drain,
  // so W2 is terminal (not running) but its notification is still pending — the
  // result is not yet in evidence. Must defer, not evaluate on partial evidence.
  const gap = harness.runTurn(
    threadId,
    {
      assistantResponse: "已处理 worker-1 的结果；worker-2 的结果还在送达途中。",
      toolEvidence: ["worker-1 result: 部分完成"],
      workersActive: false,
      pendingWorkerNotifications: true
    },
    evaluator,
    0
  )
  assert(gap.deferred, "a terminal-but-undelivered worker result must defer the sub-turn")
  assertEqual(gap.decision, null, "the gap turn must not evaluate on incomplete evidence")
  assertEqual(gap.afterGoal?.status, "active", "goal stays active across the delivery gap")
  assertEqual(gap.afterGoal?.turnsUsed, 0, "waiting for delivery must not consume budget")

  // Turn 1: W2's notification turn delivered its result (nothing pending now) ->
  // evaluate with the full evidence -> complete.
  const delivered = harness.runTurn(
    threadId,
    {
      assistantResponse: "worker-2 结果已送达，已汇总全部产出。",
      toolEvidence: ["worker-2 result: 完成"],
      workersActive: false,
      pendingWorkerNotifications: false
    },
    evaluator,
    1
  )
  assert(!delivered.deferred, "once delivered, the goal must evaluate normally")
  assertEqual(delivered.decision?.verdict, "complete", "delivered turn evaluates to complete")
  assertEqual(delivered.afterGoal?.status, "complete", "goal completes once all results delivered")
  assertEqual(delivered.afterGoal?.turnsUsed, 1, "only the delivered turn consumed budget")
}

function testEarlierUndeliveredWindowsDeferGoal(): void {
  // The two narrower windows closed after the review debate:
  //  - terminalWorkerAwaitingNotification: worker terminal + persisting, its
  //    notification not yet even enqueued.
  //  - pendingWorkflowNotification: a fast workflow run completed and left the
  //    active set on the launch turn, result not yet delivered.
  // Both must defer (no budget consumed); once delivered, the goal evaluates.
  const threadId = "thread-goal-runtime-earlier-windows"
  const harness = new GoalRuntimeHarness({ maxTurns: 3 })
  harness.start(threadId, "混合后台任务完成后汇总")

  const evaluator: FakeGoalEvaluator = (_input, _prompt, turnIndex) =>
    turnIndex >= 2
      ? { verdict: "complete", reason: "所有后台结果已送达并汇总。" }
      : { verdict: "continue", reason: "结果尚未送达。", nextPrompt: "继续。" }

  const persisting = harness.runTurn(
    threadId,
    {
      assistantResponse: "worker 刚终态，结果还在落盘、通知尚未入队。",
      terminalWorkerAwaitingNotification: true
    },
    evaluator,
    0
  )
  assert(persisting.deferred, "terminal-but-not-yet-enqueued worker must defer")
  assertEqual(persisting.afterGoal?.turnsUsed, 0, "the persist-gap wait must not consume budget")

  const fastWorkflow = harness.runTurn(
    threadId,
    {
      assistantResponse: "快完成的 workflow 已离开 active，但结果还没进证据。",
      pendingWorkflowNotification: true
    },
    evaluator,
    1
  )
  assert(fastWorkflow.deferred, "fast workflow with an undelivered result must defer")
  assertEqual(fastWorkflow.afterGoal?.turnsUsed, 0, "the workflow-delivery wait must not consume budget")

  const delivered = harness.runTurn(
    threadId,
    {
      assistantResponse: "全部结果已送达并汇总完成。",
      toolEvidence: ["worker + workflow results delivered"]
    },
    evaluator,
    2
  )
  assert(!delivered.deferred, "once all results are delivered the goal evaluates")
  assertEqual(delivered.decision?.verdict, "complete", "delivered turn evaluates to complete")
  assertEqual(delivered.afterGoal?.status, "complete", "goal completes once everything is delivered")
  assertEqual(delivered.afterGoal?.turnsUsed, 1, "only the delivered turn consumed budget")
}

function testDeferredDeliveryEvidenceSurvivesToFinalEvaluation(): void {
  // The backlog evidence-loss regression (Codex P1): delivery turn A carries
  // result A's evidence but DEFERS because result B is still pending. A is
  // already acked and never re-fires — without the stash its evidence dies with
  // the turn and the final evaluation judges on B alone. The final evaluator
  // input must contain BOTH batches, oldest first.
  const threadId = "thread-goal-runtime-evidence-carryover"
  const harness = new GoalRuntimeHarness({ maxTurns: 3 })
  harness.start(threadId, "用动态工作流并行统计两个指标并汇总")

  const evaluator: FakeGoalEvaluator = () => ({
    verdict: "complete",
    reason: "两批后台结果均已送达并核实。"
  })

  // Turn 0: workflow A's notification turn delivers batch A, but workflow B is
  // still pending -> defer; the delivered evidence must be parked, not lost.
  // The turn also ran its own verification grep (workflow-mode main agents have
  // fs tools) — that ordinary evidence must survive the defer too.
  const deliveryA = harness.runTurn(
    threadId,
    {
      assistantResponse: "workflow A 已返回，等待 workflow B。",
      // silent_probe models a call whose output was empty/filtered: it forms NO
      // evidence entry, so only the tool-call NAME line can prove it was called.
      toolCalls: ["grep", "silent_probe"],
      toolEvidence: ["Tool: grep\nOutput:\ngrep-verified-source-listing"],
      backgroundResultEvidence: "Tool: workflow\nOutput:\nbatch-A: .java=38",
      pendingWorkflowNotification: true
    },
    evaluator,
    0
  )
  assert(deliveryA.deferred, "delivery turn A must defer while B is still pending")
  assertEqual(deliveryA.afterGoal?.turnsUsed, 0, "deferred delivery must not burn budget")

  // Turn 1: workflow B's notification turn delivers batch B with nothing else
  // pending -> evaluates. The judge must see batch A (stashed) AND batch B.
  const deliveryB = harness.runTurn(
    threadId,
    {
      assistantResponse: "两个 workflow 均已返回：.java=38、.xml=23，汇总完成。",
      backgroundResultEvidence: "Tool: workflow\nOutput:\nbatch-B: .xml=23"
    },
    evaluator,
    1
  )
  assert(!deliveryB.deferred, "final delivery turn must evaluate")
  const evidence = deliveryB.evaluationInput.toolEvidence ?? []
  assertEqual(
    evidence.filter((entry) => entry.includes("batch-A")).length,
    1,
    "the DEFERRED turn's delivered evidence (batch A) must reach the final evaluation"
  )
  assertEqual(
    evidence.filter((entry) => entry.includes("batch-B")).length,
    1,
    "the final turn's own delivered evidence (batch B) must be present"
  )
  assert(
    evidence.findIndex((entry) => entry.includes("batch-A")) <
      evidence.findIndex((entry) => entry.includes("batch-B")),
    "stashed batches must come before the final delivery (oldest first)"
  )
  const deferredOrdinaryIdx = evidence.findIndex((entry) =>
    entry.includes("grep-verified-source-listing")
  )
  assert(
    deferredOrdinaryIdx !== -1,
    "the deferred turn's ORDINARY tool evidence (its own verification grep) must also survive"
  )
  assert(
    evidence[deferredOrdinaryIdx].includes("deferred sub-turn"),
    "surviving ordinary evidence must be labeled as coming from a deferred sub-turn"
  )
  assert(
    evidence[deferredOrdinaryIdx].includes("Deferred sub-turn tool calls: grep, silent_probe"),
    "the deferred turn's tool-call NAMES must survive too — a silent (no-output) call has no evidence entry, only its name proves it was called"
  )
  assert(
    deferredOrdinaryIdx < evidence.findIndex((entry) => entry.includes("batch-A")),
    "ordinary evidence is stashed before its turn's batch (cap evicts it first)"
  )
  assert(
    deliveryB.judgePrompt.includes("batch-A") && deliveryB.judgePrompt.includes("batch-B"),
    "judge prompt must surface both delivered batches"
  )
  assertEqual(deliveryB.afterGoal?.status, "complete", "goal completes on the full batch set")

  // Consume-once: the stash must be empty afterwards (no stale re-injection).
  assertEqual(
    harness.backgroundEvidenceStash.consume(threadId, deliveryB.beforeGoal.goalId).length,
    0,
    "stash must be cleared once consumed by the evaluation"
  )
}

function testStashedEvidenceSurvivesFailedEvaluationAttempt(): void {
  // The consume-before-success hole (Codex P2 on the P1 fix): production peeks
  // the stash, then AWAITS the evaluator, then records. If the attempt dies in
  // between (abort / model error), the batches must still be there for the
  // re-driven turn — peek-then-discard-on-record, not consume-up-front.
  const threadId = "thread-goal-runtime-evidence-failed-attempt"
  const harness = new GoalRuntimeHarness({ maxTurns: 3 })
  harness.start(threadId, "用动态工作流并行统计两个指标并汇总")

  // Delivery turn A defers (B pending) -> batch A parked.
  harness.runTurn(
    threadId,
    {
      assistantResponse: "workflow A 已返回，等待 workflow B。",
      backgroundResultEvidence: "Tool: workflow\nOutput:\nbatch-A: .java=38",
      pendingWorkflowNotification: true
    },
    () => {
      throw new Error("unreachable: deferred turn never evaluates")
    },
    0
  )

  // Delivery turn B evaluates, but the evaluator DIES mid-attempt.
  let threw = false
  try {
    harness.runTurn(
      threadId,
      {
        assistantResponse: "两个 workflow 均已返回，汇总中。",
        backgroundResultEvidence: "Tool: workflow\nOutput:\nbatch-B: .xml=23"
      },
      () => {
        throw new Error("evaluator aborted mid-attempt")
      },
      1
    )
  } catch {
    threw = true
  }
  assert(threw, "the failed evaluation attempt must propagate")
  const goalId = harness.goal(threadId)!.goalId
  assertEqual(
    harness.backgroundEvidenceStash.peek(threadId, goalId).join(","),
    "Tool: workflow\nOutput:\nbatch-A: .java=38",
    "a failed evaluation attempt must NOT lose the stashed batch (peek, not consume)"
  )

  // The re-driven turn (B re-delivered at-least-once) evaluates successfully —
  // batch A must still reach the judge.
  const retried = harness.runTurn(
    threadId,
    {
      assistantResponse: "两个 workflow 均已返回：.java=38、.xml=23，汇总完成。",
      backgroundResultEvidence: "Tool: workflow\nOutput:\nbatch-B: .xml=23"
    },
    () => ({ verdict: "complete", reason: "两批结果均送达并核实。" }),
    2
  )
  assert(!retried.deferred, "the retried delivery turn must evaluate")
  assertEqual(
    (retried.evaluationInput.toolEvidence ?? []).filter((entry) => entry.includes("batch-A"))
      .length,
    1,
    "batch A must survive the failed attempt and reach the successful evaluation"
  )
  assertEqual(retried.afterGoal?.status, "complete", "goal completes on the retried evaluation")
  assertEqual(
    harness.backgroundEvidenceStash.peek(threadId, goalId).length,
    0,
    "the recorded verdict must discard the stash (no stale re-injection)"
  )
}

function testStashSurvivesEvaluatorRuntimeFinalFailure(): void {
  // The production evaluator-failure path (NOT a throw): evaluateGoalWithRuntimeRetry
  // exhausts retries and SYNTHESIZES a blocked verdict via onFinalFailure — record
  // succeeds, the goal pauses with "evaluator unavailable, /goal resume later",
  // and the turn completes normally (its notification is acked). The stash must
  // NOT be discarded on that synthetic verdict, and this turn's own batch must be
  // re-parked — otherwise the post-resume re-evaluation judges without A and B.
  const threadId = "thread-goal-runtime-evaluator-final-failure"
  const harness = new GoalRuntimeHarness({ maxTurns: 5 })
  harness.start(threadId, "用动态工作流并行统计两个指标并汇总")

  // Turn 0: batch A delivered, defers (B pending) -> A parked.
  harness.runTurn(
    threadId,
    {
      assistantResponse: "workflow A 已返回，等待 workflow B。",
      backgroundResultEvidence: "Tool: workflow\nOutput:\nbatch-A: .java=38",
      pendingWorkflowNotification: true
    },
    () => {
      throw new Error("unreachable: deferred turn never evaluates")
    },
    0
  )

  // Turn 1: batch B delivered, evaluator exhausts retries -> synthetic blocked.
  const failed = harness.runTurn(
    threadId,
    {
      assistantResponse: "两个 workflow 均已返回，汇总中。",
      backgroundResultEvidence: "Tool: workflow\nOutput:\nbatch-B: .xml=23"
    },
    () => ({
      runtimeFailureDecision: {
        verdict: "blocked",
        reason: formatGoalEvaluatorRuntimeFailureReason(new Error("ECONNRESET"))
      }
    }),
    1
  )
  assertEqual(failed.afterGoal?.status, "paused", "runtime failure must pause the goal")
  const goalId = failed.beforeGoal.goalId
  const kept = harness.backgroundEvidenceStash.peek(threadId, goalId)
  assert(
    kept.some((entry) => entry.includes("batch-A")),
    "the synthetic failure verdict must NOT discard the stashed batch A"
  )
  assert(
    kept.some((entry) => entry.includes("batch-B")),
    "the failed turn's OWN batch B must be re-parked (its notification is acked, never re-fires)"
  )

  // /goal resume -> the re-evaluation must see BOTH batches, then clear the stash.
  assert(harness.manager.resume(threadId) !== null, "resume must reactivate the goal")
  const resumed = harness.runTurn(
    threadId,
    { assistantResponse: "恢复后重新汇总：.java=38、.xml=23。" },
    () => ({ verdict: "complete", reason: "两批结果均已核实。" }),
    2
  )
  assert(!resumed.deferred, "the post-resume turn must evaluate")
  const evidence = resumed.evaluationInput.toolEvidence ?? []
  assert(
    evidence.some((entry) => entry.includes("batch-A")) &&
      evidence.some((entry) => entry.includes("batch-B")),
    "the post-resume evaluation must see both preserved batches"
  )
  assertEqual(resumed.afterGoal?.status, "complete", "goal completes after the resumed evaluation")
  assertEqual(
    harness.backgroundEvidenceStash.peek(threadId, goalId).length,
    0,
    "the successful post-resume verdict must clear the stash"
  )
}

function run(): void {
  testContinueThenCompleteLoop()
  testBlockedNeedsUserInputStopsLoop()
  testParseFailureBackstopPausesAfterThreeTurns()
  testTurnBudgetStopsContinuation()
  testEvaluatorRuntimeFailurePausesWithoutContinuation()
  testEvaluatorRuntimeFailureNoticeKeepsSanitizedSummary()
  testStaleWindowDecisionCannotMutateResumedGoal()
  testActiveWorkflowDefersGoalInsteadOfNagging()
  testActiveCoordinatorWorkersDeferGoalInsteadOfNagging()
  testTerminalButUndeliveredWorkerResultDefersGoal()
  testEarlierUndeliveredWindowsDeferGoal()
  testDeferredDeliveryEvidenceSurvivesToFinalEvaluation()
  testStashedEvidenceSurvivesFailedEvaluationAttempt()
  testStashSurvivesEvaluatorRuntimeFinalFailure()
  console.log("goals-runtime-harness.spec.ts passed")
}

run()
