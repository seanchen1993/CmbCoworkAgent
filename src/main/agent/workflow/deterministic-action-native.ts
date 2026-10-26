import {
  captureThreadIncarnation,
  type ThreadIncarnationRow
} from "../../services/thread-incarnation"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import { createHash } from "node:crypto"
import type { ModObject } from "../../../shared/mods/types"
import {
  captureRuntimePluginSourceAuthorityGuard,
  captureRuntimePluginSourceContentGuard
} from "../../plugins/runtime-source-scope"
import {
  createWorkflowDeterministicActionRunner,
  verifyWorkflowDeadlineReceipt,
  type WorkflowActionParent,
  type WorkflowDeterministicActionDependencies,
  type WorkflowDeterministicActionRunner
} from "./deterministic-action"

export interface NativeWorkflowDeterministicActionDependencies extends WorkflowDeterministicActionDependencies {
  workspaceKey(workspace: string): string
  thread(threadId: string): ThreadIncarnationRow | null | undefined
}
let dependencies: NativeWorkflowDeterministicActionDependencies | undefined

export function nativeWorkflowDeadlineReceiptVerifier(parent: {
  workspacePath: string; threadId: string; runId: string
}) {
  const native = dependencies
  const original = native?.thread(parent.threadId)
  const incarnation = original ? JSON.stringify(captureThreadIncarnation(original)) : undefined
  return (handle: string, budgetId: string, executionId: string): boolean => {
    const current = native?.thread(parent.threadId)
    if (!native || dependencies !== native || !current || !incarnation ||
        JSON.stringify(captureThreadIncarnation(current)) !== incarnation) return false
    return verifyWorkflowDeadlineReceipt(native.store, {
      ...parent, workspace: native.workspaceKey(parent.workspacePath), incarnation
    }, handle, budgetId, executionId)
  }
}

/** Main-only read scope; grants no invoke, publish, cancel or other-thread execution authority. */
export interface WorkflowEvidenceReadScope {
  workspace: string
  threadId: string
  incarnation: string
  assertCurrent(): void
}

/** Join immutable step bindings to original PlatformHub receipts; never mirror their state. */
export function observeWorkflowDeterministicActions(
  context: WorkflowEvidenceReadScope,
  runId: string,
  offset = 0,
  limit = 16
): ModObject {
  context.assertCurrent()
  const native = dependencies
  if (!native) return { deterministicActions: [], actionCount: 0, nextActionOffset: null }
  const thread = native.thread(context.threadId)
  if (!thread || JSON.stringify(captureThreadIncarnation(thread)) !== context.incarnation)
    throw Error("WORKFLOW_ACTION_SCOPE_CHANGED")
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 256 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 32
  )
    throw Error("WORKFLOW_ACTION_PAGE_INVALID")
  const workspace = native.workspaceKey(context.workspace)
  const namespace = JSON.stringify([
    "native.workflow-actions/v1",
    workspace,
    context.threadId,
    context.incarnation,
    runId
  ])
  const platformNamespace = JSON.stringify([
    "native.platform/v1",
    workspace,
    context.threadId,
    context.incarnation
  ])
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const keys = native.store
    .keys(namespace)
    .filter((key) => key.startsWith("step:"))
    .sort()
  const rows: ModObject[] = []
  for (const key of keys.slice(offset, offset + limit)) {
    const binding = native.store.get(namespace, key) as ModObject
    if (!binding || binding.parentRunId !== runId) throw Error("WORKFLOW_ACTION_BINDING_INVALID")
    const provider = binding.provider as ModObject
    const requestKey =
      "flow:" + hash([provider.pluginId, runId, binding.stepId, binding.executionId])
    const saved = native.store.get(
      platformNamespace,
      "action:" + hash([provider.plugin, requestKey])
    ) as ModObject | undefined
    if (saved && saved.providerDigest !== provider.digest)
      throw Error("WORKFLOW_ACTION_RECEIPT_CHANGED")
    const receipt = saved?.result as ModObject | undefined
    const value = receipt?.value as ModObject | undefined
    const output = value?.output ?? null
    const verified = native.store.get(namespace, key.replace(/^step:/, "verification:")) as ModObject | undefined
    if (verified && verified.identity !== binding.identity) throw Error("WORKFLOW_ACTION_BINDING_INVALID")
    const row: ModObject = {
      stepId: binding.stepId,
      executionId: binding.executionId,
      provider,
      ...(binding.verificationResource ? { verificationResource: verified?.verification ?? binding.verificationResource } : {}),
      inputFingerprint: binding.identity,
      status: receipt?.status === "succeeded" ? String(value?.status ?? "unknown") : "unknown",
      output: Buffer.byteLength(JSON.stringify(output)) <= 2000 ? output : null,
      outputTruncated: Buffer.byteLength(JSON.stringify(output)) > 2000
    }
    if (Buffer.byteLength(JSON.stringify([...rows, row])) > 5000) break
    rows.push(row)
  }
  context.assertCurrent()
  return {
    deterministicActions: rows,
    actionCount: keys.length,
    actionOffset: offset,
    nextActionOffset: offset + rows.length < keys.length ? offset + rows.length : null
  }
}
/** Configured by the original Mods IPC owner, not by workflow source or renderer arguments. */
export function configureWorkflowDeterministicActions(
  next: NativeWorkflowDeterministicActionDependencies
) {
  dependencies = next
  return () => {
    if (dependencies === next) dependencies = undefined
  }
}

export function nativeWorkflowDeterministicActionRunner(
  parent: Omit<WorkflowActionParent, "workspace" | "incarnation"> & { workspacePath: string }
): WorkflowDeterministicActionRunner | undefined {
  const native = dependencies
  if (!native) return undefined
  const initial = native.thread(parent.threadId)
  const incarnation = initial ? JSON.stringify(captureThreadIncarnation(initial)) : undefined
  const sourceAuthority = captureRuntimePluginSourceAuthorityGuard()
  const sourceContent = captureRuntimePluginSourceContentGuard()
  const workspace = native.workspaceKey(parent.workspacePath)
  const assertCurrent = () => {
    parent.signal.throwIfAborted()
    parent.assertCurrent()
    sourceAuthority?.()
    if (dependencies !== native) throw Error("WORKFLOW_ACTION_RUNTIME_CHANGED")
    const row = native.thread(parent.threadId)
    if (!row || !incarnation || JSON.stringify(captureThreadIncarnation(row)) !== incarnation)
      throw Error("WORKFLOW_ACTION_SCOPE_CHANGED")
    const metadata = JSON.parse(row.metadata ?? "{}")
    if (
      typeof metadata.workspacePath !== "string" ||
      !isSameWorkspacePath(metadata.workspacePath, parent.workspacePath) ||
      metadata.remoteState === "historical" ||
      metadata.remoteReadOnly === true
    )
      throw Error("WORKFLOW_ACTION_SCOPE_CHANGED")
  }
  const runner = createWorkflowDeterministicActionRunner(native, {
    ...parent,
    workspace,
    incarnation: incarnation ?? "unavailable",
    assertCurrent
  })
  return async (...args) => {
    assertCurrent()
    sourceContent?.()
    const result = await runner(...args)
    assertCurrent()
    sourceContent?.()
    return result
  }
}
