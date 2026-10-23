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
  businessModCatalogSchema,
  BusinessModCatalogValidationError
} from "../../plugins/business-mod-catalog-schema"
import {
  BusinessModDuplicateIdError,
  BUSINESS_MOD_DUPLICATE_ID_CODE,
  BUSINESS_MOD_DUPLICATE_ID_RECOVERY
} from "../../plugins/business-mod-diagnostics"
import {
  BusinessWorkflowLinkError,
  BusinessWorkflowSkillRenameError,
  type BusinessWorkflowChange
} from "../../plugins/business-workflow-transform"

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
          case "modularization_schema":
            result = documentResult(
              {
                schema: z.toJSONSchema(businessModCatalogSchema),
                rules: [
                  "First modularization requires kernel, not kernelRef. Use exact inspected package paths and original node objects; never invent dependencies or checks.",
                  "kernel.runtime.adapter=host-linear-v1 forbids boardConfigPath and requires modules[].host with real native checks. The reviewed legacy adapter autobiz-v1 requires boardConfigPath and forbids modules[].host; do not relabel a legacy board as Host.",
                  "Each module requires id,title,node,skill:{entry,resources},resources,dependencies:{required,advisory},checks:{validators,guards}. id equals node.id; skill.entry ends with /<node.skill>/SKILL.md. checks match node.validators/guards.",
                  "kernel.pluginFields must preserve original hooks,mcpServers,userConfig,keywords,useScenario. Declare the full source resource closure including Hooks, configuration, knowledge, scripts and relative references.",
                  "Keep module skill entries and their relative directory closure in that module's skill.resources. kernel.resources contains shared resources and auxiliary Skills, excluding all modules[].skill.entry and source plugin manifests; boardConfigPath is derived by its reviewed adapter. Do not use a whole skills/ kernel resource when it contains module entries.",
                  "The schema checks structure only. The native parser, reviewed adapter and resource/contract preservation checks remain authoritative. Inspect structured diagnostics before revising the same proposal.",
                  "A business assembly catalog is not an executable state-policy migration. Inspect inspect_raw.stateControl: retain existing Host authority; legacy/original writers and all Hooks, configuration, knowledge and checks remain authoritative. Use mod_authoring scaffold(kind:state-extension) for an actual Function Mod decision scaffold, then bind and test the original writer. Unknown graph edges require author confirmation; static candidates remain execution-unverified."
                ]
              },
              args.cursor
            )
            break
          case "inspect_raw":
            if (args.rawInspectionId)
              result = documentResult(
                await service.readRawInspection(input.threadId, args.rawInspectionId),
                args.cursor
              )
            else {
              if (!args.pluginId) throw Error("BUSINESS_CREATOR_PLUGIN_REQUIRED")
              result = documentResult(
                await service.inspectRaw(input.threadId, args.pluginId),
                args.cursor
              )
            }
            break
          case "read_raw_asset":
            if (!args.rawInspectionId || !args.path) throw Error("BUSINESS_CREATOR_ASSET_REQUIRED")
            result = documentResult(
              await service.readRawAsset(input.threadId, args.rawInspectionId, args.path),
              args.cursor
            )
            break
          case "request_modularization":
            if (!args.rawInspectionId || !args.sourceDigest)
              throw Error("PLUGIN_MODULARIZATION_INSPECT_FIRST")
            development!.claimAuthoringBudget(input.threadId, lease!.runId, "candidate")
            {
              const status = await service.requestModularization(
                input.threadId,
                {
                  rawInspectionId: args.rawInspectionId,
                  sourceDigest: args.sourceDigest,
                  catalog: args.modularizationCatalog,
                  modularizationFiles: args.modularizationFiles
                },
                lease!.runId,
                assertTurn
              )
              const modularization = status.modularization
              result = {
                ...(modularization
                  ? {
                      modularization: {
                        requestId: modularization.requestId,
                        sourceDigest: modularization.sourceDigest,
                        sourceName: modularization.sourceName,
                        phase: modularization.phase,
                        resources: modularization.resources,
                        modCount: modularization.mods.length,
                        canConfirm: modularization.canConfirm
                      }
                    }
                  : {}),
                detailsAction: "status(cursor)"
              }
            }
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
          case "read_workflow":
            if (!args.inspectionId) throw Error("BUSINESS_CREATOR_INSPECT_FIRST")
            result = documentResult(
              await service.readWorkflow(input.threadId, args.inspectionId, args.id, args.modIds),
              args.cursor
            )
            break
          case "transform_workflow":
            if (
              !args.inspectionId ||
              !args.id ||
              !args.name ||
              args.revision === undefined ||
              !args.sourceDigest ||
              !args.expectedWorkflowDigest ||
              !args.changes ||
              !args.files
            )
              throw Error("BUSINESS_WORKFLOW_TRANSFORM_INPUT_REQUIRED")
            development!.claimAuthoringBudget(input.threadId, lease!.runId, "candidate")
            {
              const transformed = await service.transformWorkflow(
                input.threadId,
                {
                  inspectionId: args.inspectionId,
                  id: args.id,
                  name: args.name,
                  revision: args.revision,
                  sourceDigest: args.sourceDigest,
                  expectedWorkflowDigest: args.expectedWorkflowDigest,
                  modIds: args.modIds,
                  changes: args.changes as BusinessWorkflowChange[],
                  files: args.files
                },
                assertTurn
              )
              result = {
                draft: transformed.draft,
                sourceDigest: transformed.sourceDigest,
                workflowDigest: transformed.workflow.digest,
                order: transformed.order,
                changedIds: transformed.changedIds,
                replacements: transformed.replacements,
                evidence: transformed.evidence,
                execution: transformed.execution,
                sourceAction: "read(id,cursor)",
                workflowAction: "read_workflow(inspectionId,id,cursor)",
                next: transformed.next
              }
            }
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
                ...("projectTrial" in status && status.projectTrial
                  ? {
                      trialRoute: "trialRoute" in status ? status.trialRoute : undefined,
                      executed: "executed" in status ? status.executed : undefined,
                      projectTrial: {
                        id: status.projectTrial.id,
                        draftId: status.projectTrial.draftId,
                        name: status.projectTrial.name,
                        revision: status.projectTrial.revision,
                        digest: status.projectTrial.digest,
                        ...(status.projectTrial.origin
                          ? { origin: status.projectTrial.origin }
                          : {}),
                        ...(status.projectTrial.journey
                          ? {
                              journey: {
                                projectId: status.projectTrial.journey.projectId,
                                candidateDigest: status.projectTrial.journey.candidateDigest,
                                phase: status.projectTrial.journey.phase,
                                canDeliver: status.projectTrial.journey.canDeliver,
                                operationsTruncated:
                                  status.projectTrial.journey.operationsTruncated,
                                stages: status.projectTrial.journey.stages.map(
                                  ({ id, status }) => ({ id, status })
                                )
                              }
                            }
                          : {})
                      }
                    }
                  : {}),
                trial: status.trial
                  ? {
                      id: status.trial.id,
                      planId: status.trial.planId,
                      digest: status.trial.digest,
                      phase: status.trial.phase,
                      canPrepare: status.trial.canPrepare
                    }
                  : undefined,
                detailsAction:
                  "projectTrial" in status && status.projectTrial
                    ? "Use mod_authoring project_list/project_read(id=projectTrial.draftId) to read the original trial request and native journey in this creator conversation; preparation is not execution or validation success."
                    : "status(cursor)"
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
          error instanceof BusinessModCatalogValidationError
            ? error.code
            : error instanceof BusinessModDuplicateIdError
              ? error.code
              : error instanceof Error &&
                  error.message !== BUSINESS_MOD_DUPLICATE_ID_CODE &&
                  /^[A-Z][A-Z0-9_]+$/.test(error.message)
                ? error.message
                : "BUSINESS_CREATOR_OPERATION_FAILED"
        return JSON.stringify({
          ok: false,
          error: code,
          ...(error instanceof BusinessModCatalogValidationError
            ? {
                diagnostics: error.diagnostics,
                recovery:
                  "读取 modularization_schema，按 diagnostics.path 修复同一迁移计划并重新请求；保留原插件、Hooks、配置、知识、检查与产物。未准备确认卡。"
              }
            : {}),
          ...(error instanceof BusinessWorkflowLinkError
            ? {
                diagnostics: error.diagnostics.slice(0, 12),
                diagnosticCount: error.diagnostics.length,
                recovery:
                  "保留原草稿和校验。read_workflow 核对真实产物path/schemaVersion、上游生产者和常驻依赖；补齐实现后使用当前digest重做同一事务。未保存失败变更，未执行状态推进。"
              }
            : {}),
          ...(error instanceof BusinessWorkflowSkillRenameError
            ? {
                recovery:
                  "原插件声明了 Hooks，技能名称可能参与 matcher 或脚本查找。保留原 Skill 名称修改正文；需要改名时先由插件作者明确迁移 Hooks 和所有名称引用并重新验证。本工具不会自动重写 Hook 映射，失败变更未保存。新加入的草稿步骤和无 Hooks 的 Host 技能不受此项限制。"
              }
            : {}),
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
        "Dialogue revisions use the native inspected source as the protection baseline, not the first unpublished draft: author-created new steps and author-added constraints may be refined in later revisions. Original source requirements, Hooks and resources remain protected. protectedModules is native-only and is not a tool argument. A changed schemaVersion still requires compatible upstream/downstream versions, and every successful change invalidates old preview/trial evidence. " +
        "Hook-bound Skill identities: when the original kernel declares hooks, transform_workflow and preview reject renaming an original Skill with BUSINESS_WORKFLOW_SKILL_RENAME_REQUIRES_HOOK_MAPPING. Keep its original name and edit its prompt, or first provide an explicitly reviewed plugin-side migration of every Hook matcher and script name reference. Do not claim Hook mappings are automatically rewritten. Newly authored draft steps may be renamed; original Host Skills without declared Hooks may also be renamed. " +
        "Workflow source preservation: transform_workflow retains large original resources as exact base digest references while keeping the author code budget unchanged. Follow its next.requiredSourceModIds and next.requiredDraftModIds. A transformed preview automatically retains every original and saved Function Mod, including knowledge and state extensions; do not drop these to pass admission. Editing declarations does not automatically rewrite an old hard-coded state Mod: use a compatible dynamic state implementation, or author and execute a freshly approved update before claiming support. " +
        "For workflow changes first read_workflow(inspectionId,modIds?,id?) to get sourceDigest, workflow digest, exact selected ordered stages, inputs/outputs/checks and declared transitions. transform_workflow(id,name,revision,inspectionId,sourceDigest,expectedWorkflowDigest,modIds?,changes,files) applies a bounded atomic authoring transaction. changes supports insert(before,module), replace_step(id,module), and replace_skill(id,skillName,skill:{entry,resources}); supply complete real declarations and namespaced implementation files. For the first change pass revision:0 and the selected original modIds; for later edits read_workflow(id,inspectionId) and use its exact revision/digest. It preserves original required checks, outputs, inputs, knowledge resource closure, configuration and native approvals; unknown producer/version, removed guard or stale digest blocks save. It creates an independent persistent draft, never edits installed source or running state. preview with the returned draft and original kernel performs explicit source-bound replacements; read review, obtain fresh native trial approval and execute positive/negative business cases before requesting installation/export. Every changed revision invalidates earlier execution evidence. Contract compilation is unverified business execution; native Host remains the state owner in Host mode, while declared legacy writers retain state authority. The view shows the selected linear assembly route, not an inferred arbitrary business graph. " +
        "example(exampleId:autobiz-state-machine,cursor?) returns the shipped executable AutoBiz Function Mod, graph, real Python adapter/commit/journal/stage checks and auxiliary Skill for the compatible inspected original-234 kernel. Save its full draft.extensions/files, preview with the actual kernel, then request_trial; no author-machine output directory is required. Source discovery/compile is not business migration success and grants no permissions. " +
        "inspect_raw includes machine-readable stateControl with original writer candidates, Hooks/configuration/knowledge source paths and explicit unverified migration status. Already-modular only means business assembly metadata exists, never that state control has migrated to an executable Mod. Keep Host authority unchanged; for original plugin state use mod_authoring scaffold(kind:state-extension), preserve and bind its unique writer and original checks, then perform real approved tests. Unknown business graphs require author confirmation; do not guess edges, emit fake passed/committed receipts or delete old Hooks. " +
        "request_modularization also accepts modularizationFiles:[{path,text}] for a classic Skill-only plugin needing a first Host contract, extra Skills or knowledge. These are additive-only bounded text files (32 files, 64 KiB each, 256 KiB total) under skills/, mods/business/, tests/, knowledge/, references/, scripts/, agents/ or workflows/. Include real tests/project-contract.json and all new resources in the explicit catalog closure. No original file, identity, runtime or credential path can be overwritten; case and parent/file collisions fail. Original sourceDigest remains the approval anchor. The native card lists every added file digest; changed additions require a new request and confirmation. Added code is not executed by source materialization, and Host trial and source permissions remain separate native confirmation. " +
        "For an original plugin without business Mods, inspect_raw(pluginId) first. It returns a native rawInspectionId, immutable sourceDigest, file inventory and either a static Host catalog candidate or explicit migration blockers. To read later pages, reuse inspect_raw(rawInspectionId,cursor); read_raw_asset(rawInspectionId,path,cursor) reads filtered UTF-8 source assets up to 1 MiB with credential display redaction and exact JSON document pages. Preserve original Hooks, knowledge/context, configuration and checks. Before authoring modularizationCatalog, read modularization_schema(cursor?) for its native JSON schema and adapter rules. For unknown/legacy workflows, author a complete catalog using the reviewed static adapters, never guess dependencies or execute an invented adapter. Rejections return bounded diagnostics.path/code/message; repair the same plan from those diagnostics, never delete original constraints to pass. request_modularization(rawInspectionId,sourceDigest,modularizationCatalog?) prepares an additive native confirmation card; end the turn. It does not write or install. Only the user can approve creation of a private full-source candidate. After confirmation, status.modularization.inspectionId is an ordinary assembly inspectionId: inspect it, preview selected Mods, request_trial, then request_review for separate install/export confirmation. A static candidate is not a successful business trial. Original source changes invalidate it; approval is not restored after restart. " +
        "request_trial(previewId,goal) prepares this exact checked candidate for an isolated native-confirmed trial, without installing it. End this turn; the user confirms allocation, fills original configuration, grants the exact package source and selects original business context before starting the original project/managed runner. status includes real trial/run observations and saved feedback; physical cleanup is separate from business completion. Do not claim prepared means executed or passed. Changed candidates need a fresh trial/directory; unknown is never replayed. " +
        "catalog includes bundledExamples shipped SDK source templates. If knowledge-sync/context support is missing, example(exampleId:autobiz-knowledge,cursor?) provides actual Python, native Skill and extension declarations without preinstalling a source plugin; concatenate exact pages then save draft.extensions and all files using the actual inspected kernel. No example grants installation or source authority. All list responses are bounded: catalog(cursor), inspect(pluginId) then inspect(inspectionId,cursor) for nextCursor pages. read_mod(inspectionId,modId,cursor) reads one exact contract. read_preview(previewId,cursor) reads full frozen preview including files and diagnostics. Large read/read_asset/read_mod/read_preview/status documents return json-pages; concatenate jsonChunk in cursor order then parse JSON, always retaining the same identity. assets(inspectionId,cursor?) pages actual declared source paths/digests before read_asset; do not guess Python interfaces. " +
        "Create and compose real business Mods, including Python validators, Skills and namespaced function extensions. This is independent of the pure-function compiler. catalog lists actual installed source plugin IDs and current-chat persistent drafts. inspect(pluginId) returns a bounded native inspectionId plus exact catalog/kernel identity; read_asset(inspectionId,path) reads only declared resources, never credentials or arbitrary host paths. save(id,name,revision,inspectionId,modules?,extensions?,files) creates/updates an independent kernelRef-only Mod draft; use exact returned revision. All source files must stay inside each declared skills/<skill>/ or mods/business/<modId>/ namespace. Supply real module node/artifact/input/output/validator definitions and implementation files, not placeholder success. The host binds the kernel identity from the inspected installed source; drafts cannot replace trusted kernel files. read(id) recovers source; catalog lists drafts after restart. preview(name,version,sources:[{inspectionId,modIds}],drafts?:[{id,revision,modIds}],order?,acceptFixedWorkflow?) uses the original assembler with required dependency closure and preserves knowledge/Hooks. Inspect each real source first, include exactly one kernel source, and add the chosen draft Mods. Resolve diagnostics; acknowledgement does not fill missing resources. request_review(previewId) materializes/checks the exact package and shows trusted install/export controls in this chat. End this turn for confirmation; it never installs, approves, grants permissions, exports to a model-supplied path or executes a business stage. New source/revision requires a fresh preview/review. For an already installed output name, request_review yields an exportOnly candidate: export the update ZIP and use the original Install Plugin confirmation to update while retaining its UUID and configuration; permission changes require fresh confirmation. Do not claim the create-only installer updated it. Unknown effects are never retried. This tool cannot execute or approve stage recovery. Conditional native recovery is available only for admitted Host contracts or declared plugin recovery adapters, through the trial recovery controls and fresh user confirmation. Read mod_authoring catalog section support and follow nextCursor for the exact conditions; never promise arbitrary plugin rollback. Reconcile unknown outcomes read-only before preparing any new execution.",
      schema: z
        .object({
          action: z.enum([
            "catalog",
            "example",
            "status",
            "inspect",
            "inspect_raw",
            "modularization_schema",
            "read_raw_asset",
            "request_modularization",
            "read_mod",
            "read_workflow",
            "transform_workflow",
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
          exampleId: z.enum(["autobiz-knowledge", "autobiz-state-machine"]).optional(),
          cursor: z.number().int().min(0).max(8_000_000).optional(),
          modId: z.string().min(1).max(80).optional(),
          inspectionId: z.string().uuid().optional(),
          rawInspectionId: z.string().uuid().optional(),
          sourceDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          modularizationCatalog: z.record(z.string(), z.unknown()).optional(),
          modularizationFiles: z
            .array(
              z.object({ path: z.string().min(1).max(160), text: z.string().max(65536) }).strict()
            )
            .max(32)
            .optional(),
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
          modIds: z.array(z.string().max(80)).max(32).optional(),
          expectedWorkflowDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          changes: z
            .array(
              z.discriminatedUnion("kind", [
                z
                  .object({
                    kind: z.literal("insert"),
                    before: z.string().max(80),
                    module: z.record(z.string(), z.unknown())
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("replace_step"),
                    id: z.string().max(80),
                    module: z.record(z.string(), z.unknown())
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("replace_skill"),
                    id: z.string().max(80),
                    skillName: z.string().max(80),
                    skill: z
                      .object({
                        entry: z.string().max(512),
                        resources: z.array(z.string().max(512)).max(512)
                      })
                      .strict()
                  })
                  .strict()
              ])
            )
            .max(16)
            .optional(),
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
