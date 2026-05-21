/**
 * Regression tests for goal persistence in the real SQLite-backed app DB.
 *
 * Run:
 *   npx tsx tests/goals-db.spec.ts
 */

import initSqlJs from "sql.js"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { dirname, join } from "path"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected)
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
}

async function withTempHome(run: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), "cmb-goals-db-"))
  process.env.HOME = home
  try {
    await run()
  } finally {
    process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

async function testLegacyGoalTransportSummaryMigratesOnContextColumnUpgrade(): Promise<void> {
  const storage = await import("../src/main/storage.ts")
  const dbPath = storage.getDbPath()
  await mkdir(dirname(dbPath), { recursive: true })

  const SQL = await initSqlJs()
  const legacyDb = new SQL.Database()
  legacyDb.run(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      completion_condition TEXT,
      status TEXT NOT NULL,
      turns_used INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER NOT NULL DEFAULT 15,
      last_verdict TEXT,
      last_reason TEXT,
      paused_reason TEXT,
      consecutive_parse_failures INTEGER NOT NULL DEFAULT 0,
      ledger_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  legacyDb.run(
    `
      INSERT INTO thread_goals (
        thread_id, goal_id, objective, completion_condition, status, turns_used,
        max_turns, last_verdict, last_reason, paused_reason,
        consecutive_parse_failures, ledger_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      "legacy-summary",
      "goal-legacy",
      "写文档\n启动上下文摘要：附件：spec.md；显式技能：docs",
      "输出文档\n启动上下文摘要：附件：spec.md；显式技能：docs",
      "active",
      0,
      15,
      null,
      null,
      null,
      0,
      null,
      1_000,
      1_000
    ]
  )
  await writeFile(dbPath, Buffer.from(legacyDb.export()))
  legacyDb.close()

  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  await db.initializeDatabase()

  const migrated = new SqlGoalStore().get("legacy-summary")
  assert(migrated, "legacy goal should load after migration")
  assertEqual(migrated?.objective, "写文档", "legacy launch summary should leave objective")
  assertEqual(
    migrated?.completionCondition,
    "输出文档",
    "legacy launch summary should leave completion condition"
  )
  assertEqual(
    migrated?.context.transportSummary,
    "附件：spec.md；显式技能：docs",
    "legacy launch summary should migrate into goal context"
  )
  assertEqual(
    migrated?.context.legacyTransportSummaryMigration?.objective,
    "写文档\n启动上下文摘要：附件：spec.md；显式技能：docs",
    "legacy migration should keep original objective for audit/recovery"
  )

  db.closeDatabase()
}

async function testLegacyGoalTransportSummaryMigratesWhenContextColumnAlreadyExists(): Promise<void> {
  const storage = await import("../src/main/storage.ts")
  const dbPath = storage.getDbPath()
  await mkdir(dirname(dbPath), { recursive: true })

  const SQL = await initSqlJs()
  const legacyDb = new SQL.Database()
  legacyDb.run(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      completion_condition TEXT,
      context_json TEXT,
      status TEXT NOT NULL,
      turns_used INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER NOT NULL DEFAULT 15,
      last_verdict TEXT,
      last_reason TEXT,
      paused_reason TEXT,
      consecutive_parse_failures INTEGER NOT NULL DEFAULT 0,
      ledger_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  legacyDb.run(
    `
      INSERT INTO thread_goals (
        thread_id, goal_id, objective, completion_condition, context_json, status,
        turns_used, max_turns, last_verdict, last_reason, paused_reason,
        consecutive_parse_failures, ledger_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      "legacy-summary-existing-column",
      "goal-legacy-existing-column",
      "分析实现\n启动上下文摘要：附件：design.pdf",
      "完成后说明\n启动上下文摘要：附件：design.pdf",
      null,
      "paused",
      1,
      15,
      "continue",
      "Need more work.",
      "User paused.",
      0,
      null,
      2_000,
      2_000
    ]
  )
  legacyDb.run(
    `
      INSERT INTO thread_goals (
        thread_id, goal_id, objective, completion_condition, context_json, status,
        turns_used, max_turns, last_verdict, last_reason, paused_reason,
        consecutive_parse_failures, ledger_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      "legacy-summary-nonempty-context",
      "goal-legacy-nonempty-context",
      "检查实现\n启动上下文摘要：附件：api.md",
      "通过检查\n启动上下文摘要：附件：api.md",
      JSON.stringify({ explicitSkill: { name: "docs", path: "/tmp/SKILL.md" } }),
      "paused",
      1,
      15,
      "continue",
      "Need more work.",
      "User paused.",
      0,
      null,
      2_500,
      2_500
    ]
  )
  await writeFile(dbPath, Buffer.from(legacyDb.export()))
  legacyDb.close()

  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  await db.initializeDatabase()

  const migrated = new SqlGoalStore().get("legacy-summary-existing-column")
  assert(migrated, "legacy goal should load after idempotent migration")
  assertEqual(
    migrated?.objective,
    "分析实现",
    "idempotent migration should clean legacy objective"
  )
  assertEqual(
    migrated?.completionCondition,
    "完成后说明",
    "idempotent migration should clean legacy completion condition"
  )
  assertEqual(
    migrated?.context.transportSummary,
    "附件：design.pdf",
    "idempotent migration should backfill empty context_json"
  )

  const nonemptyContext = new SqlGoalStore().get("legacy-summary-nonempty-context")
  assert(nonemptyContext, "legacy goal with existing context should load after migration")
  assertEqual(
    nonemptyContext?.objective,
    "检查实现",
    "migration should clean objective even when context_json is non-empty"
  )
  assertEqual(
    nonemptyContext?.context.explicitSkill?.name,
    "docs",
    "migration should preserve existing context fields"
  )
  assertEqual(
    nonemptyContext?.context.transportSummary,
    "附件：api.md",
    "migration should add transport summary to non-empty context_json"
  )
  assertEqual(
    nonemptyContext?.context.legacyTransportSummaryMigration?.completionCondition,
    "通过检查\n启动上下文摘要：附件：api.md",
    "migration should keep original completion condition when context_json is non-empty"
  )
  if (!nonemptyContext) throw new Error("expected migrated goal with existing context")
  new SqlGoalStore().upsert({
    ...nonemptyContext,
    lastReason: "Persist backup after a normal goal writeback.",
    updatedAt: 3_000
  })
  await db.flush()
  db.closeDatabase()

  await db.initializeDatabase()
  const reloaded = new SqlGoalStore().get("legacy-summary-nonempty-context")
  assert(reloaded, "legacy migration backup should reload after a normal writeback")
  assertEqual(
    reloaded?.context.legacyTransportSummaryMigration?.objective,
    "检查实现\n启动上下文摘要：附件：api.md",
    "goal store writeback should preserve original migrated objective backup"
  )

  db.closeDatabase()
}

async function testSqlGoalStorePersistsAcrossDatabaseReopen(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  const { GoalManager } = await import("../src/main/agent/goals/goal-manager.ts")

  await db.initializeDatabase()
  db.createThread("thread-db", { title: "Goal DB regression" })

  const manager = new GoalManager(new SqlGoalStore(), 4)
  manager.set("thread-db", "finish persistent goal", {
    context: {
      explicitSkill: { name: "docs", path: "/tmp/SKILL.md" },
      transportSummary: "附件：spec.md；显式技能：docs"
    }
  })
  const outcome = manager.recordJudgeDecision("thread-db", {
    verdict: "continue",
    reason: "Need one more verification step.",
    ledgerPatch: {
      progress: ["implemented persistence path"],
      evidence: ["stored goal in thread_goals"]
    }
  })

  assert(outcome?.shouldContinue, "continue outcome should request another turn")
  await db.flush()
  db.closeDatabase()

  await db.initializeDatabase()
  const reloaded = new SqlGoalStore().get("thread-db")
  assert(reloaded, "goal should reload after closing and reopening the database")
  assertEqual(reloaded?.objective, "finish persistent goal", "objective should persist")
  assertEqual(reloaded?.turnsUsed, 1, "turn count should persist")
  assertEqual(
    reloaded?.context.explicitSkill?.name,
    "docs",
    "explicit skill name should persist"
  )
  assertEqual(
    reloaded?.context.explicitSkill?.path,
    "/tmp/SKILL.md",
    "explicit skill path should persist"
  )
  assertEqual(
    reloaded?.context.transportSummary,
    "附件：spec.md；显式技能：docs",
    "launch context summary should persist separately from objective text"
  )
  assertEqual(
    reloaded?.ledger.progress[0],
    "implemented persistence path",
    "ledger progress should persist"
  )
  assertEqual(
    reloaded?.ledger.evidence[0],
    "stored goal in thread_goals",
    "ledger evidence should persist"
  )

  db.closeDatabase()
}

async function testDeleteThreadDeletesGoal(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  const { GoalManager } = await import("../src/main/agent/goals/goal-manager.ts")

  await db.initializeDatabase()
  db.createThread("thread-delete", { title: "Delete goal regression" })

  const manager = new GoalManager(new SqlGoalStore(), 2)
  manager.set("thread-delete", "remove goal with thread")
  assert(manager.get("thread-delete"), "goal should exist before deleting the thread")

  db.deleteThread("thread-delete")
  assert(new SqlGoalStore().get("thread-delete") === null, "deleteThread should delete goal")

  db.closeDatabase()
}

async function testGoalEventsPersistAndDeleteWithThread(): Promise<void> {
  const db = await import("../src/main/db/index.ts")

  await db.initializeDatabase()
  db.createThread("thread-events", { title: "Goal events regression" })

  const first = db.addThreadGoalEvent("thread-events", "Goal 已设置", "goal-1", 1_000)
  const second = db.addThreadGoalEvent("thread-events", "Goal 已完成", "goal-1", 2_000)
  await db.flush()
  db.closeDatabase()

  await db.initializeDatabase()
  const events = db.getThreadGoalEvents("thread-events")
  assertEqual(events.length, 2, "goal events should reload after database reopen")
  assertEqual(events[0].event_id, first.event_id, "first event id should persist")
  assertEqual(events[1].event_id, second.event_id, "second event id should persist")
  assertEqual(events[0].message, "Goal 已设置", "first event message should persist")
  assertEqual(events[1].message, "Goal 已完成", "second event message should persist")

  db.deleteThread("thread-events")
  assertEqual(
    db.getThreadGoalEvents("thread-events").length,
    0,
    "deleteThread should remove goal events"
  )

  db.closeDatabase()
}

async function testReplacingSqlGoalRefreshesCreatedAt(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore, createNewGoal } = await import("../src/main/agent/goals/goal-store.ts")

  await db.initializeDatabase()
  db.createThread("thread-replace", { title: "Replace goal regression" })

  const store = new SqlGoalStore()
  const first = createNewGoal({
    threadId: "thread-replace",
    text: "first goal",
    maxTurns: 2,
    now: 1_000
  })
  const second = createNewGoal({
    threadId: "thread-replace",
    text: "second goal",
    maxTurns: 2,
    now: 5_000
  })

  store.upsert(first)
  store.upsert(second)

  const reloaded = store.get("thread-replace")
  assertEqual(reloaded?.goalId, second.goalId, "replacement goal id should persist")
  assertEqual(reloaded?.objective, "second goal", "replacement objective should persist")
  assertEqual(reloaded?.createdAt, 5_000, "replacement should reset created_at")

  db.closeDatabase()
}

async function testResumingSqlGoalRefreshesCreatedAtBaseline(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  const { GoalManager } = await import("../src/main/agent/goals/goal-manager.ts")

  await db.initializeDatabase()
  db.createThread("thread-resume-baseline", { title: "Resume baseline regression" })

  const manager = new GoalManager(new SqlGoalStore(), 2)
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now

  try {
    const started = manager.set("thread-resume-baseline", "resume should refresh baseline")
    now = 2_000
    manager.pause("thread-resume-baseline", "user-paused")
    now = 5_000
    const resumed = manager.resume("thread-resume-baseline")
    assertEqual(resumed?.status, "active", "resume should reactivate persisted goal")
    assert(
      resumed?.activeWindowId && resumed.activeWindowId !== started.activeWindowId,
      "resume should rotate persisted active_window_id"
    )
    assertEqual(resumed?.createdAt, 5_000, "resume should reset persisted created_at baseline")
    assertEqual(resumed?.updatedAt, 5_000, "resume should persist updated_at baseline")
  } finally {
    Date.now = originalNow
  }

  await db.flush()
  db.closeDatabase()

  await db.initializeDatabase()
  const reloaded = new SqlGoalStore().get("thread-resume-baseline")
  assertEqual(reloaded?.status, "active", "reloaded resumed goal should stay active")
  assertEqual(
    reloaded?.activeWindowId,
    manager.get("thread-resume-baseline")?.activeWindowId,
    "reloaded goal should keep refreshed active window id"
  )
  assertEqual(reloaded?.createdAt, 5_000, "reloaded goal should keep refreshed baseline")
  assertEqual(reloaded?.updatedAt, 5_000, "reloaded goal should keep refreshed update time")

  db.closeDatabase()
}

async function testResettingActiveSqlGoalRefreshesCreatedAtBaseline(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  const { GoalManager } = await import("../src/main/agent/goals/goal-manager.ts")

  await db.initializeDatabase()
  db.createThread("thread-active-resume-baseline", { title: "Active resume baseline regression" })

  const manager = new GoalManager(new SqlGoalStore(), 2)
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now

  try {
    manager.set("thread-active-resume-baseline", "orphaned active resume should refresh baseline")
    now = 2_000
    manager.recordJudgeDecision(
      "thread-active-resume-baseline",
      {
        verdict: "continue",
        reason: "first turn incomplete"
      }
    )
    now = 5_000
    const resumed = manager.resume("thread-active-resume-baseline", {
      resetActiveWindow: true
    })
    assertEqual(resumed?.status, "active", "reset active resume should keep active status")
    assertEqual(resumed?.turnsUsed, 0, "reset active resume should clear persisted turn usage")
    assertEqual(resumed?.createdAt, 5_000, "reset active resume should refresh created_at")
    assertEqual(resumed?.updatedAt, 5_000, "reset active resume should refresh updated_at")
  } finally {
    Date.now = originalNow
  }

  await db.flush()
  db.closeDatabase()

  await db.initializeDatabase()
  const reloaded = new SqlGoalStore().get("thread-active-resume-baseline")
  assertEqual(reloaded?.status, "active", "reloaded reset active goal should stay active")
  assertEqual(reloaded?.turnsUsed, 0, "reloaded reset active goal should keep cleared turns")
  assertEqual(reloaded?.createdAt, 5_000, "reloaded reset active goal should keep refreshed baseline")
  assertEqual(reloaded?.updatedAt, 5_000, "reloaded reset active goal should keep refreshed update time")

  db.closeDatabase()
}

async function testSqlGoalStorePausesRestoredActiveGoals(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  const { displayGoalPausedReason, GoalManager } = await import(
    "../src/main/agent/goals/goal-manager.ts"
  )

  await db.initializeDatabase()
  db.createThread("thread-runtime-restore", { title: "Runtime restore regression" })

  const store = new SqlGoalStore()
  const manager = new GoalManager(store, 2)
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now

  try {
    manager.set("thread-runtime-restore", "pause orphaned active goal after restart")
    now = 6_000
    const count = store.pauseActiveGoalsForRuntimeRestore("runtime restored active goal", now)
    assert(count >= 1, "runtime restore should pause active goals")
  } finally {
    Date.now = originalNow
  }

  const paused = store.get("thread-runtime-restore")
  assertEqual(paused?.status, "paused", "runtime restore should mark active goal as paused")
  assertEqual(
    paused?.pausedReason,
    "runtime restored active goal",
    "runtime restore should preserve machine-readable pause reason"
  )
  assertEqual(paused?.createdAt, 1_000, "runtime restore should not reset original start time")
  assertEqual(paused?.updatedAt, 6_000, "runtime restore should update pause time")
  assertEqual(
    displayGoalPausedReason(paused?.pausedReason),
    "应用重启后已暂停。继续请发送 /goal resume。",
    "runtime restore pause reason should be user-friendly"
  )
  const events = db.getThreadGoalEvents("thread-runtime-restore")
  assert(
    events.some(
      (event) =>
        event.goal_id === paused?.goalId &&
        event.message === "Goal 已暂停：应用重启后已暂停。继续请发送 /goal resume。"
    ),
    "runtime restore should add a goal event explaining the automatic pause"
  )

  db.closeDatabase()
}

async function testLegacyBudgetLimitedStatusNormalizesToPaused(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")

  await db.initializeDatabase()
  db.createThread("thread-legacy-budget", { title: "Legacy budget status regression" })
  db.getDb().run(
    `
      INSERT INTO thread_goals (
        thread_id, goal_id, objective, completion_condition, status,
        turns_used, max_turns, last_verdict, last_reason, paused_reason,
        consecutive_parse_failures, ledger_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      "thread-legacy-budget",
      "legacy-goal-1",
      "legacy goal",
      "legacy goal",
      "budget_limited",
      15,
      15,
      "blocked",
      "Turn budget exhausted.",
      null,
      0,
      JSON.stringify({ progress: [], evidence: [], blockers: [] }),
      1_000,
      2_000
    ]
  )
  await db.flush()
  db.closeDatabase()

  await db.initializeDatabase()
  const reloaded = new SqlGoalStore().get("thread-legacy-budget")
  assertEqual(reloaded?.status, "paused", "legacy budget_limited rows should normalize to paused")
  assertEqual(
    reloaded?.pausedReason,
    "Turn budget exhausted.",
    "legacy budget_limited rows should gain an explicit paused reason"
  )

  db.closeDatabase()
}

async function testGoalJudgeModelSettings(): Promise<void> {
  const storage = await import("../src/main/storage.ts")
  const evaluator = await import("../src/main/agent/goals/evaluator.ts")
  const { createNewGoal } = await import("../src/main/agent/goals/goal-store.ts")

  const goal = createNewGoal({
    threadId: "thread-judge",
    text: "reply done",
    maxTurns: 1,
    now: 1_000
  })

  storage.setGoalSettings({})
  const noConfigDecision = await evaluator.evaluateGoalWithModel({
    goal,
    assistantResponse: "done",
    toolCalls: [],
    toolEvidence: [],
    usedSkills: []
  })
  assertEqual(noConfigDecision.verdict, "blocked", "missing evaluator config should pause")

  storage.upsertCustomModelConfig({
    id: "main-model",
    name: "Main Model",
    baseUrl: "https://example.com/v1",
    model: "main-model",
    apiKey: "main-key",
    maxTokens: 128_000,
    maxOutputTokens: 8_192,
    temperature: 0.1
  })
  storage.upsertCustomModelConfig({
    id: "judge-model",
    name: "Judge Model",
    baseUrl: "https://example.com/v1",
    model: "judge-model",
    apiKey: "judge-key",
    maxTokens: 128_000,
    maxOutputTokens: 8_192,
    temperature: 0.1
  })

  storage.setGoalSettings({})
  assertEqual(
    evaluator.resolveEvaluatorConfig("custom:main-model")?.id,
    "main-model",
    "default evaluator should use current effective model first"
  )
  assertEqual(
    evaluator.resolveEvaluatorConfig("custom:missing-model"),
    null,
    "default evaluator should not fall back to a different provider"
  )

  storage.setGoalSettings({ evaluatorModelId: "custom:judge-model" })
  assertEqual(
    evaluator.resolveEvaluatorConfig("custom:main-model")?.id,
    "judge-model",
    "configured evaluator should override current model"
  )
  storage.setGoalSettings({ evaluatorModelId: "custom:missing-judge" })
  assertEqual(
    evaluator.resolveEvaluatorConfig("custom:main-model"),
    null,
    "misconfigured explicit evaluator should block instead of silently changing providers"
  )
  assertEqual(
    evaluator.resolveEvaluatorConfig("custom:missing-model"),
    null,
    "misconfigured explicit evaluator should still block when the current model is unavailable"
  )
}

async function main(): Promise<void> {
  const tests = [
    testLegacyGoalTransportSummaryMigratesOnContextColumnUpgrade,
    testLegacyGoalTransportSummaryMigratesWhenContextColumnAlreadyExists,
    testSqlGoalStorePersistsAcrossDatabaseReopen,
    testDeleteThreadDeletesGoal,
    testGoalEventsPersistAndDeleteWithThread,
    testReplacingSqlGoalRefreshesCreatedAt,
    testResumingSqlGoalRefreshesCreatedAtBaseline,
    testResettingActiveSqlGoalRefreshesCreatedAtBaseline,
    testSqlGoalStorePausesRestoredActiveGoals,
    testLegacyBudgetLimitedStatusNormalizesToPaused,
    testGoalJudgeModelSettings
  ]
  await withTempHome(async () => {
    for (const test of tests) {
      await test()
      console.log(`✓ ${test.name}`)
    }
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
