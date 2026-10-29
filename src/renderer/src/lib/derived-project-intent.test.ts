import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { HarnessProjectListItem } from "../../../shared/harness-board-types"

const state = vi.hoisted(() => ({
  accountRevision: 1,
  currentThreadId: "origin",
  showCustomizeView: false,
  threads: [{ thread_id: "origin", metadata: { workspacePath: "C:/origin" } }],
  customize: vi.fn(),
  board: vi.fn()
}))
vi.mock("./store", () => ({
  useAppStore: {
    getState: () => ({
      ...state,
      setShowCustomizeView: state.customize,
      setShowHarnessBoardView: state.board
    })
  }
}))
import {
  consumeDerivedProjectIntent,
  derivedProjectIntentCurrent,
  dismissDerivedProject,
  openDerivedProject,
  openExistingPluginProject,
  readDerivedProjectIntent
} from "./derived-project-intent"

const scope = { threadId: "origin", expectedWorkspace: "C:/origin" }
beforeEach(() => {
  state.accountRevision = 1
  state.threads[0].metadata.workspacePath = "C:/origin"
  vi.clearAllMocks()
})
afterEach(() => {
  const intent = readDerivedProjectIntent()
  if (intent) dismissDerivedProject(intent.id)
})

it.each([undefined, scope])(
  "discards an old account's pending project entry with scope %j",
  (scope) => {
    openDerivedProject("installed", "Installed", scope)
    const intent = readDerivedProjectIntent()!
    expect(derivedProjectIntentCurrent(intent)).toBe(true)
    state.accountRevision++
    expect(derivedProjectIntentCurrent(intent)).toBe(false)
    expect(consumeDerivedProjectIntent(intent)).toBeNull()
    expect(readDerivedProjectIntent()).toBeNull()
  }
)

it("consumes a creation request once and keeps its source guard valid during the form", () => {
  const origin = { ...scope }
  openDerivedProject("installed", "Installed", origin)
  const intent = readDerivedProjectIntent()!
  origin.expectedWorkspace = "C:/caller-mutated"
  const source = consumeDerivedProjectIntent(intent)!
  expect(readDerivedProjectIntent()).toBeNull()
  expect(consumeDerivedProjectIntent(intent)).toBeNull()
  expect(derivedProjectIntentCurrent(source)).toBe(true)
  state.threads[0].metadata.workspacePath = "C:/changed"
  expect(derivedProjectIntentCurrent(source)).toBe(false)
})

it("does not replay a submitted source after an account change or dismiss a newer request", async () => {
  openDerivedProject("first", "First", scope)
  const first = consumeDerivedProjectIntent(readDerivedProjectIntent()!)!
  const deferred = Promise.withResolvers<void>()
  let deliveries = 0
  const submitted = deferred.promise.then(() => {
    if (derivedProjectIntentCurrent(first)) deliveries++
  })
  state.accountRevision++
  openDerivedProject("second", "Second")
  const second = readDerivedProjectIntent()!
  expect(consumeDerivedProjectIntent(first)).toBeNull()
  expect(readDerivedProjectIntent()).toBe(second)
  deferred.resolve()
  await submitted
  expect(deliveries).toBe(0)
  expect(readDerivedProjectIntent()).toBe(second)
})

it("applies the same account expiry to navigation back to an existing legacy project", () => {
  const project = {
    projectId: "project",
    name: "Project",
    harnessAdapter: { type: "plugin", id: "installed" }
  } as HarnessProjectListItem
  openExistingPluginProject(project, scope)
  const intent = readDerivedProjectIntent()!
  expect(intent.projectId).toBe("project")
  expect(intent.accountRevision).toBe(1)
  state.accountRevision++
  expect(consumeDerivedProjectIntent(intent)).toBeNull()
  expect(readDerivedProjectIntent()).toBeNull()
})
