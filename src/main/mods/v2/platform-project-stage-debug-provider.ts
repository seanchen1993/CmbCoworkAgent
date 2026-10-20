import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { ModObject } from "../../../shared/mods/types"
import {
  PROJECT_STAGE_DEBUG_CAPABILITY_REF as ref,
  STAGE_DEBUG_INSPECT_SCHEMA,
  STAGE_DEBUG_PREPARE_SCHEMA,
  STAGE_DEBUG_REVIEW_SCHEMA,
  STAGE_DEBUG_SUMMARY_SCHEMA,
  STAGE_DEBUG_PAGE_SCHEMA,
  STAGE_DEBUG_PLAN_SCHEMA,
  STAGE_DEBUG_REVIEW_RESULT_SCHEMA,
  type StageDebugCandidateView
} from "../../../shared/mods/v2/project-stage-debug-capability"
import type { StageDebugPreparation } from "../../../shared/project-runtime/stage-debug"
import type { ProjectStageDebugSessions } from "../devtools/project-stage-debug"
import type { DevelopmentScope } from "./development-session"
import type { NativePlatformCallContext, NativePlatformCapabilityProvider } from "./platform-capabilities-types"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const inspectInput = z.object({
  kind: z.enum(["snapshots", "branches", "drafts"]),
  offset: z.number().int().min(0).max(128).default(0),
  limit: z.number().int().min(1).max(8).default(8)
}).strict()
const prepareInput = z.object({
  snapshotId: digest,
  draftId: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  revision: z.number().int().min(1).max(8),
  expectedDigest: digest,
  mode: z.enum(["stage", "downstream"])
}).strict()
const reviewInput = z.object({ planId: z.string().uuid() }).strict()
type PrepareInput = z.infer<typeof prepareInput>
type CreatorContext = { scope: DevelopmentScope; guard(): void }

/** Main-only review navigation. It must never create, approve, start or advance a project. */
export interface NativeStageDebugReviewRequest {
  context: NativePlatformCallContext
  scope: DevelopmentScope
  preparation: StageDebugPreparation
  draftId: string
  revision: number
  assertCurrent(): void
}
export interface StageDebugPlatformDependencies {
  creator(context: NativePlatformCallContext): CreatorContext
  debug(): Pick<ProjectStageDebugSessions, "list" | "prepare">
  drafts(scope: DevelopmentScope): StageDebugCandidateView[]
  openReview?(request: NativeStageDebugReviewRequest): Promise<{ requested: boolean; queued: boolean }>
}
interface OwnedPlan {
  owner: string
  input: PrepareInput
  preparation: StageDebugPreparation
  createdAt: number
  busy: boolean
  opened: boolean
}

function fail(code: string): never { throw Error(`PROJECT_STAGE_DEBUG_${code}`) }
function safeCode(error: unknown): string {
  const code = error instanceof Error ? error.message : ""
  return /^(?:PROJECT_STAGE_DEBUG_|PROJECT_HOST_|PROJECT_DRAFT_|DEVELOPMENT_)[A-Z0-9_]{1,96}$/.test(code)
    ? code : "PROJECT_STAGE_DEBUG_NATIVE_UNAVAILABLE"
}
function bounded(value: unknown): ModObject {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > 16000) fail("PUBLIC_RESULT_LIMIT")
  return JSON.parse(text) as ModObject
}
function diagnostics(items: string[]): string[] {
  // Native detail strings can mention private locations; public diagnostics use stable codes.
  return items.slice(0, 8).map((text) =>
    /^(?:PROJECT_STAGE_DEBUG_|PROJECT_HOST_)[A-Z0-9_]{1,96}$/.test(text)
      ? text : "请在原生复核入口核对完整限制、原始来源与检查结果。")
}

