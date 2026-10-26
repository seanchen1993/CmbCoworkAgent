import { createHash } from "node:crypto"
import { z } from "zod"
import type { ModObject } from "../../../shared/mods/types"
import type { FunctionModsManager } from "../../mods/v2/manager"
import type { FunctionStateStore } from "../../mods/v2/state-store"
import { currentWorkflowWorktreeActionScope, withWorkflowActionReceiptReplay } from "./worktree-action-scope"
import { withWorkflowDeadlineAction } from "./resource-deadline"

export interface WorkflowActionParent {
  workspace: string
  threadId: string
  incarnation: string
  runId: string
  scriptSha256: string
  args?: unknown
  signal: AbortSignal
  assertCurrent(): void
  runResource?<T>(handle: string, work: () => Promise<T>, budgetId?: string): Promise<T>
  runDeadlineResource?<T>(handle: string, budgetId: string, work: () => Promise<T>): Promise<T>
  runVerificationResource?<T>(request: { handle: string; expectedCommit: string },
    work: () => Promise<T>): Promise<T>
}
export interface WorkflowActionChild {
  /** Canonical source location supplied by the engine, never by action input. */
  identity: string
  scriptSha256: string
}
export type WorkflowDeterministicActionRunner = (
  input: unknown,
  child: WorkflowActionChild | undefined,
  signal: AbortSignal
) => Promise<ModObject>
export interface WorkflowActionOwnedScope {
  workspace: string
  threadId: string
  signal: AbortSignal
  assertCurrent(): void
}
export interface WorkflowDeterministicActionDependencies {
  functions: Pick<FunctionModsManager, "prepareAction" | "runAction">
  store: Pick<FunctionStateStore, "get" | "set" | "keys">
  /** Original native queue/lease/permission scope; never an action-provided callback. */
  runOwned<T>(
    scope: WorkflowActionOwnedScope,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T>
}
const requestSchema = z
  .object({
    stepId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/),
    resourceHandle: z.string().uuid().optional(),
    deadlineBudgetId: z.string().min(1).max(128).optional(),
    deadlineResource: z.object({ handle: z.string().uuid(), budgetId: z.string().min(1).max(128) }).strict().optional(),
    verificationResource: z.object({ handle: z.string().uuid(),
      expectedCommit: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict().optional(),
    provider: z
      .object({
        pluginId: z.string().min(1).max(256),
        plugin: z.string().min(1).max(128),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        actionId: z.string().min(1).max(128)
      })
      .strict(),
    input: z.record(z.string(), z.unknown()),
    config: z.record(z.string(), z.unknown()).optional()
  })
  .strict().refine(value => [value.resourceHandle, value.verificationResource, value.deadlineResource].filter(Boolean).length <= 1 &&
    (!value.deadlineBudgetId || !!value.resourceHandle))
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function fail(code: string): never {
  throw Error(`WORKFLOW_ACTION_${code}`)
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    )
  return value
}

/** Reads the original binding and PlatformHub result; callers cannot supply a success flag. */
export function verifyWorkflowDeadlineReceipt(
  store: WorkflowDeterministicActionDependencies["store"],
  parent: Pick<WorkflowActionParent, "workspace" | "threadId" | "incarnation" | "runId">,
  handle: string, budgetId: string, executionId: string
): boolean {
  const namespace = JSON.stringify(["native.workflow-actions/v1", parent.workspace,
    parent.threadId, parent.incarnation, parent.runId])
  const bindings = store.keys(namespace).filter(key => key.startsWith("step:"))
  if (bindings.length > 256) return false
  const matches = bindings.map(key => store.get(namespace, key) as ModObject | undefined)
    .filter(row => row?.executionId === executionId)
  if (matches.length !== 1) return false
  const binding = matches[0]!
  if (binding.parentRunId !== parent.runId || binding.resourceHandle !== handle ||
      binding.deadlineBudgetId !== budgetId) return false
  const provider = binding.provider as ModObject
  if (!provider || typeof provider.pluginId !== "string" || typeof provider.plugin !== "string") return false
  const requestKey = "flow:" + digest([provider.pluginId, parent.runId, binding.stepId, executionId])
  const saved = store.get(JSON.stringify(["native.platform/v1", parent.workspace,
    parent.threadId, parent.incarnation]), "action:" + digest([provider.plugin, requestKey])) as ModObject | undefined
  const result = saved?.result as ModObject | undefined
  const value = result?.value as ModObject | undefined
  return saved?.providerDigest === provider.digest && result?.status === "succeeded" &&
    value?.status === "succeeded"
}

/** Only source/parent bindings live here. Original PlatformHub owns all execution receipts. */
export function createWorkflowDeterministicActionRunner(
  dependencies: WorkflowDeterministicActionDependencies,
  parent: WorkflowActionParent
): WorkflowDeterministicActionRunner {
  const namespace = JSON.stringify([
    "native.workflow-actions/v1",
    parent.workspace,
    parent.threadId,
    parent.incarnation,
    parent.runId
  ])
  const parentIdentity = digest([parent.scriptSha256, canonical(parent.args ?? null)])
  const current = (signal: AbortSignal) => {
    parent.signal.throwIfAborted()
    signal.throwIfAborted()
    parent.assertCurrent()
  }
  const bind = (key: string, identity: string, data: ModObject) => {
    const saved = dependencies.store.get(namespace, key)
    if (saved !== undefined) {
      if (
        !saved ||
        typeof saved !== "object" ||
        Array.isArray(saved) ||
        saved.identity !== identity
      )
        fail("IDENTITY_CONFLICT")
      return
    }
    if (dependencies.store.keys(namespace).length >= 256) fail("LIMIT")
    dependencies.store.set(namespace, key, { identity, ...data })
  }
  return async (raw, child, callSignal) => {
    const signal = AbortSignal.any([parent.signal, callSignal])
    current(signal)
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) fail("INPUT_INVALID")
    if (Buffer.byteLength(JSON.stringify(raw)) > 12000) fail("INPUT_LIMIT")
    const request = parsed.data
    const childIdentity = child?.identity ?? "root"
    const scriptSha256 = child?.scriptSha256 ?? parent.scriptSha256
    const stableStep = digest([childIdentity, request.stepId])
    const fingerprint = digest([parentIdentity, childIdentity, scriptSha256, canonical(request)])
    const executionId = `wfa_${digest([
      parent.runId,
      parent.scriptSha256,
      childIdentity,
      scriptSha256,
      request.stepId
    ])}`
    // These synchronous, durable bindings precede every async admission and side effect.
    // Changing a script or args for an existing parent run cannot mint replacement operation IDs.
    bind("parent", parentIdentity, { runId: parent.runId, scriptSha256: parent.scriptSha256 })
    if (child)
      bind(`child:${digest(childIdentity)}`, digest([childIdentity, scriptSha256]), {
        scriptSha256
      })
    bind(`step:${stableStep}`, fingerprint, {
      parentRunId: parent.runId,
      stepId: request.stepId,
      executionId,
      scriptSha256,
      provider: request.provider,
      ...(request.resourceHandle || request.deadlineResource ? {
        resourceHandle: request.resourceHandle ?? request.deadlineResource!.handle,
        ...(request.deadlineBudgetId || request.deadlineResource ? {
          deadlineBudgetId: request.deadlineBudgetId ?? request.deadlineResource!.budgetId
        } : {})
      } : {}),
      ...(request.verificationResource ? { verificationResource: request.verificationResource } : {})
    })
    current(signal)
    return dependencies.runOwned(
      {
        workspace: parent.workspace,
        threadId: parent.threadId,
        signal,
        assertCurrent: () => current(signal)
      },
      async (ownedSignal) => {
        const execute = async () => {
          const lifetime = AbortSignal.any([signal, ownedSignal])
          current(lifetime)
          if (request.verificationResource) {
            const verified = currentWorkflowWorktreeActionScope(parent.workspace, parent.threadId)?.verification
            if (!verified || verified.handle !== request.verificationResource.handle ||
                verified.expectedCommit !== request.verificationResource.expectedCommit)
              fail("VERIFICATION_SCOPE_REQUIRED")
            bind(`verification:${stableStep}`, fingerprint, { verification: { ...verified } })
          }
          const prepared = await dependencies.functions.prepareAction(
            parent.workspace,
            parent.threadId,
            request.provider,
            lifetime
          )
          current(lifetime)
          // Command handlers have no original durable action receipt. Never silently downgrade.
          if (prepared.route !== "platform") fail("PLATFORM_ROUTE_REQUIRED")
          const result = await dependencies.functions.runAction(
            parent.workspace,
            parent.threadId,
            prepared,
            {
              version: 1,
              input: request.input as ModObject,
              config: (request.config ?? {}) as ModObject,
              task: "Execute the explicitly declared deterministic workflow action",
              runId: parent.runId,
              stepId: request.stepId,
              executionId
            },
            lifetime
          )
          current(lifetime)
          return {
            parentRunId: parent.runId,
            stepId: request.stepId,
            executionId,
            status: result.passed === false ? "failed" : "succeeded",
            text: result.text,
            ...(result.output === undefined ? {} : { output: result.output })
          }
        }
        if (request.verificationResource) {
          if (!parent.runVerificationResource) fail("VERIFICATION_RESOURCE_UNAVAILABLE")
          return parent.runVerificationResource(request.verificationResource, execute)
        }
        if (request.resourceHandle || request.deadlineResource) {
          const requestKey =
            "flow:" + digest([request.provider.pluginId, parent.runId, request.stepId, executionId])
          const receipt = dependencies.store.get(
            JSON.stringify([
              "native.platform/v1",
              parent.workspace,
              parent.threadId,
              parent.incarnation
            ]),
            "action:" + digest([request.provider.plugin, requestKey])
          )
          if (receipt !== undefined)
            return withWorkflowActionReceiptReplay(() => current(signal), execute)
          if (request.deadlineResource) {
            if (!parent.runDeadlineResource) fail("RESOURCE_UNAVAILABLE")
            return parent.runDeadlineResource(request.deadlineResource.handle,
              request.deadlineResource.budgetId,
              () => withWorkflowDeadlineAction(request.stepId, executionId, execute))
          }
          if (!parent.runResource) fail("RESOURCE_UNAVAILABLE")
          return parent.runResource(request.resourceHandle!,
            () => withWorkflowDeadlineAction(request.stepId, executionId, execute), request.deadlineBudgetId)
        }
        return execute()
      }
    )
  }
}
