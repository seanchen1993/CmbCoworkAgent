/**
 * Fast Electron IPC integration tests for Goals.
 *
 * Default run is deterministic and does not call an LLM:
 *   npx tsx tests/goal-ipc-e2e.spec.ts
 *
 * Optional real-model smoke test:
 *   RUN_GOAL_E2E_REAL_MODEL=1 GOAL_E2E_MODEL_ID=custom:deepseek-chat npx tsx tests/goal-ipc-e2e.spec.ts
 *
 * Prereq:
 *   npm run build
 */

import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { existsSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

const PROJECT_ROOT = path.resolve(__dirname, "..")
const ELECTRON_BIN = path.join(PROJECT_ROOT, "node_modules", ".bin", "electron")
const MAIN_ENTRY = path.join(PROJECT_ROOT, "out", "main", "index.js")
const DEFAULT_WORKSPACE = PROJECT_ROOT
const DEFAULT_MODEL_ID = "custom:deepseek-chat"

interface Thread {
  thread_id?: string
  id?: string
  threadId?: string
}

interface GoalEvent {
  event_id: number
  message: string
  goal_id: string | null
}

interface InvokeEvent {
  type: string
  error?: string
  message?: string
}

interface WindowWithApi {
  api: {
    agent: {
      invoke: (
        threadId: string,
        message: string,
        onEvent: (event: InvokeEvent) => void,
        modelId?: string
      ) => () => void
      goalControl: (
        threadId: string,
        message: string
      ) => Promise<{ handled: boolean; terminatedCurrentRun: boolean }>
    }
    threads: {
      create: (metadata?: Record<string, unknown>) => Promise<Thread>
      delete: (threadId: string) => Promise<void>
      getHistory: (threadId: string) => Promise<unknown[]>
      getGoalEvents: (threadId: string) => Promise<GoalEvent[]>
      getGoalState: (threadId: string) => Promise<{
        goal: null | {
          status: "active" | "paused" | "complete"
          activeWindowId: string
          turnsUsed: number
          pausedReason: string | null
          lastReason: string | null
          ledger: { progress: string[]; evidence: string[]; blockers: string[] }
        }
      }>
    }
    models: {
      getGoalSettings: () => Promise<{ evaluatorModelId?: string }>
      setGoalSettings: (settings: { evaluatorModelId?: string }) => Promise<void>
    }
    workspace: {
      set: (threadId: string, workspacePath: string) => Promise<unknown>
    }
  }
}

interface InvokeResult {
  events: InvokeEvent[]
  timedOut?: boolean
}

async function seedPausedGoalThread(threadId: string): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { createNewGoal, SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")

  await db.initializeDatabase()
  db.deleteThread(threadId)
  db.createThread(threadId, {
    workspacePath: process.env.GOAL_E2E_WORKSPACE || DEFAULT_WORKSPACE,
    model: process.env.GOAL_E2E_MODEL_ID || DEFAULT_MODEL_ID,
    title: "Goal IPC E2E - resume evaluator preflight"
  })

  const now = Date.now() - 60_000
  const goal = createNewGoal({
    threadId,
    text: "这个 paused goal 不应该被不可用 evaluator 的 resume 重置。",
    maxTurns: 15
  })
  new SqlGoalStore().upsert({
    ...goal,
    activeWindowId: "goal-ipc-e2e-paused-window-before-resume",
    status: "paused",
    turnsUsed: 4,
    pausedReason: "user-paused",
    lastReason: "等待用户手动继续。",
    createdAt: now,
    updatedAt: now
  })
  await db.flush()
  db.closeDatabase()
}

function log(message: string): void {
  console.log(`[goal-ipc ${new Date().toISOString().slice(11, 19)}] ${message}`)
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`No built output at ${MAIN_ENTRY}; run npm run build first`)
  }

  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [MAIN_ENTRY],
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    timeout: 60_000
  })
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await page.waitForFunction(() => Boolean((window as unknown as Partial<WindowWithApi>).api), {
    timeout: 30_000
  })
  await page.evaluate(() => {
    ;(globalThis as unknown as { __name?: <T>(value: T) => T }).__name ??= (value) => value
  })
  return { app, page }
}

async function createThread(page: Page, title: string): Promise<string> {
  return await page.evaluate<string, { workspace: string; title: string; modelId: string }>(
    async ({ workspace, title, modelId }) => {
      const api = (window as unknown as WindowWithApi).api
      const thread = await api.threads.create({ workspacePath: workspace, model: modelId, title })
      const threadId = thread.thread_id || thread.id || thread.threadId
      if (!threadId) throw new Error(`threads.create returned no id: ${JSON.stringify(thread)}`)
      await api.workspace.set(threadId, workspace)
      return threadId
    },
    {
      workspace: process.env.GOAL_E2E_WORKSPACE || DEFAULT_WORKSPACE,
      title,
      modelId: process.env.GOAL_E2E_MODEL_ID || DEFAULT_MODEL_ID
    }
  )
}

