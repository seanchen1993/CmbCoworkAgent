import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AGENT_GRAPH_RECURSION_LIMIT_DEFAULT,
  WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT,
  WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT
} from "../shared/agent-runtime-limits"

const storeMock = vi.hoisted(() => ({
  constructorError: null as Error | null,
  get: vi.fn(),
  set: vi.fn()
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

    set(key: string, value: unknown): void {
      storeMock.set(key, value)
    }
  }
}))

describe("stored agent runtime settings", () => {
  beforeEach(() => {
    storeMock.constructorError = null
    storeMock.get.mockReset()
    storeMock.set.mockReset()
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
    expect(storage.getStoredAgentToolStrategy()).toBe("standard")
    expect(storage.getStoredWorkflowWorktreeTimeoutMinutes()).toBe(
      WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(storage.getStoredWorkflowWorktreeRemoveTimeoutMinutes()).toBe(
      WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(warn).toHaveBeenCalledTimes(4)
  })

  it("falls back to defaults when reading the settings store fails", async () => {
    storeMock.get.mockImplementation(() => {
      throw Object.assign(new Error("settings temporarily unreadable"), { code: "EACCES" })
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const storage = await import("./storage")

    expect(storage.getStoredAgentGraphRecursionLimit()).toBe(AGENT_GRAPH_RECURSION_LIMIT_DEFAULT)
    expect(storage.getStoredAgentToolStrategy()).toBe("standard")
    expect(storage.getStoredWorkflowWorktreeTimeoutMinutes()).toBe(
      WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(storage.getStoredWorkflowWorktreeRemoveTimeoutMinutes()).toBe(
      WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(warn).toHaveBeenCalledTimes(4)
  })

  it("keeps old/invalid stored settings off, and validates before writing", async () => {
    const storage = await import("./storage")
    for (const value of [undefined, null, {}, true, "strict", ""]) {
      storeMock.get.mockReturnValue(value)
      expect(storage.getStoredAgentToolStrategy()).toBe("standard")
      expect(() => storage.setStoredAgentToolStrategy(value)).toThrow("Invalid agent tool strategy")
    }
    expect(storeMock.set).not.toHaveBeenCalled()
    for (const value of ["standard", "shell-first", "shell-first-relaxed"]) {
      storeMock.get.mockReturnValue(value)
      expect(storage.getStoredAgentToolStrategy()).toBe(value)
      expect(storage.setStoredAgentToolStrategy(value)).toBe(value)
      expect(storeMock.set).toHaveBeenLastCalledWith("agentToolStrategy", value)
    }
  })

  it("propagates persistence failure without reporting a saved strategy", async () => {
    storeMock.set.mockImplementation(() => {
      throw new Error("disk full")
    })
    const storage = await import("./storage")
    expect(() => storage.setStoredAgentToolStrategy("shell-first")).toThrow("disk full")
  })
})
