import { tool } from "langchain"
import { z } from "zod"
import { getCreatorBusinessService } from "../../mods/devtools/creator-business"
import { getModDevelopmentService } from "../../mods/devtools/development-service"
import { getLocalThreadRunLease, captureLocalThreadRunLease } from "../thread-run-lease"
import { CREATOR_REQUEST_LIMITS } from "../../mods/devtools/creator-request-budget"
import {
  BusinessDraftLimitError,
  businessDraftLimitHint
} from "../../mods/devtools/creator-business-draft"
import type { BusinessModInspection } from "../../../shared/business-mods"
import {
  BusinessModDuplicateIdError,
  BUSINESS_MOD_DUPLICATE_ID_CODE,
  BUSINESS_MOD_DUPLICATE_ID_RECOVERY
} from "../../plugins/business-mod-diagnostics"

const RESULT_PAGE_CHARS = 14_000
function pageRows<T>(rows: T[], cursor = 0, budget = RESULT_PAGE_CHARS) {
  if (cursor > rows.length) throw Error("BUSINESS_CREATOR_CURSOR_INVALID")
  const page: T[] = []
  let size = 0
  for (const row of rows.slice(cursor)) {
    const length = JSON.stringify(row).length + 1
    if (size + length > budget) {
      if (!page.length) throw Error("BUSINESS_CREATOR_ROW_REQUIRES_DOCUMENT")
      break
    }
    page.push(row)
    size += length
  }
  return {
    page,
    cursor,
    total: rows.length,
    ...(cursor + page.length < rows.length ? { nextCursor: cursor + page.length } : {})
  }
}
function inspectionResult(view: BusinessModInspection, cursor = 0) {
  const { page, ...paging } = pageRows(view.mods ?? [], cursor)
  return {
    id: view.id,
    sourceName: view.sourceName,
    sourceDigest: view.sourceDigest,
    ...(view.kernel ? { kernel: view.kernel } : {}),
    mods: page,
    ...paging,
    excludedCount: view.excluded?.length ?? 0,
    warningCount: view.warnings?.length ?? 0,
    detailAction: "read_mod(inspectionId,modId); assets(inspectionId,cursor)"
  }
}
/** Documents are exact, reconstructable JSON pages. No global tool eviction exemption. */
function documentResult(value: unknown, cursor = 0) {
  const json = JSON.stringify(value)
  if (!cursor && json.length <= RESULT_PAGE_CHARS) return value
  if (cursor > json.length) throw Error("BUSINESS_CREATOR_CURSOR_INVALID")
  let end = Math.min(json.length, cursor + 10_000)
  while (JSON.stringify(json.slice(cursor, end)).length > RESULT_PAGE_CHARS)
    end = cursor + Math.floor((end - cursor) / 2)
  return {
    format: "json-pages",
    cursor,
    totalCharacters: json.length,
    jsonChunk: json.slice(cursor, end),
    ...(end < json.length ? { nextCursor: end } : {}),
    instruction:
      "Concatenate jsonChunk pages in cursor order, then parse JSON. Reuse the same action and exact source identity with nextCursor."
  }
}