async function deleteThread(page: Page, threadId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await (window as unknown as WindowWithApi).api.threads.delete(id)
  }, threadId)
}

async function testGoalControlCommandsDoNotTouchCheckpoint(page: Page): Promise<void> {
  const threadId = await createThread(page, "Goal IPC E2E - control commands")
  try {
    const result = await page.evaluate(async (id) => {
      const api = (window as unknown as WindowWithApi).api
      const historyBefore = await api.threads.getHistory(id)
      const statusResult = await api.agent.goalControl(id, "/goal status")
      const pauseResult = await api.agent.goalControl(id, "/goal pause")
      const clearResult = await api.agent.goalControl(id, "/goal clear")
      const resumeResult = await api.agent.goalControl(id, "/goal resume")
      const historyAfter = await api.threads.getHistory(id)
      const events = await api.threads.getGoalEvents(id)
      return {
        statusResult,
        pauseResult,
        clearResult,
        resumeResult,
        historyBeforeCount: historyBefore.length,
        historyAfterCount: historyAfter.length,
        events: events.map((event) => ({
          event_id: event.event_id,
          message: event.message,
          goal_id: event.goal_id
        }))
      }
    }, threadId)

    assertEqual(result.statusResult.handled, true, "/goal status should be handled by goalControl")
    assertEqual(
      result.statusResult.terminatedCurrentRun,
      false,
      "/goal status should not terminate a run"
    )
    assertEqual(result.pauseResult.handled, true, "/goal pause should be handled by goalControl")
    assertEqual(
      result.pauseResult.terminatedCurrentRun,
      false,
      "/goal pause without active goal should not terminate a run"
    )
    assertEqual(result.clearResult.handled, true, "/goal clear should be handled by goalControl")
    assertEqual(
      result.clearResult.terminatedCurrentRun,
      false,
      "/goal clear without active goal should not terminate a run"
    )
    assertEqual(
      result.resumeResult.handled,
      false,
      "/goal resume should not be accepted by side-channel goalControl"
    )
    assertEqual(
      result.resumeResult.terminatedCurrentRun,
      false,
      "/goal resume side-channel rejection should not terminate a run"
    )
    assertEqual(
      result.historyAfterCount,
      result.historyBeforeCount,
      "goal side-channel controls must not write LangGraph checkpoint messages"
    )
    assert(
      result.events.some((event) => event.message === "__cmb_goal_user_message__:/goal status"),
      "/goal status should preserve the exact user command as a goal event"
    )
    assert(
      result.events.some((event) => event.message === "__cmb_goal_user_message__:/goal pause"),
      "/goal pause should preserve the exact user command as a goal event"
    )
    assert(
      result.events.some((event) => event.message === "__cmb_goal_user_message__:/goal clear"),
      "/goal clear should preserve the exact user command as a goal event"
    )
    assert(
      !result.events.some((event) => event.message === "__cmb_goal_user_message__:/goal resume"),
      "/goal resume rejected by side-channel goalControl should not persist a stale user event"
    )
    assert(
      result.events.some((event) => event.message.includes("当前没有 active goal")),
      "side-channel controls should persist readable Goal panel notices"
    )
    log("PASS goal side-channel controls do not touch checkpoint history")
  } finally {
    await deleteThread(page, threadId)
  }
}

