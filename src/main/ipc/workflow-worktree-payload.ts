import type { WorkflowWorktreeRecord } from "../agent/workflow/types"

export type WorkflowWorktreeAction = "diff" | "merge" | "discard" | "cleanup"

export interface WorkflowWorktreeActionResponse {
  record: WorkflowWorktreeRecord
  summary?: string
}

export function assertWorktreeActionPayload(value: unknown): {
  threadId: string
  runId: string
  worktreeId: string
  action: WorkflowWorktreeAction
} {
  if (!value || typeof value !== "object") throw new TypeError("invalid worktree action payload")
  const payload = value as Record<string, unknown>
  const threadId = typeof payload.threadId === "string" ? payload.threadId.trim() : ""
  if (!threadId || threadId.length > 256) throw new TypeError("invalid threadId")
  if (typeof payload.runId !== "string" || !/^wf_[a-z0-9]{6,32}$/.test(payload.runId)) {
    throw new TypeError("invalid workflow runId")
  }
  if (
    typeof payload.worktreeId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(payload.worktreeId)
  ) {
    throw new TypeError("invalid worktreeId")
  }
  if (
    payload.action !== "diff" &&
    payload.action !== "merge" &&
    payload.action !== "discard" &&
    payload.action !== "cleanup"
  ) {
    throw new TypeError("invalid workflow worktree action")
  }
  return {
    threadId,
    runId: payload.runId,
    worktreeId: payload.worktreeId,
    action: payload.action
  }
}
