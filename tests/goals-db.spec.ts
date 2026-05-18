/**
 * Regression tests for goal persistence in the real SQLite-backed app DB.
 *
 * Run:
 *   npx tsx tests/goals-db.spec.ts
 */

import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

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

async function testSqlGoalStorePersistsAcrossDatabaseReopen(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  const { GoalManager } = await import("../src/main/agent/goals/goal-manager.ts")

  await db.initializeDatabase()
  db.createThread("thread-db", { title: "Goal DB regression" })

  const manager = new GoalManager(new SqlGoalStore(), 4)
  manager.set("thread-db", "finish persistent goal")
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
    "misconfigured explicit evaluator should not silently fall back"
  )
}

async function main(): Promise<void> {
  const tests = [
    testSqlGoalStorePersistsAcrossDatabaseReopen,
    testDeleteThreadDeletesGoal,
    testGoalEventsPersistAndDeleteWithThread,
    testReplacingSqlGoalRefreshesCreatedAt,
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