async function testGoalSetPreflightRejectsUnavailableEvaluator(page: Page): Promise<void> {
  const threadId = await createThread(page, "Goal IPC E2E - evaluator preflight")
  try {
    const result = await page.evaluate<
      Promise<{
        invokeResult: InvokeResult
        goal: unknown
        historyCount: number
        events: string[]
      }>,
      { id: string }
    >(
      async ({ id }) => {
        const api = (window as unknown as WindowWithApi).api
        const previousGoalSettings = await api.models.getGoalSettings()
        await api.models.setGoalSettings({ evaluatorModelId: "custom:missing-goal-e2e-judge" })
        try {
          const invokeResult = await new Promise<InvokeResult>((resolve) => {
            const events: InvokeEvent[] = []
            let cleanup = (): void => {}
            const timeout = window.setTimeout(() => {
              cleanup()
              resolve({ events, timedOut: true })
            }, 30_000)

            cleanup = api.agent.invoke(
              id,
              "/goal 这个 goal 不应该启动，因为 evaluator 配置不可用。",
              (event) => {
                events.push(event)
                if (event.type === "done" || event.type === "error") {
                  window.clearTimeout(timeout)
                  cleanup()
                  resolve({ events })
                }
              },
              "custom:deepseek-chat"
            )
          })
          const goalState = await api.threads.getGoalState(id)
          const history = await api.threads.getHistory(id)
          const goalEvents = await api.threads.getGoalEvents(id)
          return {
            invokeResult,
            goal: goalState.goal,
            historyCount: history.length,
            events: goalEvents.map((event) => event.message)
          }
        } finally {
          await api.models.setGoalSettings(previousGoalSettings)
        }
      },
      { id: threadId }
    )

    assert(!result.invokeResult.timedOut, "unavailable evaluator preflight should finish promptly")
    assert(
      result.invokeResult.events.some(
        (event) => event.type === "error" && event.error === "GOAL_EVALUATOR_UNAVAILABLE"
      ),
      "unavailable evaluator should emit GOAL_EVALUATOR_UNAVAILABLE before starting"
    )
    assertEqual(result.goal, null, "unavailable evaluator must not create a goal")
    assertEqual(result.historyCount, 0, "unavailable evaluator must not write checkpoint history")
    assert(
      !result.events.some((message) => message.startsWith("__cmb_goal_user_message__:/goal")),
      "unavailable evaluator must not persist a /goal user event"
    )
    assert(
      !result.events.some((message) => message.includes("Goal 已设置")),
      "unavailable evaluator must not persist Goal set notice"
    )
    log("PASS unavailable evaluator preflight rejects goal set without side effects")
  } finally {
    await deleteThread(page, threadId)
  }
}

async function testGoalResumePreflightKeepsPausedGoal(
  page: Page,
  threadId: string
): Promise<void> {
  try {
    const result = await page.evaluate<
      Promise<{
        invokeResult: InvokeResult
        before: NonNullable<
          Awaited<ReturnType<WindowWithApi["api"]["threads"]["getGoalState"]>>["goal"]
        >
        after: NonNullable<
          Awaited<ReturnType<WindowWithApi["api"]["threads"]["getGoalState"]>>["goal"]
        >
        historyBeforeCount: number
        historyAfterCount: number
        events: string[]
      }>,
      { id: string }
    >(
      async ({ id }) => {
        const api = (window as unknown as WindowWithApi).api
        const previousGoalSettings = await api.models.getGoalSettings()
        await api.models.setGoalSettings({ evaluatorModelId: "custom:missing-goal-e2e-judge" })
        try {
          const beforeState = await api.threads.getGoalState(id)
          if (!beforeState.goal) throw new Error("seeded paused goal missing before resume")
          const historyBefore = await api.threads.getHistory(id)
          const invokeResult = await new Promise<InvokeResult>((resolve) => {
            const events: InvokeEvent[] = []
            let cleanup = (): void => {}
            const timeout = window.setTimeout(() => {
              cleanup()
              resolve({ events, timedOut: true })
            }, 30_000)

            cleanup = api.agent.invoke(
              id,
              "/goal resume",
              (event) => {
                events.push(event)
                if (event.type === "done" || event.type === "error") {
                  window.clearTimeout(timeout)
                  cleanup()
                  resolve({ events })
                }
              },
              "custom:deepseek-chat"
            )
          })
          const afterState = await api.threads.getGoalState(id)
          if (!afterState.goal) throw new Error("seeded paused goal missing after resume")
          const historyAfter = await api.threads.getHistory(id)
          const goalEvents = await api.threads.getGoalEvents(id)
          return {
            invokeResult,
            before: beforeState.goal,
            after: afterState.goal,
            historyBeforeCount: historyBefore.length,
            historyAfterCount: historyAfter.length,
            events: goalEvents.map((event) => event.message)
          }
        } finally {
          await api.models.setGoalSettings(previousGoalSettings)
        }
      },
      { id: threadId }
    )

    assert(!result.invokeResult.timedOut, "unavailable evaluator resume preflight should finish promptly")
    assert(
      result.invokeResult.events.some(
        (event) => event.type === "error" && event.error === "GOAL_EVALUATOR_UNAVAILABLE"
      ),
      "unavailable evaluator resume should emit GOAL_EVALUATOR_UNAVAILABLE"
    )
    assertEqual(result.before.status, "paused", "seeded goal should start paused")
    assertEqual(result.after.status, "paused", "unavailable evaluator must keep goal paused")
    assertEqual(
      result.after.activeWindowId,
      result.before.activeWindowId,
      "unavailable evaluator must not reset activeWindowId on resume"
    )
    assertEqual(
      result.after.turnsUsed,
      result.before.turnsUsed,
      "unavailable evaluator must not reset turnsUsed on resume"
    )
    assertEqual(
      result.after.pausedReason,
      result.before.pausedReason,
      "unavailable evaluator must not clear paused reason on resume"
    )
    assertEqual(
      result.historyAfterCount,
      result.historyBeforeCount,
      "unavailable evaluator resume must not write checkpoint history"
    )
    assert(
      !result.events.some((message) => message === "__cmb_goal_user_message__:/goal resume"),
      "unavailable evaluator resume must not persist a stale /goal resume event"
    )
    assert(
      !result.events.some((message) => message.includes("Goal 已继续")),
      "unavailable evaluator resume must not persist Goal resumed notice"
    )
    log("PASS unavailable evaluator preflight rejects goal resume without resetting paused goal")
  } finally {
    await deleteThread(page, threadId)
  }
}

