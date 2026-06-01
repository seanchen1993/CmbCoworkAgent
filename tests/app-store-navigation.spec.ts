/**
 * Regression tests for top-level app navigation state.
 *
 * Run:
 *   npx -y tsx tests/app-store-navigation.spec.ts
 */

import { useAppStore, type WorkerFocusView } from "../src/renderer/src/lib/store.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const workerFocusView: WorkerFocusView = {
  threadId: "parent-thread",
  workerId: "worker-1",
  workerThreadId: "worker-thread-1",
  role: "implementer",
  description: "Inspect worker",
  status: "running"
}

function resetNavigationState(): void {
  useAppStore.setState({
    mainView: "thread",
    currentThreadId: "parent-thread",
    previousThreadId: null,
    showHarnessBoardView: false,
    showClaudeCodeView: false,
    showCustomizeView: false,
    showDashboardView: false,
    showKanbanView: false,
    workerFocusView: null,
    workerFocusMessagesThreadId: null,
    workerFocusMessages: []
  })
}

async function testHarnessBoardClearsWorkerFocus(): Promise<void> {
  resetNavigationState()
  useAppStore.getState().openWorkerFocusView(workerFocusView)

  useAppStore.getState().setShowHarnessBoardView(true)

  const state = useAppStore.getState()
  assert(state.mainView === "harness", "harness board should become the main view")
  assert(state.workerFocusView === null, "harness board navigation must close worker focus")
  assert(
    state.workerFocusMessagesThreadId === null && state.workerFocusMessages.length === 0,
    "harness board navigation must clear worker focus messages"
  )
}

async function testClaudeCodeMainViewClearsWorkerFocus(): Promise<void> {
  resetNavigationState()
  useAppStore.getState().openWorkerFocusView(workerFocusView)

  useAppStore.getState().setMainView("claudecode")

  const state = useAppStore.getState()
  assert(state.mainView === "claudecode", "Claude Code should become the main view")
  assert(state.workerFocusView === null, "Claude Code navigation must close worker focus")
  assert(
    state.workerFocusMessagesThreadId === null && state.workerFocusMessages.length === 0,
    "Claude Code navigation must clear worker focus messages"
  )
}

async function run(): Promise<void> {
  await testHarnessBoardClearsWorkerFocus()
  console.log("PASS harness board clears worker focus")
  await testClaudeCodeMainViewClearsWorkerFocus()
  console.log("PASS Claude Code main view clears worker focus")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
