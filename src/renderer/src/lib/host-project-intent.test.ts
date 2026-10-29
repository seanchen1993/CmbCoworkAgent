import { afterEach, beforeEach, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  accountRevision: 1,
  threads: [
    {
      thread_id: "stage",
      metadata: {
        workspacePath: "C:/review",
        hostProjectRuntime: {
          projectId: "project",
          operationId: "operation",
          stageId: "review",
          pluginDigest: "a".repeat(64)
        }
      }
    }
  ],
  board: vi.fn()
}))
vi.mock("./store", () => ({
  useAppStore: {
    getState: () => ({
      ...state,
      setShowHarnessBoardView: state.board
    })
  }
}))
import {
  dismissHostProjectIntent,
  hostProjectIntentCurrent,
  openHostProjectFromThread,
  readHostProjectIntent
} from "./host-project-intent"

beforeEach(() => {
  state.accountRevision = 1
  state.board.mockClear()
})
afterEach(() => {
  const intent = readHostProjectIntent()
  if (intent) dismissHostProjectIntent(intent.id)
})

it("opens the exact project binding without entering a plugin creation flow", () => {
  openHostProjectFromThread("stage")
  const intent = readHostProjectIntent()!
  expect(intent.target).toMatchObject({
    threadId: "stage",
    projectId: "project",
    operationId: "operation"
  })
  expect(state.board).toHaveBeenCalledExactlyOnceWith(true)
  expect(hostProjectIntentCurrent(intent)).toBe(true)
  state.accountRevision++
  expect(hostProjectIntentCurrent(intent)).toBe(false)
})

it("rejects missing threads and retires a changed workspace or binding", () => {
  expect(() => openHostProjectFromThread("missing")).toThrow("HOST_PROJECT_NAVIGATION_CHANGED")
  expect(state.board).not.toHaveBeenCalled()
  openHostProjectFromThread("stage")
  const intent = readHostProjectIntent()!
  state.threads[0].metadata.workspacePath = "C:/other"
  expect(hostProjectIntentCurrent(intent)).toBe(false)
  state.threads[0].metadata.workspacePath = "C:/review"
  state.threads[0].metadata.hostProjectRuntime.operationId = "other"
  expect(hostProjectIntentCurrent(intent)).toBe(false)
  state.threads[0].metadata.hostProjectRuntime.operationId = "operation"
})

it("does not dismiss a newer navigation request when an earlier read completes", () => {
  openHostProjectFromThread("stage")
  const previous = readHostProjectIntent()!
  openHostProjectFromThread("stage")
  const next = readHostProjectIntent()!
  dismissHostProjectIntent(previous.id)
  expect(readHostProjectIntent()).toBe(next)
})
