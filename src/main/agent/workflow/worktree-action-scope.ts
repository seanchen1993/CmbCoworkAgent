import { AsyncLocalStorage } from "node:async_hooks"
import type { WorkflowWorktreeIsolationBoundary } from "./types"

export interface WorkflowWorktreeActionScope {
  workspace: string
  threadId: string
  runId: string
  boundary: WorkflowWorktreeIsolationBoundary
  verification?: WorkflowVerificationResource
  verifyCurrent?(): Promise<void>
  assertCurrent(): void
}
export interface WorkflowVerificationResource {
  handle: string
  expectedCommit: string
  resourceId: string
  generation: number
  workspaceRef: string | null
}
const scope = new AsyncLocalStorage<WorkflowWorktreeActionScope & { active: boolean }>()
const receiptReplay = new AsyncLocalStorage<{ active: boolean; assertCurrent(): void }>()

/** A settled resource may read an original receipt but cannot admit any replacement effect. */
export async function withWorkflowActionReceiptReplay<T>(
  assertCurrent: () => void,
  work: () => Promise<T>
): Promise<T> {
  const replay = { active: true, assertCurrent }
  return receiptReplay.run(replay, async () => {
    try {
      assertCurrent()
      return await work()
    } finally {
      replay.active = false
    }
  })
}
export function assertWorkflowActionDispatchAllowed(): void {
  assertWorkflowVerificationCurrent()
  const replay = receiptReplay.getStore()
  if (!replay) return
  replay.assertCurrent()
  throw Error(
    replay.active ? "WORKFLOW_ACTION_RECEIPT_DISAPPEARED" : "WORKFLOW_ACTION_REPLAY_EXPIRED"
  )
}
export function assertWorkflowVerificationCurrent(): void {
  const entry = scope.getStore()
  if (!entry?.verification) return
  if (!entry.active) throw Error("WORKTREE_VERIFICATION_SCOPE_EXPIRED")
  entry.assertCurrent()
}
export function activeWorkflowVerificationAccessScope(): string | undefined {
  const entry = scope.getStore()
  if (!entry?.verification) return undefined
  assertWorkflowVerificationCurrent()
  return JSON.stringify(["workflow-verification/v1", entry.workspace, entry.threadId,
    entry.runId, entry.verification])
}
/** Expensive Git facts are checked at execution/approval/publication boundaries only. */
export async function verifyWorkflowVerificationCurrent(): Promise<void> {
  const entry = scope.getStore()
  if (!entry?.verification) return
  assertWorkflowVerificationCurrent()
  if (!entry.verifyCurrent) throw Error("WORKTREE_VERIFICATION_GUARD_MISSING")
  await entry.verifyCurrent()
  assertWorkflowVerificationCurrent()
}

/** Native-only narrowing of a deterministic action; it never grants new permissions. */
export async function withWorkflowWorktreeActionScope<T>(
  input: WorkflowWorktreeActionScope,
  work: () => Promise<T>
): Promise<T> {
  input.assertCurrent()
  const entry = { ...input, active: true }
  return scope.run(entry, async () => {
    try {
      const result = await work()
      entry.assertCurrent()
      return result
    } finally {
      entry.active = false
    }
  })
}
export function currentWorkflowWorktreeActionScope(workspace: string, threadId: string) {
  const entry = scope.getStore()
  if (!entry) return undefined
  if (!entry.active || entry.workspace !== workspace || entry.threadId !== threadId)
    throw Error("WORKTREE_ACTION_SCOPE_CHANGED")
  entry.assertCurrent()
  return entry
}