/** Business authoring does not share the restricted pure-function source compiler. */
export function createModBusinessTool(input: {
  threadId: string
  workspace: string
  signal?: AbortSignal
}) {
  const lease = getLocalThreadRunLease(input.threadId),
    owns = captureLocalThreadRunLease(input.threadId)
  const development = getModDevelopmentService()
  const creator = development?.captureCreatorMode?.(input.threadId, input.workspace)
  const started = performance.now()
  let operations = 0
  return tool(
    async (args) => {
      try {
        const assertTurn = () => {
          input.signal?.throwIfAborted()
          if (
            !lease ||
            lease.owner !== "desktop" ||
            !owns?.() ||
            !development?.isCreatorMode(input.threadId, input.workspace)
          )
            throw Error("DEVELOPMENT_TURN_CHANGED")
          creator?.()
        }
        assertTurn()
        development!.claimAuthoringBudget(input.threadId, lease!.runId, "operation")
        if (
          ++operations > CREATOR_REQUEST_LIMITS.operations ||
          performance.now() - started > CREATOR_REQUEST_LIMITS.durationMs
        )
          throw Error("DEVELOPMENT_TURN_BUDGET")
        const service = getCreatorBusinessService()
        if (!service) throw Error("BUSINESS_CREATOR_UNAVAILABLE")
        let result: unknown
        switch (args.action) {
          case "catalog":
            {
              const catalog = service.catalog(input.threadId)
              const { page, ...paging } = pageRows(
                [
                  ...catalog.sources.map((source) => ({ kind: "source" as const, value: source })),
                  ...catalog.drafts.map((draft) => ({ kind: "draft" as const, value: draft }))
                ],
                args.cursor
              )
              result = {
                sources: page.filter((row) => row.kind === "source").map((row) => row.value),
                drafts: page.filter((row) => row.kind === "draft").map((row) => row.value),
                ...paging,
                sourceCount: catalog.sources.length,
                draftCount: catalog.drafts.length,
                bundledExamples: catalog.bundledExamples,
                ...(catalog.review
                  ? {
                      review: {
                        planId: catalog.review.planId,
                        phase: catalog.review.phase,
                        name: catalog.review.name,
                        digest: catalog.review.digest
                      }
                    }
                  : {})
              }
            }
            break
          case "status":
            result = documentResult(service.status(input.threadId), args.cursor)
            break
          case "example":
            if (!args.exampleId) throw Error("BUSINESS_CREATOR_EXAMPLE_REQUIRED")
            result = documentResult(
              await service.example(input.threadId, args.exampleId),
              args.cursor
            )
            break
          case "inspect":
            if (args.inspectionId)
              result = inspectionResult(
                await service.inspectionPage(input.threadId, args.inspectionId),
                args.cursor
              )
            else {
              if (!args.pluginId) throw Error("BUSINESS_CREATOR_PLUGIN_REQUIRED")
              result = inspectionResult(
                await service.inspect(input.threadId, args.pluginId),
                args.cursor
              )
            }
            break
          case "read_mod":
            if (!args.inspectionId || !args.modId) throw Error("BUSINESS_CREATOR_MOD_REQUIRED")
            result = documentResult(
              await service.readMod(input.threadId, args.inspectionId, args.modId),
              args.cursor
            )
            break
          case "read_preview":
            if (!args.previewId) throw Error("BUSINESS_CREATOR_PREVIEW_REQUIRED")
            result = documentResult(
              await service.previewDetails(input.threadId, args.previewId),
              args.cursor
            )
            break
          case "assets":
            if (!args.inspectionId) throw Error("BUSINESS_CREATOR_ASSET_REQUIRED")
            {
              const listed = await service.assets(input.threadId, args.inspectionId, args.cursor)
              const { page } = pageRows(listed.files)
              const cursor = args.cursor ?? 0
              result = {
                sourceDigest: listed.sourceDigest,
                total: listed.total,
                files: page,
                ...(cursor + page.length < listed.total ? { nextCursor: cursor + page.length } : {})
              }
            }
            break
          case "read_asset":
            if (!args.inspectionId || !args.path) throw Error("BUSINESS_CREATOR_ASSET_REQUIRED")
            result = documentResult(
              await service.readAsset(input.threadId, args.inspectionId, args.path),
              args.cursor
            )
            break
          case "read":
            if (!args.id) throw Error("BUSINESS_DRAFT_ID_REQUIRED")
            result = documentResult(service.read(input.threadId, args.id), args.cursor)
            break
          case "save": {
            if (
              !args.id ||
              !args.name ||
              args.revision === undefined ||
              !args.inspectionId ||
              !args.files
            )
              throw Error("BUSINESS_DRAFT_INPUT_REQUIRED")
            development!.claimAuthoringBudget(input.threadId, lease!.runId, "candidate")
            const saved = service.save(input.threadId, {
              id: args.id,
              name: args.name,
              revision: args.revision,
              baseInspectionId: args.inspectionId,
              modules: args.modules ?? [],
              extensions: args.extensions,
              files: args.files
            })
            result = {
              id: saved.id,
              name: saved.name,
              revision: saved.revision,
              digest: saved.digest,
              ...(saved.catalog
                ? {
                    modIds: [...saved.catalog.modules, ...(saved.catalog.extensions ?? [])].map(
                      (mod) => mod.id
                    )
                  }
                : {}),
              sourceAction: "read(id,cursor)"
            }
            break
          }
          case "preview":
            if (!args.name || !args.version || !args.sources)
              throw Error("BUSINESS_CREATOR_COMPOSITION_REQUIRED")
            {
              const preview = await service.preview(input.threadId, {
                name: args.name,
                version: args.version,
                sources: args.sources,
                drafts: args.drafts,
                order: args.order,
                acceptFixedWorkflow: args.acceptFixedWorkflow,
                verifiedArtifactIds: args.verifiedArtifactIds
              })
              const { page } = pageRows(preview.diagnostics ?? [], 0, 4000)
              result = {
                previewId: preview.previewId,
                digest: preview.digest,
                name: preview.name,
                version: preview.version,
                valid: preview.valid,
                requiresFixedWorkflowAcknowledgement: preview.requiresFixedWorkflowAcknowledgement,
                steps: preview.steps?.map((step) => ({
                  id: step.id,
                  title: step.title.slice(0, 100)
                })),
                extensions: preview.extensions?.map((mod) => ({
                  id: mod.id,
                  title: mod.title.slice(0, 100)
                })),
                fileCount: preview.files?.length ?? 0,
                diagnostics: page,
                diagnosticCount: preview.diagnostics?.length ?? 0,
                detailsAction: "read_preview(previewId,cursor)"
              }
            }
            break
          case "request_trial":
            if (!args.previewId || !args.goal) throw Error("BUSINESS_TRIAL_GOAL_REQUIRED")
            {
              const status = await service.requestTrialPreview(
                input.threadId,
                args.previewId,
                args.goal,
                lease!.runId,
                assertTurn
              )
              result = {
                trial: status.trial
                  ? {
                      id: status.trial.id,
                      planId: status.trial.planId,
                      digest: status.trial.digest,
                      phase: status.trial.phase,
                      canPrepare: status.trial.canPrepare
                    }
                  : undefined,
                detailsAction: "status(cursor)"
              }
            }
            break
          case "request_review":
            if (!args.previewId) throw Error("BUSINESS_CREATOR_PREVIEW_REQUIRED")
            result = await service.requestReview(
              input.threadId,
              args.previewId,
              lease!.runId,
              assertTurn
            )
            if (JSON.stringify(result).length > RESULT_PAGE_CHARS) {
              const status = result as ReturnType<typeof service.status>,
                review = status.review
              result = {
                draftCount: status.drafts.length,
                ...(review
                  ? {
                      review: {
                        planId: review.planId,
                        phase: review.phase,
                        name: review.name,
                        version: review.version,
                        digest: review.digest,
                        copyId: review.copyId,
                        canConfirm: review.canConfirm,
                        exportOnly: review.exportOnly
                      }
                    }
                  : {}),
                detailsAction: "status(cursor)"
              }
            }
            break
        }
        assertTurn()
        return JSON.stringify({ ok: true, result })
      } catch (error) {
        const code =
          error instanceof BusinessModDuplicateIdError
            ? error.code
            : error instanceof Error && error.message !== BUSINESS_MOD_DUPLICATE_ID_CODE &&
                /^[A-Z][A-Z0-9_]+$/.test(error.message)
              ? error.message
              : "BUSINESS_CREATOR_OPERATION_FAILED"
        return JSON.stringify({
          ok: false,
          error: code,
          ...(error instanceof BusinessModDuplicateIdError
            ? { modId: error.modId, recovery: BUSINESS_MOD_DUPLICATE_ID_RECOVERY }
            : {}),
          ...(error instanceof BusinessDraftLimitError
            ? { limit: error.reason, recovery: businessDraftLimitHint(error.reason) }
            : {}),
          hint: "保留当前插件和草稿。用 catalog/inspect 核对真实来源；preview 必须解决依赖与知识诊断，不得删原 Hooks、知识入口或产物校验来通过。request_review 只准备原生确认卡，不安装、不授权、不执行业务。来源/版本变化需重新预览；unknown 停止并核对原事务，不自动重放。预算耗尽不新开请求绕过。"
        })
      }
    },
    {
      name: "mod_business",
      description:
        "request_trial(previewId,goal) prepares this exact checked candidate for an isolated native-confirmed trial, without installing it. End this turn; the user confirms allocation, fills original configuration, grants the exact package source and selects original business context before starting the original project/managed runner. status includes real trial/run observations and saved feedback; physical cleanup is separate from business completion. Do not claim prepared means executed or passed. Changed candidates need a fresh trial/directory; unknown is never replayed. " +
        "catalog includes bundledExamples shipped SDK source templates. If knowledge-sync/context support is missing, example(exampleId:autobiz-knowledge,cursor?) provides actual Python, native Skill and extension declarations without preinstalling a source plugin; concatenate exact pages then save draft.extensions and all files using the actual inspected kernel. No example grants installation or source authority. All list responses are bounded: catalog(cursor), inspect(pluginId) then inspect(inspectionId,cursor) for nextCursor pages. read_mod(inspectionId,modId,cursor) reads one exact contract. read_preview(previewId,cursor) reads full frozen preview including files and diagnostics. Large read/read_asset/read_mod/read_preview/status documents return json-pages; concatenate jsonChunk in cursor order then parse JSON, always retaining the same identity. assets(inspectionId,cursor?) pages actual declared source paths/digests before read_asset; do not guess Python interfaces. " +
        "Create and compose real business Mods, including Python validators, Skills and namespaced function extensions. This is independent of the pure-function compiler. catalog lists actual installed source plugin IDs and current-chat persistent drafts. inspect(pluginId) returns a bounded native inspectionId plus exact catalog/kernel identity; read_asset(inspectionId,path) reads only declared resources, never credentials or arbitrary host paths. save(id,name,revision,inspectionId,modules?,extensions?,files) creates/updates an independent kernelRef-only Mod draft; use exact returned revision. All source files must stay inside each declared skills/<skill>/ or mods/business/<modId>/ namespace. Supply real module node/artifact/input/output/validator definitions and implementation files, not placeholder success. The host binds the kernel identity from the inspected installed source; drafts cannot replace trusted kernel files. read(id) recovers source; catalog lists drafts after restart. preview(name,version,sources:[{inspectionId,modIds}],drafts?:[{id,revision,modIds}],order?,acceptFixedWorkflow?) uses the original assembler with required dependency closure and preserves knowledge/Hooks. Inspect each real source first, include exactly one kernel source, and add the chosen draft Mods. Resolve diagnostics; acknowledgement does not fill missing resources. request_review(previewId) materializes/checks the exact package and shows trusted install/export controls in this chat. End this turn for confirmation; it never installs, approves, grants permissions, exports to a model-supplied path or executes a business stage. New source/revision requires a fresh preview/review. For an already installed output name, request_review yields an exportOnly candidate: export the update ZIP and use the original Install Plugin confirmation to update while retaining its UUID and configuration; permission changes require fresh confirmation. Do not claim the create-only installer updated it. Unknown effects are never retried. Stage rollback/debug is not provided.",
      schema: z
        .object({
          action: z.enum([
            "catalog",
            "example",
            "status",
            "inspect",
            "read_mod",
            "read_preview",
            "assets",
            "read_asset",
            "read",
            "save",
            "preview",
            "request_review",
            "request_trial"
          ]),
          pluginId: z.string().min(1).max(256).optional(),
          exampleId: z.enum(["autobiz-knowledge"]).optional(),
          cursor: z.number().int().min(0).max(2_000_000).optional(),
          modId: z.string().min(1).max(80).optional(),
          inspectionId: z.string().uuid().optional(),
          path: z.string().min(1).max(512).optional(),
          id: z
            .string()
            .regex(/^[a-z][a-z0-9-]{0,63}$/)
            .optional(),
          name: z.string().min(1).max(80).optional(),
          revision: z.number().int().min(0).optional(),
          version: z.string().max(80).optional(),
          previewId: z.string().uuid().optional(),
          goal: z.string().min(1).max(8000).optional(),
          modules: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
          extensions: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
          files: z
            .array(z.object({ path: z.string().max(160), text: z.string().max(65536) }).strict())
            .max(32)
            .optional(),
          sources: z
            .array(
              z
                .object({
                  inspectionId: z.string().uuid(),
                  modIds: z.array(z.string().max(80)).max(64)
                })
                .strict()
            )
            .max(8)
            .optional(),
          drafts: z
            .array(
              z
                .object({
                  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
                  revision: z.number().int().min(1),
                  modIds: z.array(z.string().max(80)).max(64)
                })
                .strict()
            )
            .max(4)
            .optional(),
          order: z.array(z.string().max(80)).max(32).optional(),
          acceptFixedWorkflow: z.boolean().optional(),
          verifiedArtifactIds: z
            .array(z.string().regex(/^[a-zA-Z0-9][\w.-]{0,79}$/))
            .min(1)
            .max(64)
            .optional()
        })
        .strict()
    }
  )
}
