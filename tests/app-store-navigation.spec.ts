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
    rightModule: "work",
    rightPanelCollapsed: true,
    rightPanelWorkRequestSequence: 0,
    rightPanelWorkRequest: null,
    workerFocusView: null,
    workerFocusMessagesThreadId: null,
    workerFocusMessages: []
  })
}

async function testBrowserPanelOpenRequestUsesGlobalStore(): Promise<void> {
  resetNavigationState()
  useAppStore.getState().requestOpenBrowserPanel()

  const state = useAppStore.getState()
  assert(
    state.rightModule === "browser" && !state.rightPanelCollapsed,
    "browser panel request should select the browser module and expand the right panel"
  )
}

async function testAgentsPanelOpenRequestExpandsRightPanel(): Promise<void> {
  resetNavigationState()
  useAppStore.getState().requestOpenRightPanelAgents("parent-thread")

  const state = useAppStore.getState()
  assert(!state.rightPanelCollapsed, "agents panel request should expand the right panel")
  assert(
    state.rightPanelWorkRequest?.target === "agents" &&
      state.rightPanelWorkRequest.threadId === "parent-thread",
    "agents panel request should target the current thread's agents section"
  )
}

async function testRightPanelWorkRequestIsConsumedOnce(): Promise<void> {
  resetNavigationState()
  useAppStore.getState().requestOpenRightPanelAgents("parent-thread")

  const firstRequestId = useAppStore.getState().rightPanelWorkRequest?.id
  assert(firstRequestId === 1, "first right-panel request should use the first sequence id")

  useAppStore.getState().consumeRightPanelWorkRequest(999)
  assert(
    useAppStore.getState().rightPanelWorkRequest?.id === firstRequestId,
    "a mismatched consumer must not clear a newer right-panel request"
  )

  useAppStore.getState().consumeRightPanelWorkRequest(firstRequestId)
  assert(
    useAppStore.getState().rightPanelWorkRequest === null,
    "a handled right-panel request should be cleared"
  )

  useAppStore.getState().requestOpenRightPanelAgents("parent-thread")
  assert(
    useAppStore.getState().rightPanelWorkRequest?.id === 2,
    "request ids should remain monotonic after a request is consumed"
  )
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
  await testBrowserPanelOpenRequestUsesGlobalStore()
  console.log("PASS browser panel open request uses global store")
  await testAgentsPanelOpenRequestExpandsRightPanel()
  console.log("PASS agents panel open request expands right panel")
  await testRightPanelWorkRequestIsConsumedOnce()
  console.log("PASS right panel work request is consumed once")
  await testHarnessBoardClearsWorkerFocus()
  console.log("PASS harness board clears worker focus")
  await testClaudeCodeMainViewClearsWorkerFocus()
  console.log("PASS Claude Code main view clears worker focus")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
