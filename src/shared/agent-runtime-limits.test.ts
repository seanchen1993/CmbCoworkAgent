import { afterEach, describe, expect, it } from "vitest"
import {
  AGENT_GRAPH_RECURSION_LIMIT_DEFAULT,
  AGENT_GRAPH_RECURSION_LIMIT_MAX,
  AGENT_GRAPH_RECURSION_LIMIT_MIN,
  WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT,
  WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MAX,
  WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MIN,
  WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT,
  WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MAX,
  WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MIN,
  configureAgentGraphRecursionLimit,
  configureWorkflowWorktreeRemoveTimeoutMinutes,
  configureWorkflowWorktreeTimeoutMinutes,
  getAgentGraphRecursionLimit,
  getWorkflowWorktreeRemoveTimeoutMs,
  getWorkflowWorktreeTimeoutMinutes,
  getWorkflowWorktreeTimeoutMs,
  isAgentGraphRecursionLimit,
  isWorkflowWorktreeRemoveTimeoutMinutes,
  isWorkflowWorktreeTimeoutMinutes,
  normalizeAgentGraphRecursionLimit,
  normalizeWorkflowWorktreeRemoveTimeoutMinutes,
  normalizeWorkflowWorktreeTimeoutMinutes
} from "./agent-runtime-limits"

describe("agent runtime recursion limit", () => {
  afterEach(() => {
    configureAgentGraphRecursionLimit(AGENT_GRAPH_RECURSION_LIMIT_DEFAULT)
    configureWorkflowWorktreeTimeoutMinutes(WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT)
    configureWorkflowWorktreeRemoveTimeoutMinutes(WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT)
  })

  it("accepts bounded safe integers", () => {
    expect(isAgentGraphRecursionLimit(AGENT_GRAPH_RECURSION_LIMIT_MIN)).toBe(true)
    expect(isAgentGraphRecursionLimit(AGENT_GRAPH_RECURSION_LIMIT_MAX)).toBe(true)
    expect(isAgentGraphRecursionLimit(AGENT_GRAPH_RECURSION_LIMIT_MIN - 1)).toBe(false)
    expect(isAgentGraphRecursionLimit(AGENT_GRAPH_RECURSION_LIMIT_MAX + 1)).toBe(false)
    expect(isAgentGraphRecursionLimit(25.5)).toBe(false)
    expect(isAgentGraphRecursionLimit("2000")).toBe(false)
  })

  it("falls back to 2000 for invalid persisted or programmatic values", () => {
    expect(normalizeAgentGraphRecursionLimit(undefined)).toBe(AGENT_GRAPH_RECURSION_LIMIT_DEFAULT)
    expect(configureAgentGraphRecursionLimit(-1)).toBe(AGENT_GRAPH_RECURSION_LIMIT_DEFAULT)
    expect(getAgentGraphRecursionLimit()).toBe(AGENT_GRAPH_RECURSION_LIMIT_DEFAULT)
  })

  it("exposes one configured value to every runtime caller", () => {
    expect(configureAgentGraphRecursionLimit(4096)).toBe(4096)
    expect(getAgentGraphRecursionLimit()).toBe(4096)
  })
})

describe("workflow worktree timeout", () => {
  afterEach(() => {
    configureWorkflowWorktreeTimeoutMinutes(WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT)
    configureWorkflowWorktreeRemoveTimeoutMinutes(WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT)
  })

  it("accepts whole minutes within the supported range", () => {
    expect(isWorkflowWorktreeTimeoutMinutes(WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MIN)).toBe(true)
    expect(isWorkflowWorktreeTimeoutMinutes(WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MAX)).toBe(true)
    expect(isWorkflowWorktreeTimeoutMinutes(0)).toBe(false)
    expect(isWorkflowWorktreeTimeoutMinutes(121)).toBe(false)
    expect(isWorkflowWorktreeTimeoutMinutes(1.5)).toBe(false)
  })

  it("defaults to three minutes and exposes milliseconds to git operations", () => {
    expect(normalizeWorkflowWorktreeTimeoutMinutes(undefined)).toBe(
      WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(configureWorkflowWorktreeTimeoutMinutes(7)).toBe(7)
    expect(getWorkflowWorktreeTimeoutMinutes()).toBe(7)
    expect(getWorkflowWorktreeTimeoutMs()).toBe(420_000)
  })

  it("configures the separate removal timeout", () => {
    expect(
      isWorkflowWorktreeRemoveTimeoutMinutes(WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MIN)
    ).toBe(true)
    expect(
      isWorkflowWorktreeRemoveTimeoutMinutes(WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MAX)
    ).toBe(true)
    expect(isWorkflowWorktreeRemoveTimeoutMinutes(0)).toBe(false)
    expect(isWorkflowWorktreeRemoveTimeoutMinutes(11)).toBe(false)
    expect(normalizeWorkflowWorktreeRemoveTimeoutMinutes(undefined)).toBe(
      WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT
    )
    expect(configureWorkflowWorktreeRemoveTimeoutMinutes(4)).toBe(4)
    expect(getWorkflowWorktreeRemoveTimeoutMs()).toBe(240_000)
  })
})
