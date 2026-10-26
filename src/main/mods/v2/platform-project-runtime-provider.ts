import type { ProjectWorkflowEvidenceSelection } from "./project-workflow-evidence"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { ModObject } from "../../../shared/mods/types"
import {
  PROJECT_RUNTIME_CAPABILITY_DESCRIPTOR,
  PROJECT_RUNTIME_CAPABILITY_REF,
  type ProjectRuntimeRequestKind
} from "../../../shared/mods/v2/project-runtime-capability"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import type {
  NativePlatformCallContext,
  NativePlatformActionAccess,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"

export interface NativeProjectRuntimeScope {
  project: HostProjectState
  operation: HostProjectOperation
  historyLimited: boolean
  /** Revalidates native binding, package, operation and project version. */
  assertCurrent(): void
  /** Authority only; remains valid after an authorized native state transition. */
  assertAuthority(): void
  /** Actual Host input preparation; never creates an operation or approval. */
  preflight(kind: ProjectRuntimeRequestKind): Promise<string>
  prepareWorkflowEvidence?(input: ProjectWorkflowEvidenceSelection):
    Promise<NativePlatformActionAccess & { value: ModObject }>
}
export interface NativeProjectRuntimeReviewRequest {
  context: NativePlatformCallContext
  projectId: string
  operationId: string
  expectedVersion: number
  pluginDigest: string
  kind: ProjectRuntimeRequestKind
  assertCurrent(): void
  assertAuthority(): void
}
export interface NativeProjectRuntimeCommandResult {
  status: "completed" | "rejected" | "unknown"
  projectVersion?: number
  operationStatus?: string
  stopReason?: string
}
export interface ProjectRuntimePlatformDependencies {
  resolve(context: NativePlatformCallContext): NativeProjectRuntimeScope | undefined
  executeNative?(
    request: NativeProjectRuntimeReviewRequest
  ): Promise<NativeProjectRuntimeCommandResult>
}
const workflowEvidenceInput = z.object({
  runId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  stageId: z.string().min(1).max(100),
  agentOffset: z.number().int().min(0).max(1000000).optional(),
  worktreeOffset: z.number().int().min(0).max(1000000).optional(),
  actionOffset: z.number().int().min(0).max(256).optional(),
  limit: z.number().int().min(1).max(32).optional()
}).strict()
const empty = z.object({}).strict()
const preflightInput = z.object({ kind: z.enum(["continue", "cancel", "reconcile"]) }).strict()
const requestInput = z.object({ planId: z.string().uuid() }).strict()
function fail(code: string): never {
  throw Error(`PROJECT_RUNTIME_PUBLIC_${code}`)
}
function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  return /^(?:PROJECT_RUNTIME_PUBLIC_|PROJECT_HOST_|PROJECT_ACTION_)[A-Z0-9_]{1,96}$/.test(message)
    ? message
    : "PROJECT_RUNTIME_PUBLIC_NATIVE_UNAVAILABLE"
}
function bounded(value: unknown): ModObject {
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded) > 16000) fail("RESULT_LIMIT")
  return JSON.parse(encoded) as ModObject
}
function scopeIdentity(scope: NativeProjectRuntimeScope): string {
  return JSON.stringify([
    scope.project.projectId,
    scope.project.version,
    scope.project.pluginDigest,
    scope.operation.operationId,
    scope.operation.updatedAt,
    scope.operation.inputFingerprint,
    scope.operation.status
  ])
}

