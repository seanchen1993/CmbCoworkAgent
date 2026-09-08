/**
 * LangGraph graph-step budget for every explicitly streamed Cmb agent runtime.
 *
 * This is a graph-step limit, not a tool-call limit: one model/tool cycle can
 * consume multiple steps. Keep it centralized so every Cmb agent runtime uses
 * the same product-level budget.
 */
export const AGENT_GRAPH_RECURSION_LIMIT_DEFAULT = 2_000
export const AGENT_GRAPH_RECURSION_LIMIT_MIN = 25
export const AGENT_GRAPH_RECURSION_LIMIT_MAX = 100_000

export const WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT = 3
export const WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MIN = 1
export const WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MAX = 120
export const WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT = 1
export const WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MIN = 1
export const WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MAX = 10

export interface AgentRuntimeSettings {
  recursionLimit: number
  workflowWorktreeTimeoutMinutes: number
  workflowWorktreeRemoveTimeoutMinutes: number
}

let configuredAgentGraphRecursionLimit = AGENT_GRAPH_RECURSION_LIMIT_DEFAULT
let configuredWorkflowWorktreeTimeoutMinutes = WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT
let configuredWorkflowWorktreeRemoveTimeoutMinutes =
  WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT

export function isAgentGraphRecursionLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= AGENT_GRAPH_RECURSION_LIMIT_MIN &&
    value <= AGENT_GRAPH_RECURSION_LIMIT_MAX
  )
}

export function normalizeAgentGraphRecursionLimit(value: unknown): number {
  return isAgentGraphRecursionLimit(value) ? value : AGENT_GRAPH_RECURSION_LIMIT_DEFAULT
}

export function configureAgentGraphRecursionLimit(value: unknown): number {
  configuredAgentGraphRecursionLimit = normalizeAgentGraphRecursionLimit(value)
  return configuredAgentGraphRecursionLimit
}

export function getAgentGraphRecursionLimit(): number {
  return configuredAgentGraphRecursionLimit
}

export function isWorkflowWorktreeTimeoutMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MIN &&
    value <= WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MAX
  )
}

export function normalizeWorkflowWorktreeTimeoutMinutes(value: unknown): number {
  return isWorkflowWorktreeTimeoutMinutes(value) ? value : WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT
}

export function configureWorkflowWorktreeTimeoutMinutes(value: unknown): number {
  configuredWorkflowWorktreeTimeoutMinutes = normalizeWorkflowWorktreeTimeoutMinutes(value)
  return configuredWorkflowWorktreeTimeoutMinutes
}

export function getWorkflowWorktreeTimeoutMinutes(): number {
  return configuredWorkflowWorktreeTimeoutMinutes
}

export function getWorkflowWorktreeTimeoutMs(): number {
  return configuredWorkflowWorktreeTimeoutMinutes * 60_000
}

export function isWorkflowWorktreeRemoveTimeoutMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MIN &&
    value <= WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MAX
  )
}

export function normalizeWorkflowWorktreeRemoveTimeoutMinutes(value: unknown): number {
  return isWorkflowWorktreeRemoveTimeoutMinutes(value)
    ? value
    : WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT
}

export function configureWorkflowWorktreeRemoveTimeoutMinutes(value: unknown): number {
  configuredWorkflowWorktreeRemoveTimeoutMinutes =
    normalizeWorkflowWorktreeRemoveTimeoutMinutes(value)
  return configuredWorkflowWorktreeRemoveTimeoutMinutes
}

export function getWorkflowWorktreeRemoveTimeoutMinutes(): number {
  return configuredWorkflowWorktreeRemoveTimeoutMinutes
}

export function getWorkflowWorktreeRemoveTimeoutMs(): number {
  return configuredWorkflowWorktreeRemoveTimeoutMinutes * 60_000
}
