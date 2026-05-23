/**
 * Unit tests for the Goal panel view model.
 *
 * Run:
 *   npx tsx tests/goal-panel-view.spec.ts
 */

import {
  buildGoalPanelViewModel,
  cleanGoalEventText,
  displayGoalPanelPausedReason,
  goalEmptyDetail,
  goalVerdictLabel
} from "../src/renderer/src/lib/goal-panel-view.ts"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../src/shared/goal-events.ts"
import type { GoalEvent, GoalSnapshot, GoalUiState } from "../src/renderer/src/types.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function assertArrayEqual<T>(actual: T[], expected: T[], message: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText) {
    throw new Error(`${message}: expected ${expectedText}, got ${actualText}`)
  }
}

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    threadId: "thread-1",
    goalId: "goal-1",
    activeWindowId: "window-1",
    objective: "讲解项目功能",
    completionCondition: "讲清楚项目结构、认证、API 和配置",
    context: {},
    status: "active",
    turnsUsed: 0,
    maxTurns: 15,
    lastVerdict: null,
    lastReason: null,
    pausedReason: null,
    consecutiveParseFailures: 0,
    ledger: {
      progress: [],
      evidence: [],
      blockers: []
    },
    createdAt: Date.parse("2026-05-22T10:00:00.000Z"),
    updatedAt: Date.parse("2026-05-22T10:00:10.000Z"),
    ...overrides
  }
}

function event(
  eventId: number,
  message: string,
  createdAt: string,
  goalId: string | null = "goal-1"
): GoalEvent {
  return {
    event_id: eventId,
    thread_id: "thread-1",
    goal_id: goalId,
    message,
    created_at: createdAt
  }
}

function uiState(goalSnapshot: GoalSnapshot | null, events: GoalEvent[] = []): GoalUiState {
  return {
    goal: goalSnapshot,
    events,
    lastUpdated: new Date("2026-05-22T10:00:20.000Z")
  }
}

function testCompleteGoalShowsEvaluatorReasonAndLedger(): void {
  const model = buildGoalPanelViewModel(
    uiState(
      goal({
        status: "complete",
        turnsUsed: 1,
        lastVerdict: "complete",
        lastReason: "Evaluator verified the project explanation against actual source reads.",
        context: {
          transportSummary: "启动附件：spec.md",
          explicitSkill: { name: "docs", path: "/tmp/docs/SKILL.md" }
        },
        ledger: {
          progress: ["已解释项目结构", "已说明认证流程"],
          evidence: ["读取了 pom.xml", "读取了 AuthController.java"],
          blockers: []
        }
      }),
      [
        event(1, "Goal 已设置", "2026-05-22T10:00:01.000Z"),
        event(2, "Goal 已完成：done", "2026-05-22T10:00:12.000Z"),
        event(3, "Goal 已暂停：其他 goal", "2026-05-22T10:00:13.000Z", "goal-2")
      ]
    )
  )

  assert(model, "complete goal should produce a panel model")
  assertEqual(model!.canPause, false, "complete goal cannot be paused")
  assertEqual(model!.canResume, false, "complete goal cannot be resumed")
  assertEqual(model!.progressPercent, 7, "turn progress should be rounded from turns/maxTurns")
  assertEqual(model!.verdictLabel, "完成", "complete verdict should be human readable")
  assertEqual(
    model!.evaluatorReason,
    "Evaluator verified the project explanation against actual source reads.",
    "complete panel should show evaluator reason"
  )
  assertEqual(
    model!.contextText,
    "启动附件：spec.md · 显式技能：docs",
    "panel should show durable launch context without paths"
  )
  assertArrayEqual(
    model!.progressItems,
    ["已解释项目结构", "已说明认证流程"],
    "progress ledger should be exposed"
  )
  assertArrayEqual(
    model!.evidenceItems,
    ["读取了 pom.xml", "读取了 AuthController.java"],
    "evidence ledger should be exposed"
  )
  assertEqual(model!.hasLedgerDetails, true, "ledger section should be considered populated")
  assertArrayEqual(
    model!.latestEvents.map((item) => item.event_id),
    [2, 1],
    "latest events should be filtered to the current goal and newest first"
  )
  assertEqual(model!.recentEventSummary, "Goal 已完成：done", "recent event summary should be cleaned")
}

function testPausedGoalPrefersPausedReasonAndShowsBlockers(): void {
  const model = buildGoalPanelViewModel(
    uiState(
      goal({
        status: "paused",
        lastVerdict: "blocked",
        lastReason: "Evaluator thinks the task needs more context.",
        pausedReason: "用户手动暂停。",
        ledger: {
          progress: [],
          evidence: [],
          blockers: ["需要确认目标范围", "等待用户补充项目路径"]
        }
      })
    )
  )

  assert(model, "paused goal should produce a panel model")
  assertEqual(model!.canPause, false, "paused goal cannot be paused again")
  assertEqual(model!.canResume, true, "paused goal can be resumed")
  assertEqual(model!.verdictLabel, "等待处理", "blocked verdict should be readable")
  assertEqual(model!.evaluatorReason, "用户手动暂停。", "paused reason should win over lastReason")
  assertArrayEqual(
    model!.blockerItems,
    ["需要确认目标范围", "等待用户补充项目路径"],
    "blockers should be exposed"
  )
}