/** Thin scoped facade. No project state, snapshots, approvals or runner are recreated here. */
export function createProjectStageDebugPlatformProvider(
  dependencies: StageDebugPlatformDependencies
): NativePlatformCapabilityProvider {
  const plans = new Map<string, OwnedPlan>()
  let preparing = 0
  const native = (context: NativePlatformCallContext) => {
    context.assertCurrent()
    const creator = dependencies.creator(context)
    const expected = JSON.stringify(creator.scope)
    const guard = () => {
      context.assertCurrent()
      creator.guard()
      const current = dependencies.creator(context)
      current.guard()
      if (JSON.stringify(current.scope) !== expected ||
        current.scope.threadId !== context.threadId || current.scope.workspace !== context.workspace ||
        JSON.stringify(current.scope.incarnation) !== context.incarnation) fail("CREATOR_SCOPE_CHANGED")
    }
    guard()
    return { scope: creator.scope, guard }
  }
  const owner = (context: NativePlatformCallContext, scope: DevelopmentScope) =>
    JSON.stringify([scope, context.incarnation, context.generation, context.caller])
  const expire = () => {
    for (const [id, plan] of plans)
      if (!plan.busy && Date.now() - plan.createdAt > 15 * 60 * 1000) plans.delete(id)
  }
  const read = (context: NativePlatformCallContext): ModObject => {
    try {
      const current = native(context)
      const view = dependencies.debug().list(current)
      const drafts = dependencies.drafts(current.scope)
      current.guard()
      return bounded({ status: "ready", snapshotCount: view.snapshots.length,
        branchCount: view.branches.length, draftCount: drafts.length,
        reviewAvailable: !!dependencies.openReview })
    } catch (error) {
      // Never convert revoked authority to a late usable read.
      context.assertCurrent()
      return { status: "unavailable", snapshotCount: 0, branchCount: 0, draftCount: 0,
        reviewAvailable: false, code: safeCode(error) }
    }
  }
  return {
    provider: ref.provider,
    digest: "native.project-stage-debug/stages/1.0.0",
    descriptor: {
      apiVersion: "devclaw.capability/v1", id: ref.id, version: ref.version,
      title: "当前创造会话的阶段快照与调试方案", scope: "conversation",
      stateSchema: STAGE_DEBUG_SUMMARY_SCHEMA,
      actions: [
        { id: "inspect", title: "分页读取快照、候选与原生调试结果", inputSchema: STAGE_DEBUG_INSPECT_SCHEMA,
          outputSchema: STAGE_DEBUG_PAGE_SCHEMA, requiredPermissions: ["platform.read"], cancellable: true, idempotency: "keyed" },
        { id: "prepare", title: "校验并准备阶段调试方案，不执行", inputSchema: STAGE_DEBUG_PREPARE_SCHEMA,
          outputSchema: STAGE_DEBUG_PLAN_SCHEMA, requiredPermissions: ["platform.read"], cancellable: true, idempotency: "keyed" },
        { id: "review", title: "打开原生复核入口，不创建或启动", inputSchema: STAGE_DEBUG_REVIEW_SCHEMA,
          outputSchema: STAGE_DEBUG_REVIEW_RESULT_SCHEMA, requiredPermissions: ["platform.read"], cancellable: true, idempotency: "keyed" }
      ]
    },
    read,
    // No watch contract is claimed. Consumers explicitly refresh authoritative native data.
    async act(context, action, raw) {
      try {
        const current = native(context)
        if (action === "inspect") {
          const parsed = inspectInput.safeParse(raw)
          if (!parsed.success) fail("PUBLIC_INPUT_INVALID")
          const { kind, offset, limit } = parsed.data
          const view = dependencies.debug().list(current)
          const rows = kind === "drafts" ? dependencies.drafts(current.scope).map((draft) => ({
            id: draft.id, name: draft.name.slice(0, 100), revision: draft.revision, digest: draft.digest
          })) : kind === "snapshots" ? view.snapshots.map((snapshot) => ({
            id: snapshot.id, projectId: snapshot.projectId, stageId: snapshot.stageId,
            stageTitle: snapshot.stageTitle.slice(0, 100), sourceDigest: snapshot.sourceDigest,
            createdAt: snapshot.createdAt, fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes
          })) : view.branches.map((branch) => ({
            id: branch.id, projectId: branch.projectId, sourceProjectId: branch.sourceProjectId,
            snapshotId: branch.snapshotId, stageId: branch.stageId, mode: branch.mode,
            status: branch.status, candidateDigest: branch.candidateDigest,
            currentCandidateMatches: branch.currentCandidateMatches,
            diagnostics: diagnostics(branch.diagnostics)
          }))
          current.guard()
          return bounded({ kind, offset, total: rows.length, items: rows.slice(offset, offset + limit),
            ...(offset + limit < rows.length ? { nextOffset: offset + limit } : {}) })
        }
        if (action === "prepare") {
          const parsed = prepareInput.safeParse(raw)
          if (!parsed.success) fail("PUBLIC_INPUT_INVALID")
          expire()
          if (plans.size + preparing >= 32) fail("PUBLIC_PLAN_LIMIT")
          preparing++
          try {
            const preparation = await dependencies.debug().prepare(current, {
              ...parsed.data, threadId: current.scope.threadId
            })
            current.guard()
            if (preparation.candidateDigest !== parsed.data.expectedDigest ||
              preparation.snapshotId !== parsed.data.snapshotId || preparation.mode !== parsed.data.mode ||
              preparation.affectedStageIds.length > 64) fail("PUBLIC_PLAN_INVALID")
            const planId = randomUUID()
            const answer = bounded({ planId, snapshotId: preparation.snapshotId,
              stageId: preparation.stageId, mode: preparation.mode, candidateDigest: preparation.candidateDigest,
              affectedStageIds: preparation.affectedStageIds, diagnostics: diagnostics(preparation.diagnostics),
              canReview: preparation.canCreate && !!dependencies.openReview, executionGranted: false })
            plans.set(planId, { owner: owner(context, current.scope), input: parsed.data,
              preparation, createdAt: Date.now(), busy: false, opened: false })
            return answer
          } finally { preparing-- }
        }
        if (action !== "review") fail("PUBLIC_ACTION_UNSUPPORTED")
        const parsed = reviewInput.safeParse(raw)
        if (!parsed.success) fail("PUBLIC_INPUT_INVALID")
        if (!dependencies.openReview) fail("REVIEW_UNAVAILABLE")
        expire()
        const plan = plans.get(parsed.data.planId)
        if (!plan || plan.owner !== owner(context, current.scope) || plan.busy || plan.opened)
          fail("PUBLIC_PLAN_UNKNOWN")
        plan.busy = true
        try {
          // Re-run original source/version/contract/config checks before navigating. A fresh
          // native preparation remains an intention; original create checks again on user click.
          const preparation = await dependencies.debug().prepare(current, {
            ...plan.input, threadId: current.scope.threadId
          })
          current.guard()
          if (!preparation.canCreate || preparation.candidateDigest !== plan.preparation.candidateDigest ||
            preparation.snapshotId !== plan.preparation.snapshotId || preparation.mode !== plan.preparation.mode ||
            JSON.stringify(preparation.affectedStageIds) !== JSON.stringify(plan.preparation.affectedStageIds))
            fail("PUBLIC_PLAN_CHANGED")
          const result = await dependencies.openReview({ context, scope: current.scope, preparation,
            draftId: plan.input.draftId, revision: plan.input.revision, assertCurrent: current.guard })
          current.guard()
          plan.opened = result.requested === true
          return { requested: plan.opened, queued: result.queued === true, executionGranted: false }
        } finally { plan.busy = false }
      } catch (error) {
        context.assertCurrent()
        throw Error(safeCode(error))
      }
    },
    close() { plans.clear() }
  }
}