async function testRealModelGoalCompletionSmoke(page: Page): Promise<void> {
  if (process.env.RUN_GOAL_E2E_REAL_MODEL !== "1") {
    log("SKIP real-model goal completion smoke; set RUN_GOAL_E2E_REAL_MODEL=1 to run it")
    return
  }

  const modelId = process.env.GOAL_E2E_MODEL_ID || DEFAULT_MODEL_ID
  const threadId = await createThread(page, "Goal IPC E2E - real model smoke")
  try {
    const result = await page.evaluate(
      async ({ id, modelId }) => {
        const api = (window as unknown as WindowWithApi).api
        const invokeResult = await new Promise<{ done: boolean; error?: string }>((resolve) => {
          const cleanup = api.agent.invoke(
            id,
            '/goal 只回复 "goals playwright e2e passed"。完成标准：最终回复必须包含 "goals playwright e2e passed"。不要修改任何文件。',
            (event) => {
              if (event.type === "done") {
                cleanup()
                resolve({ done: true })
              }
              if (event.type === "error") {
                cleanup()
                resolve({ done: false, error: event.error || event.message || "unknown error" })
              }
            },
            modelId
          )
          window.setTimeout(() => {
            cleanup()
            resolve({ done: false, error: "timeout" })
          }, 180_000)
        })
        const goalState = await api.threads.getGoalState(id)
        const historyBeforeStatus = await api.threads.getHistory(id)
        const statusResult = await api.agent.goalControl(id, "/goal status")
        const historyAfterStatus = await api.threads.getHistory(id)
        const events = await api.threads.getGoalEvents(id)
        return {
          invokeResult,
          goal: goalState.goal,
          statusResult,
          historyBeforeStatusCount: historyBeforeStatus.length,
          historyAfterStatusCount: historyAfterStatus.length,
          events: events.map((event) => event.message)
        }
      },
      { id: threadId, modelId }
    )

    assert(result.invokeResult.done, `real model goal did not finish: ${result.invokeResult.error}`)
    assertEqual(result.goal?.status, "complete", "real model goal should complete")
    assertEqual(result.goal?.turnsUsed, 1, "simple direct goal should use one goal turn")
    assertEqual(result.statusResult.handled, true, "/goal status should be handled after completion")
    assertEqual(
      result.historyAfterStatusCount,
      result.historyBeforeStatusCount,
      "/goal status after completion must not mutate checkpoint history"
    )
    assert(
      result.events.some((message) => message.includes("Goal 已完成")),
      "completion notice should be persisted for the Goal panel"
    )
    log("PASS real-model goal completion smoke")
  } finally {
    await deleteThread(page, threadId)
  }
}

async function main(): Promise<void> {
  const previousHome = process.env.HOME
  const isolatedHome = await mkdtemp(path.join(tmpdir(), "cmb-goal-ipc-e2e-"))
  try {
    process.env.HOME = isolatedHome
    const resumePreflightThreadId = `goal-ipc-resume-preflight-${Date.now()}`
    await seedPausedGoalThread(resumePreflightThreadId)
    log(`Using isolated HOME for Goal IPC E2E: ${isolatedHome}`)
    log("Launching Electron app")
    let app: ElectronApplication | undefined
    try {
      const launched = await launchApp()
      app = launched.app
      await testGoalSetPreflightRejectsUnavailableEvaluator(launched.page)
      await testGoalResumePreflightKeepsPausedGoal(launched.page, resumePreflightThreadId)
      await testGoalControlCommandsDoNotTouchCheckpoint(launched.page)
      await testRealModelGoalCompletionSmoke(launched.page)
      log("All goal IPC E2E tests passed")
    } finally {
      if (app) await app.close().catch(() => {})
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(isolatedHome, { recursive: true, force: true })
  }
}

main().catch((error: Error) => {
  console.error(`\n❌ ${error.stack || error.message}`)
  process.exit(1)
})
