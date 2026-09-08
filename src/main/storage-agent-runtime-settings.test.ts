import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AGENT_GRAPH_RECURSION_LIMIT_DEFAULT,
  WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT,
  WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT
} from "../shared/agent-runtime-limits"

const storeMock = vi.hoisted(() => ({
  constructorError: null as Error | null,
  get: vi.fn()
}))

vi.mock("electron", () => ({
  app: {}
}))

vi.mock("electron-store", () => ({
  default: class MockStore {
    constructor() {
      if (storeMock.constructorError) throw storeMock.constructorError
    }

    get(key: string): unknown {
      return storeMock.get(key)
    }
  }
}))

describe("stored agent runtime settings", () => {
  beforeEach(() => {
    storeMock.constructorError = null
    storeMock.get.mockReset()
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("falls back to defaults when the settings store cannot be opened", async () => {
    storeMock.constructorError = new SyntaxError("invalid settings.json")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const storage = await import("./storage")

    expect(storage.getStoredAgentGraphRecursionLimit()).toBe(AGENT_GRAPH_RECURSION_LIMIT_DEFAULT)
    expect(storage.getStoredWorkflowWorktreeTimeoutMinutes()).toBe(
      WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(storage.getStoredWorkflowWorktreeRemoveTimeoutMinutes()).toBe(
      WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it("falls back to defaults when reading the settings store fails", async () => {
    storeMock.get.mockImplementation(() => {
      throw Object.assign(new Error("settings temporarily unreadable"), { code: "EACCES" })
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const storage = await import("./storage")

    expect(storage.getStoredAgentGraphRecursionLimit()).toBe(AGENT_GRAPH_RECURSION_LIMIT_DEFAULT)
    expect(storage.getStoredWorkflowWorktreeTimeoutMinutes()).toBe(
      WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(storage.getStoredWorkflowWorktreeRemoveTimeoutMinutes()).toBe(
      WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
