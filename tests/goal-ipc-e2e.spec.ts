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
          turnsUsed: number
          lastReason: string | null
          ledger: { progress: string[]; evidence: string[]; blockers: string[] }
        }
      }>
    }
    workspace: {
      set: (threadId: string, workspacePath: string) => Promise<unknown>
    }
  }
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
    timeout: 60_000
  })
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await page.waitForFunction(() => Boolean((window as unknown as Partial<WindowWithApi>).api), {
    timeout: 30_000
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
  log("Launching Electron app")
  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp()
    app = launched.app
    await testGoalControlCommandsDoNotTouchCheckpoint(launched.page)
    await testRealModelGoalCompletionSmoke(launched.page)
    log("All goal IPC E2E tests passed")
  } finally {
    if (app) await app.close().catch(() => {})
  }
}

main().catch((error: Error) => {
  console.error(`\n❌ ${error.stack || error.message}`)
  process.exit(1)
})