function testPausedGoalLocalizesInternalReasons(): void {
  const model = buildGoalPanelViewModel(
    uiState(
      goal({
        status: "paused",
        lastVerdict: "blocked",
        lastReason: "Evaluator fallback reason should not win.",
        pausedReason: "user-paused"
      })
    )
  )

  assert(model, "paused goal should produce a panel model")
  assertEqual(model!.evaluatorReason, "已手动暂停。", "panel should localize internal pause code")

  assertEqual(
    displayGoalPanelPausedReason("WORKSPACE_REQUIRED"),
    "需要先选择工作区。",
    "workspace-required code should be localized"
  )
  assertEqual(
    displayGoalPanelPausedReason("needs_user_input:请确认项目路径。"),
    "请确认项目路径。",
    "needs_user_input prefix should be hidden"
  )
  assertEqual(
    displayGoalPanelPausedReason("Evaluator returned invalid JSON 3 turns in a row."),
    "评估器连续 3 轮输出格式无效。",
    "invalid JSON backstop should be localized"
  )
  assertEqual(
    displayGoalPanelPausedReason("Turn budget exhausted (2/2)."),
    "轮次预算已用尽（2/2）。",
    "budget pause reason should be localized"
  )
  assertEqual(
    displayGoalPanelPausedReason("Agent run failed: model timeout"),
    "Agent 运行失败：model timeout",
    "agent failure prefix should be localized"
  )
}

function testPausedGoalLocalizesLastReasonFallback(): void {
  const model = buildGoalPanelViewModel(
    uiState(
      goal({
        status: "paused",
        lastVerdict: "blocked",
        lastReason: "Goal evaluator model is not configured.",
        pausedReason: null
      })
    )
  )

  assert(model, "paused goal should produce a panel model")
  assertEqual(
    model!.evaluatorReason,
    "Goal 评估器模型未配置。",
    "paused lastReason fallback should also be localized"
  )
}

function testContextTextDoesNotDuplicateExplicitSkill(): void {
  const model = buildGoalPanelViewModel(
    uiState(
      goal({
        context: {
          transportSummary: "附件：spec.md；显式技能：audit",
          explicitSkill: { name: "audit", path: "/tmp/audit/SKILL.md" }
        }
      })
    )
  )

  assert(model, "goal with launch context should produce a panel model")
  assertEqual(
    model!.contextText,
    "附件：spec.md；显式技能：audit",
    "panel context should not append explicit skill when the transport summary already contains it"
  )
}

function testContextTextAddsExplicitSkillWhenMissingFromSummary(): void {
  const model = buildGoalPanelViewModel(
    uiState(
      goal({
        context: {
          transportSummary: "附件：spec.md",
          explicitSkill: { name: "audit", path: "/tmp/audit/SKILL.md" }
        }
      })
    )
  )

  assert(model, "goal with explicit skill should produce a panel model")
  assertEqual(
    model!.contextText,
    "附件：spec.md · 显式技能：audit",
    "panel context should still show explicit skill when the summary does not include it"
  )
}

function testActiveGoalFallbacksAreExplicit(): void {
  const model = buildGoalPanelViewModel(uiState(goal()))

  assert(model, "active goal should produce a panel model")
  assertEqual(model!.canPause, true, "active goal can be paused")
  assertEqual(model!.canResume, false, "active goal cannot be resumed")
  assertEqual(model!.verdictLabel, "尚未评估", "missing verdict should be explicit")
  assertEqual(
    model!.evaluatorReason,
    goalEmptyDetail("active"),
    "active goal should explain that evaluator has not judged yet"
  )
  assertEqual(model!.recentEventSummary, "暂无事件", "empty event list should be explicit")
  assertEqual(model!.hasLedgerDetails, false, "empty ledger should not look populated")
}

function testGoalPanelReturnsNullWithoutGoal(): void {
  assertEqual(
    buildGoalPanelViewModel(uiState(null)),
    null,
    "panel model should be absent when no goal is active or persisted"
  )
}

function testEventTextCleanupHidesPersistedUserPrefix(): void {
  assertEqual(
    cleanGoalEventText(`${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`),
    "/goal resume",
    "internal persisted-user prefix should not show in the panel"
  )
  assertEqual(
    cleanGoalEventText("Goal 已继续：讲解项目功能"),
    "Goal 已继续：讲解项目功能",
    "normal goal notices should stay readable"
  )
}

function testVerdictLabelsAreStable(): void {
  assertEqual(goalVerdictLabel("complete"), "完成", "complete label")
  assertEqual(goalVerdictLabel("continue"), "继续", "continue label")
  assertEqual(goalVerdictLabel("blocked"), "等待处理", "blocked label")
  assertEqual(goalVerdictLabel(null), "尚未评估", "missing verdict label")
  assertEqual(goalVerdictLabel("unexpected"), "尚未评估", "unknown verdict label")
}

function run(): void {
  const tests = [
    testCompleteGoalShowsEvaluatorReasonAndLedger,
    testPausedGoalPrefersPausedReasonAndShowsBlockers,
    testPausedGoalLocalizesInternalReasons,
    testPausedGoalLocalizesLastReasonFallback,
    testContextTextDoesNotDuplicateExplicitSkill,
    testContextTextAddsExplicitSkillWhenMissingFromSummary,
    testActiveGoalFallbacksAreExplicit,
    testGoalPanelReturnsNullWithoutGoal,
    testEventTextCleanupHidesPersistedUserPrefix,
    testVerdictLabelsAreStable
  ]

  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
}

run()