/** Only an ephemeral preflight ledger; the Host remains the sole project/operation owner. */
export function createProjectRuntimePlatformProvider(
  dependencies: ProjectRuntimePlatformDependencies
): NativePlatformCapabilityProvider {
  const plans = new Map<
    string,
    {
      owner: string
      identity: string
      inputIdentity: string
      kind: ProjectRuntimeRequestKind
      expiresAt: number
      busy: boolean
      opened: boolean
    }
  >()
  let preparing = 0
  let closed = false
  const guard = (context: NativePlatformCallContext) => {
    context.assertCurrent()
    context.signal.throwIfAborted()
    if (closed) fail("CLOSED")
  }
  const resolve = (context: NativePlatformCallContext) => {
    guard(context)
    const scope = dependencies.resolve(context)
    scope?.assertCurrent()
    guard(context)
    return scope
  }
  const owner = (context: NativePlatformCallContext) =>
    JSON.stringify([
      context.workspace,
      context.threadId,
      context.incarnation,
      context.generation,
      context.caller
    ])
  const expire = () => {
    for (const [id, plan] of plans) if (!plan.busy && plan.expiresAt <= Date.now()) plans.delete(id)
  }
  const summary = (scope: NativeProjectRuntimeScope): ModObject => ({
    status: "ready",
    reviewAvailable: !!dependencies.executeNative,
    projectId: scope.project.projectId,
    version: scope.project.version,
    projectStatus: scope.project.status,
    stageId: scope.operation.stageId,
    stageNumber: Math.min(scope.project.stageIndex + 1, scope.project.manifest.stages.length),
    totalStages: scope.project.manifest.stages.length,
    operationId: scope.operation.operationId,
    operationStatus: scope.operation.status,
    currentVersion: scope.operation.expectedVersion === scope.project.version,
    executionApprovalRequired:
      scope.project.manifest.stages.find((stage) => stage.id === scope.operation.stageId)
        ?.approval === "human",
    resultApprovalRequired:
      scope.project.manifest.stages.find((stage) => stage.id === scope.operation.stageId)
        ?.resultApproval === "human",
    recordedExecutionDecision: scope.operation.approval?.decision ?? "none",
    recordedResultDecision: scope.operation.resultApproval?.decision ?? "none"
  })
  return {
    provider: PROJECT_RUNTIME_CAPABILITY_REF.provider,
    digest: "native.project-runtime/project/1.0.0",
    descriptor: PROJECT_RUNTIME_CAPABILITY_DESCRIPTOR,
    actionSelector(action, input) {
      if (action !== "inspect-workflow-evidence") return undefined
      const parsed = workflowEvidenceInput.safeParse(input)
      if (!parsed.success) fail("INPUT_INVALID")
      return parsed.data
    },
    async prepareActionAccess(context, action, selector) {
      if (action !== "inspect-workflow-evidence") return undefined
      const parsed = workflowEvidenceInput.safeParse(selector)
      if (!parsed.success) fail("WORKFLOW_SELECTOR_INVALID")
      const scope = resolve(context)
      if (!scope?.prepareWorkflowEvidence) fail("WORKFLOW_UNAVAILABLE")
      const prepared = await scope.prepareWorkflowEvidence(parsed.data)
      scope.assertCurrent()
      guard(context)
      return { identity: prepared.identity, assertCurrent() {
        guard(context); scope.assertCurrent(); prepared.assertCurrent()
      }, assertContentCurrent() {
        guard(context); scope.assertCurrent(); prepared.assertContentCurrent?.()
        prepared.assertCurrent(); guard(context)
      } }
    },
    read(context) {
      try {
        const scope = resolve(context)
        return scope
          ? bounded(summary(scope))
          : {
              status: "unavailable",
              reviewAvailable: false,
              code: "PROJECT_RUNTIME_PUBLIC_UNBOUND"
            }
      } catch (error) {
        guard(context)
        return { status: "unavailable", reviewAvailable: false, code: safeCode(error) }
      }
    },
    async act(context, action, raw) {
      try {
        // Reject target and authority fields before resolving any native service.
        const parsed =
          action === "inspect-workflow-evidence"
            ? workflowEvidenceInput.safeParse(raw)
            : action === "inspect"
            ? empty.safeParse(raw)
            : action === "preflight"
              ? preflightInput.safeParse(raw)
              : action === "request"
                ? requestInput.safeParse(raw)
                : undefined
        if (!parsed) fail("ACTION_UNSUPPORTED")
        if (!parsed.success) fail("INPUT_INVALID")
        const scope = resolve(context)
        if (!scope) fail("UNBOUND")
        if (action === "inspect-workflow-evidence") {
          if (!scope.prepareWorkflowEvidence) fail("WORKFLOW_UNAVAILABLE")
          const result = await scope.prepareWorkflowEvidence(workflowEvidenceInput.parse(raw))
          scope.assertCurrent()
          result.assertCurrent()
          guard(context)
          return bounded(result.value)
        }
        if (action === "inspect")
          return bounded({
            summary: summary(scope),
            historyLimited: scope.historyLimited || scope.operation.receipts.length > 64,
            checks: scope.operation.receipts
              .slice(0, 64)
              .map(({ checkId, result, checkedAt }) => ({ checkId, result, checkedAt }))
          })
        expire()
        if (action === "preflight") {
          const { kind } = preflightInput.parse(raw)
          if (plans.size + preparing >= 32) fail("PLAN_LIMIT")
          preparing++
          try {
            const inputIdentity = await scope.preflight(kind)
            scope.assertCurrent()
            guard(context)
            const planId = randomUUID()
            plans.set(planId, {
              owner: owner(context),
              identity: scopeIdentity(scope),
              inputIdentity,
              kind,
              expiresAt: Date.now() + 5 * 60 * 1000,
              busy: false,
              opened: false
            })
            return {
              planId,
              kind,
              expectedVersion: scope.project.version,
              canReview: !!dependencies.executeNative,
              executionGranted: false
            }
          } finally {
            preparing--
          }
        }
        const plan = plans.get(requestInput.parse(raw).planId)
        if (!plan || plan.owner !== owner(context) || plan.busy || plan.opened) fail("PLAN_UNKNOWN")
        if (!dependencies.executeNative) fail("REVIEW_UNAVAILABLE")
        if (plan.identity !== scopeIdentity(scope)) fail("PLAN_CHANGED")
        plan.busy = true
        try {
          const inputIdentity = await scope.preflight(plan.kind)
          scope.assertCurrent()
          guard(context)
          if (inputIdentity !== plan.inputIdentity || plan.expiresAt <= Date.now())
            fail("PLAN_CHANGED")
          // Consume before the callback: a lost response must never replay a native side effect.
          plan.opened = true
          const result = await dependencies.executeNative({
            context,
            projectId: scope.project.projectId,
            operationId: scope.operation.operationId,
            expectedVersion: scope.project.version,
            pluginDigest: scope.project.pluginDigest,
            kind: plan.kind,
            assertCurrent() {
              guard(context)
              scope.assertCurrent()
            },
            assertAuthority() {
              guard(context)
              scope.assertAuthority()
            }
          })
          guard(context)
          scope.assertAuthority()
          return bounded({
            status: result.status,
            kind: plan.kind,
            projectVersion: result.projectVersion,
            operationStatus: result.operationStatus,
            stopReason: result.stopReason
          })
        } finally {
          plan.busy = false
        }
      } catch (error) {
        guard(context)
        throw Error(safeCode(error))
      }
    },
    close() {
      closed = true
      plans.clear()
    }
  }
}
