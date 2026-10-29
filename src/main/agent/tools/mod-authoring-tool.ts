import { tool } from "langchain"
import {
  NativeCompositionDependencyError,
  NATIVE_COMPOSITION_PATH,
  nativeCompositionSchema
} from "../../plugins/native-composition"
import {
  evaluateNativeCompositionAction,
  nativeCompositionActionRequirements
} from "../../plugins/native-composition-dependencies"
import {
  developmentDependencyCatalogPage,
  readDevelopmentDependencySource
} from "../../mods/devtools/development-dependency-catalog"
import {
  DependencyPreparationError,
  prepareDevelopmentDependency
} from "../../mods/devtools/development-dependency-prepare"
import { z } from "zod"
import { getModDevelopmentService } from "../../mods/devtools/development-service"
import { developmentCatalogPage } from "../../mods/devtools/development-catalog"
import {
  AUTHORING_TEMPLATE_KINDS,
  createAuthoringTemplate
} from "../../mods/devtools/authoring-templates"
import {
  projectAuthoringSessions,
  ProjectDraftLimitError,
  projectDraftLimitHint
} from "../../mods/devtools/project-authoring-session"
import { pluginMigrationReport } from "../../mods/devtools/plugin-migration-report"
import {
  listMigrationAssets,
  readMigrationAsset
} from "../../mods/devtools/plugin-migration-assets"
import { getPlugins } from "../../storage"
import { captureLocalThreadRunLease, getLocalThreadRunLease } from "../thread-run-lease"
import {
  parseClawActionIdentity,
  type ClawActionDescriptor
} from "../../../shared/mods/claw-actions"
import { PROJECT_ACTION_LOCK_PATH } from "../../../shared/project-runtime/action-bindings"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FunctionUserConfigDeclarationError } from "../../../shared/mods/v2/user-config"
import { DevelopmentCandidateError } from "../../mods/devtools/development-candidate-diagnostics"
import { CREATOR_REQUEST_LIMITS } from "../../mods/devtools/creator-request-budget"
import {
  AUTHORING_BUNDLE_LIMITS,
  AuthoringSourceLimitError,
  createAuthoringSourceBundle
} from "../../mods/devtools/authoring-bundle"
import { readPureFunctionSource } from "../../mods/devtools/authoring-install-source"
import { getProjectStageDebugSessions } from "../../mods/devtools/project-stage-debug"
import { HARNESS_SOURCE_PATH } from "../../mods/devtools/project-harness"
import { projectAuthoringReadView } from "../../mods/devtools/project-authoring-view"
import { ProjectContractError } from "../../mods/devtools/project-contract"
import { ProjectAuthoringSkillMetadataError } from "../../mods/devtools/project-authoring-skill-metadata"
import { AuthoringStructureError } from "../../mods/devtools/authoring-structure-diagnostics"
import {
  ProjectDraftFileError,
  projectDraftFileHint
} from "../../mods/devtools/project-draft-file-error"
import { PROJECT_SOURCE_PATCH_LIMITS, ProjectSourcePatchError } from "../../mods/devtools/project-source-patch"

const schema = z
  .object({
    action: z.enum([
      "catalog",
      "list",
      "scaffold",
      "read",
      "save",
      "dependency_save",
      "dependency_prepare",
      "submit",
      "check",
      "request_trial",
      "resume_trial",
      "undo_trial",
      "request_reuse",
      "inspect_plugin",
      "read_plugin_asset",
      "project_scaffold",
      "project_compile",
      "project_read",
      "project_save",
      "project_patch",
      "project_doctor",
      "project_test",
      "project_dev",
      "project_request_trial",
      "project_stage_debug_list",
      "project_stage_debug_prepare",
      "project_list",
      "project_pack",
      "project_actions",
      "project_bind_action"
    ]),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,47}$/)
      .optional(),
    name: z.string().min(1).max(100).optional(),
    template: z
      .enum(["project-lite", "native-modular", "harness-lite", "harness-fullstack", "harness-data"])
      .optional(),
    revision: z.number().int().min(0).optional(),
    instruction: z.string().min(1).max(2000).optional(),
    goal: z.string().min(1).max(8000).optional(),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    sourceId: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
      .describe("dependency_prepare only: exact sourceId from catalog(project-dependencies), never a draft id, file path or installation identity.")
      .optional(),
    debugMode: z.enum(["stage", "downstream"]).optional(),
    kind: z.enum(AUTHORING_TEMPLATE_KINDS).optional(),
    files: z
      .array(z.object({ path: z.string().max(240), text: z.string().max(65536) }))
      .min(1)
      .max(AUTHORING_BUNDLE_LIMITS.files)
      .optional(),
    sourcePatch: z.array(z.object({
      op: z.enum(["add", "replace", "remove", "test"]),
      path: z.string().min(1).max(PROJECT_SOURCE_PATCH_LIMITS.pathCharacters),
      value: z.unknown().optional()
    }).strict()).min(1).max(PROJECT_SOURCE_PATCH_LIMITS.operations)
      .describe("project_patch only: strict JSON Pointer changes to composition/source.json only. add/replace/test require value; remove forbids value. Can accompany files atomically; cannot accompany a complete composition/source.json file.")
      .optional(),
    pluginId: z.string().min(1).max(200).optional(),
    query: z.string().trim().min(1).max(120)
      .describe("catalog: exact event, SDK method or registration name (tool.call, ui.resolve, on.capability), with overview/types/events/sdk; returns targeted real declarations, follow nextCursor with same query. Full types remain paged without query. project_actions: case-insensitive substring of installed authorized action plugin, actionId or name, even when id is supplied.")
      .optional(),
    stageId: z.string().min(1).max(100).optional(),
    localActionId: z
      .string()
      .regex(/^[a-zA-Z0-9][\w.-]{0,63}$/)
      .optional(),
    provider: z
      .object({
        pluginId: z.string().min(1).max(256),
        plugin: z.string().min(1).max(100),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        actionId: z.string().min(1).max(80)
      })
      .strict()
      .optional(),
    actionInput: z.record(z.string(), z.unknown()).optional(),
    actionConfig: z.record(z.string(), z.unknown()).optional(),
    inputFrom: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("artifact"),
            artifactId: z.string().min(1).max(100),
            pointer: z.string().max(512)
          })
          .strict(),
        z
          .object({
            kind: z.literal("action"),
            actionId: z.string().min(1).max(64),
            pointer: z.string().max(512)
          })
          .strict()
      ])
      .optional(),
    assetPath: z.string().min(1).max(240).optional(),
    catalogSection: z.enum(["overview", "types", "events", "sdk", "support", "project-dependencies"]).optional(),
    cursor: z.number().int().min(0).max(100000).optional()
  })
  .strict()

type CurrentAuthoringDraft =
  | { id: string; exists: false; nextExpectedRevision: 0 }
  | { id: string; exists: true; revision: number; sourceDigest: string }

export function createModAuthoringTool(input: {
  threadId: string
  workspace: string
  signal?: AbortSignal
  /** Host dependency only; never accepted from the tool's model-supplied schema. */
  projectActions?: (workspace: string, threadId: string) => Promise<ClawActionDescriptor[]>
}) {
  const { threadId, workspace } = input
  const assertCreator = getModDevelopmentService()?.captureCreatorMode?.(threadId, workspace)
  const lease = getLocalThreadRunLease(threadId)
  const ownsLease = captureLocalThreadRunLease(threadId)
  let operations = 0
  let candidateAttempts = 0
  const createdAt = performance.now()
  const signal = input.signal ?? new AbortController().signal
  return tool(
    async (args) => {
      let inspectDraft: (() => CurrentAuthoringDraft) | undefined
      let inspectProjectDraft: (() => CurrentAuthoringDraft) | undefined
      try {
        const service = getModDevelopmentService()
        const assertTurn = () => {
          signal.throwIfAborted()
          if (
            !lease ||
            lease.owner !== "desktop" ||
            !ownsLease?.() ||
            !service?.isCreatorMode(threadId, workspace)
          )
            throw Error("DEVELOPMENT_TURN_CHANGED")
          assertCreator?.()
        }
        assertTurn()
        service!.claimAuthoringBudget?.(threadId, lease!.runId, "operation")
        if (++operations > CREATOR_REQUEST_LIMITS.operations ||
          performance.now() - createdAt > CREATOR_REQUEST_LIMITS.durationMs)
          throw Error("DEVELOPMENT_TURN_BUDGET")
        const id = () => {
          if (args.action === "dependency_prepare" && !args.id && args.sourceId) return args.sourceId
          if (!args.id) throw Error("DEVELOPMENT_ID_REQUIRED")
          return args.id
        }
        const revision = () => {
          if (args.revision === undefined) throw Error("DEVELOPMENT_REVISION_REQUIRED")
          return args.revision
        }
        inspectDraft = () => {
          const draftId = id()
          assertTurn()
          try {
            const document = service!.read(threadId, draftId)
            assertTurn()
            return { id: draftId, exists: true, revision: document.revision, sourceDigest: document.source.digest }
          } catch (error) {
            assertTurn()
            if (!(error instanceof Error) || error.message !== "AUTHORING_VERSION_MISSING") throw error
            return { id: draftId, exists: false, nextExpectedRevision: 0 }
          }
        }
        const assertDraftRevision = (expected: number, allowNew: boolean) => {
          const current = inspectDraft!()
          if (!current.exists && !allowNew) throw Error("AUTHORING_VERSION_MISSING")
          if ((current.exists ? current.revision : 0) !== expected)
            throw Error("AUTHORING_VERSION_CHANGED")
        }
        const attemptCandidate = () => {
          service!.assertAuthoringAvailable?.(threadId)
          const observed = service!.claimAuthoringBudget?.(threadId, lease!.runId, "candidate")
          if (observed) {
            candidateAttempts = observed.candidates
            return
          }
          if (candidateAttempts >= CREATOR_REQUEST_LIMITS.candidates)
            throw Error("DEVELOPMENT_REPAIR_BUDGET")
          candidateAttempts++
        }
        const project = () => {
          const context = service!.projectAuthoringContext(threadId)
          return {
            scope: context.scope,
            guard: () => {
              assertTurn()
              context.assertCurrent()
              service!.assertScope(context.scope)
            }
          }
        }
        inspectProjectDraft = () => {
          const context = project()
          context.guard()
          const draft = projectAuthoringSessions.read(context.scope, id())
          context.guard()
          return { id: draft.id, exists: true, revision: draft.revision, sourceDigest: draft.source.digest }
        }
        const projectCatalog = async (context: ReturnType<typeof project>) => {
          context.guard()
          const catalog =
            input.projectActions ??
            (await import("../../harness-board/project-action-runtime")).getProjectActionCatalog
          const actions = await catalog(context.scope.workspace, threadId)
          context.guard()
          return actions
        }
        let result: unknown
        switch (args.action) {
          case "project_stage_debug_list": {
            result = getProjectStageDebugSessions().list(project())
            break
          }
          case "project_stage_debug_prepare": {
            const context = project()
            if (!args.snapshotId) throw Error("PROJECT_STAGE_DEBUG_SNAPSHOT_REQUIRED")
            const candidate = projectAuthoringSessions.read(context.scope, id())
            if (candidate.revision !== revision()) throw Error("PROJECT_DRAFT_REVISION_CHANGED")
            result = await getProjectStageDebugSessions().prepare(context, {
              threadId, snapshotId: args.snapshotId, draftId: candidate.id,
              revision: candidate.revision, expectedDigest: candidate.source.digest,
              mode: args.debugMode ?? "stage"
            })
            break
          }
          case "project_actions": {
            const context = project()
            const catalog = await projectCatalog(context)
            const query = args.query?.toLowerCase()
            const matchingCatalog = query === undefined ? catalog : catalog.filter((action) =>
              [action.plugin, action.actionId, action.name].some((field) =>
                field.toLowerCase().includes(query)))
            const start = args.cursor ?? 0
            const draft = args.id && query === undefined
              ? projectAuthoringSessions.read(context.scope, args.id) : undefined
            if (draft && args.revision !== undefined && draft.revision !== args.revision)
              throw Error("PROJECT_DRAFT_REVISION_CHANGED")
            const native = draft?.source.files.find((file) => file.path === NATIVE_COMPOSITION_PATH)
            if (draft && !native) throw Error("NATIVE_COMPOSITION_SOURCE_REQUIRED")
            const requirements = native
              ? nativeCompositionActionRequirements(nativeCompositionSchema.parse(JSON.parse(native.text)))
              : []
            if (draft && !args.localActionId) {
              if (start > requirements.length) throw Error("DEVELOPMENT_CATALOG_CURSOR")
              result = {
                id: draft.id, revision: draft.revision, sourceDigest: draft.source.digest,
                requirements: requirements.slice(start, start + 4),
                nextCursor: start + 4 < requirements.length ? start + 4 : null,
                discoverAdditionalActions: { action: "project_actions", omit: "id",
                  optionalFields: ["query"] },
                next: "project_actions() or project_actions(query) discovers installed authorized actions; omit id when discovering an additional action. project_actions(id,localActionId=usedBy) evaluates one already declared requirement. Source templates: catalog(catalogSection:project-dependencies).",
                executed: false, grantsAuthority: false
              }
              break
            }
            const requirement = args.localActionId && query === undefined
              ? requirements.find((item) => item.usedBy === args.localActionId) : undefined
            if (args.localActionId && query === undefined && !requirement)
              throw Error("NATIVE_COMPOSITION_ACTION_REQUIRED")
            if (start > matchingCatalog.length) throw Error("DEVELOPMENT_CATALOG_CURSOR")
            const actions: Array<ClawActionDescriptor & {
              compositionCompatibility?: ReturnType<typeof evaluateNativeCompositionAction>
            }> = []
            let cursor = start
            while (cursor < matchingCatalog.length && actions.length < (requirement ? 1 : 4)) {
              const action = matchingCatalog[cursor]
              const candidate = { ...action, ...(requirement ? {
                compositionCompatibility: evaluateNativeCompositionAction(requirement, action)
              } : {}) }
              if (Buffer.byteLength(JSON.stringify([...actions, candidate])) > 64 * 1024) {
                if (!actions.length) throw Error("PROJECT_ACTION_CATALOG_ENTRY_LIMIT")
                break
              }
              actions.push(candidate)
              cursor++
            }
            result = {
              actions,
              nextCursor: cursor < matchingCatalog.length ? cursor : null,
              ...(args.query === undefined ? {} : { query: args.query }),
              ...(draft ? { id: draft.id, revision: draft.revision,
                sourceDigest: draft.source.digest, requirement } : {}),
              scope: "installed-authorized-public-actions",
              executed: false,
              grantsAuthority: false,
              hint: "仅列举当前已安装且授权的公开动作；绑定不执行，也不新增授权。按 schema 填写常量或前序对象映射。"
            }
            break
          }
          case "project_bind_action": {
            if (!args.stageId || !args.localActionId || !args.provider)
              throw Error("DEVELOPMENT_INPUT")
            const context = project()
            const wanted = parseClawActionIdentity(args.provider)
            const action = (await projectCatalog(context)).find(
              (candidate) =>
                candidate.pluginId === wanted.pluginId &&
                candidate.plugin === wanted.plugin &&
                candidate.digest === wanted.digest &&
                candidate.actionId === wanted.actionId
            )
            if (!action) throw Error("PROJECT_ACTION_PROVIDER_CHANGED")
            result = await projectAuthoringSessions.bindAction(
              context.scope,
              {
                id: id(),
                revision: revision(),
                stageId: args.stageId,
                localActionId: args.localActionId,
                action,
                constants: args.actionInput ?? {},
                config: args.actionConfig,
                inputFrom: args.inputFrom
              },
              context.guard
            )
            break
          }
          case "project_scaffold": {
            if (!args.name) throw Error("DEVELOPMENT_INPUT")
            const context = project()
            result = await projectAuthoringSessions.scaffold(
              context.scope,
              id(),
              args.name,
              context.guard,
              args.template
            )
            break
          }
          case "project_compile": {
            const context = project()
            const compiled = await projectAuthoringSessions.compile(
              context.scope,
              id(),
              revision(),
              context.guard
            )
            result = { ...projectAuthoringReadView(compiled, undefined),
              ...("validation" in compiled ? { validation: compiled.validation } : {}) }
            break
          }
            case "project_list": {
              const context = project()
              const trial = projectAuthoringSessions.trialRequest(context.scope)
              result = projectAuthoringSessions.list(context.scope).map(draft => ({
                id: draft.id, name: draft.name, revision: draft.revision,
                digest: draft.source.digest, development: draft.development,
                ...(trial?.draftId === draft.id ? { trial } : {})
              }))
              break
            }
            case "project_request_trial": {
              if (!args.goal) throw Error("PROJECT_TRIAL_GOAL_REQUIRED")
              const context = project()
              const draft = projectAuthoringSessions.read(context.scope, id())
              const actions = draft.source.files.some(file => file.path === PROJECT_ACTION_LOCK_PATH)
                ? await projectCatalog(context) : []
              result = await projectAuthoringSessions.requestTrial(context.scope, id(),
                revision(), args.goal, context.guard, actions)
              break
            }
            case "project_read": {
            const context = project()
            const draft = projectAuthoringSessions.read(context.scope, id())
            const trial = projectAuthoringSessions.trialRequest(context.scope)
            result = projectAuthoringReadView(draft, trial?.draftId === draft.id ? trial : undefined,
              args.assetPath, args.cursor)
            break
          }
          case "project_patch": {
            if ((!args.files && !args.sourcePatch) || !args.sourceDigest) throw Error("DEVELOPMENT_INPUT")
            const context = project()
            const saved = await projectAuthoringSessions.patch(context.scope, {
              id: id(), revision: revision(), sourceDigest: args.sourceDigest, files: args.files,
              sourcePatch: args.sourcePatch
            }, context.guard)
            result = {
              id: saved.id, name: saved.name, revision: saved.revision,
              sourceDigest: saved.source.digest,
              preservedUnchangedFiles: true,
              nextStep: { action: saved.source.files.some((file) =>
                file.path === NATIVE_COMPOSITION_PATH || file.path === HARNESS_SOURCE_PATH)
                ? "project_compile" : "project_doctor", id: saved.id, revision: saved.revision },
              runtimeVerified: false
            }
            break
          }
          case "project_save": {
            if (!args.name || !args.files) throw Error("DEVELOPMENT_INPUT")
            const context = project()
            const saved = await projectAuthoringSessions.save(
              context.scope,
              {
                id: id(),
                name: args.name,
                revision: revision(),
                files: args.files
              },
              context.guard
            )
            const hasAuthoringSource = saved.source.files.some(
              (file) => file.path === NATIVE_COMPOSITION_PATH || file.path === HARNESS_SOURCE_PATH
            )
            result = {
              ...projectAuthoringReadView(saved, undefined),
              nextStep: {
                action: hasAuthoringSource ? "project_compile" : "project_doctor",
                id: saved.id,
                revision: saved.revision
              }
            }
            break
          }
          case "project_doctor":
          case "project_test":
          case "project_dev":
          case "project_pack": {
            const context = project()
            const draft = projectAuthoringSessions.read(context.scope, id())
            const actions = draft.source.files.some(
              (file) => file.path === PROJECT_ACTION_LOCK_PATH
            )
              ? await projectCatalog(context)
              : []
            const inspection = await projectAuthoringSessions.inspect(
              context.scope,
              id(),
              revision(),
              args.action.slice("project_".length) as "doctor" | "test" | "dev" | "pack",
              context.guard,
              actions
            )
            const hasAuthoringSource = draft.source.files.some(
              (file) => file.path === NATIVE_COMPOSITION_PATH || file.path === HARNESS_SOURCE_PATH
            )
            result = !hasAuthoringSource &&
              (args.action === "project_doctor" || args.action === "project_test") &&
              inspection !== null && typeof inspection === "object" && "valid" in inspection &&
              inspection.valid === false
              ? {
                  ...inspection,
                  nextStep: { action: "project_read", id: draft.id },
                  hint: "先 project_read 核对当前完整快照，并与最近 project_scaffold 返回的 source.files 比较，恢复遗漏的真实源文件；不要编造运行协议字段或转 shell 猜协议。保存完整快照后使用返回的最新 revision 检查或编译。"
                }
              : inspection
            if (args.action === "project_dev" && inspection !== null &&
              typeof inspection === "object" && "status" in inspection &&
              inspection.status === "prepared") {
              result = {
                ...inspection,
                preparationScope: "development-package-only",
                trialPrepared: false,
                nextStep: {
                  action: "project_request_trial",
                  id: draft.id,
                  revision: draft.revision,
                  ...(args.goal ? { goal: args.goal } : {})
                },
                ...(!args.goal ? { missingFields: ["goal"] } : {}),
                hint: "这里只准备了开发包和空工作区，尚未创建试用候选或执行项目。用用户已给出的目标（缺少时先询问用户）填写 goal，调用 nextStep 的 project_request_trial；然后结束本轮等待原生确认。不能把 prepared 当作试用成功，也不能自动审批或执行。"
              }
            }
            break
          }
          case "catalog":
            result = args.catalogSection === "project-dependencies"
              ? developmentDependencyCatalogPage({ mainDirectory: __dirname,
                  assetPath: args.assetPath, cursor: args.cursor, expectedDigest: args.sourceDigest })
              : developmentCatalogPage(args.catalogSection, args.cursor, args.query)
            break
          case "list":
            result = service!.status(threadId)
            break
          case "scaffold": {
            if (!args.name || !args.instruction || !args.kind) throw Error("DEVELOPMENT_INPUT")
            const source = createAuthoringTemplate({
              id: id(),
              name: args.name,
              instruction: args.instruction,
              kind: args.kind
            })
            const current = inspectDraft()
            result = {
              ...source,
              saved: false,
              nextExpectedRevision: current.exists ? current.revision : 0,
              nextStep: "模板尚未保存，read 不会创建草稿。将 result.files 完整数组传给 submit(id,name,revision=result.nextExpectedRevision,files)；通过后结束本轮等待原生试用确认。"
            }
            break
          }
          case "read":
            result = service!.read(threadId, id())
            break
          case "save":
            if (!args.name || !args.files) throw Error("DEVELOPMENT_INPUT")
            result = service!.save(threadId, {
              id: id(),
              name: args.name,
              expectedRevision: revision(),
              files: args.files
            })
            break
          case "dependency_prepare": {
            if (!args.sourceId) throw Error("DEVELOPMENT_INPUT")
            const context = project()
            result = await prepareDevelopmentDependency({
              service: service!, mainDirectory: __dirname, threadId,
              sourceId: args.sourceId, id: args.id, name: args.name,
              revision: args.revision, expectedDigest: args.sourceDigest,
              turnId: lease!.runId, signal, assertCurrent: context.guard,
              claimCandidate: attemptCandidate
            })
            break
          }
          case "dependency_save": {
            if (!args.name || !args.assetPath || !args.sourceDigest)
              throw Error("DEVELOPMENT_INPUT")
            const draftId = id()
            const expectedRevision = revision()
            const source = readDevelopmentDependencySource({ mainDirectory: __dirname,
              sourceId: args.assetPath, expectedDigest: args.sourceDigest })
            assertTurn()
            const saved = service!.save(threadId, {
              id: draftId, name: args.name, expectedRevision, files: source.files
            })
            result = {
              id: saved.id, name: saved.name, revision: saved.revision,
              sourceDigest: saved.source.digest,
              fileIndex: saved.source.files.map((file) => file.path),
              nextStep: { action: "check", id: saved.id, revision: saved.revision },
              afterCheck: { action: "request_reuse", id: saved.id, revision: saved.revision },
              compiled: false, installed: false, grantsAuthority: false, executed: false,
              hint: "完整固定源码已通过原 save CAS 保存；check通过后request_reuse并结束本轮等原生安装/授权确认。确认后重读project_actions继续绑定，保存不代表安装或业务通过。"
            }
            break
          }
          case "submit": {
            if (!args.name || !args.files) throw Error("DEVELOPMENT_INPUT")
            const draftId = id()
            const expectedRevision = revision()
            const source = readPureFunctionSource(createAuthoringSourceBundle(args.files))
            assertDraftRevision(expectedRevision, true)
            attemptCandidate()
            result = await service!.submit(
              threadId,
              {
                id: draftId,
                name: args.name,
                expectedRevision,
                files: source.files
              },
              lease!.runId,
              signal,
              assertTurn
            )
            break
          }
          case "check":
            result = await service!.check(threadId, id(), revision(), signal)
            break
          case "request_trial": {
            const draftId = id()
            const expectedRevision = revision()
            assertDraftRevision(expectedRevision, false)
            attemptCandidate()
            result = await service!.requestTrial(
              threadId,
              draftId,
              expectedRevision,
              lease!.runId,
              signal,
              assertTurn
            )
            break
          }
          case "resume_trial": {
            const draftId = id()
            const expectedRevision = revision()
            assertDraftRevision(expectedRevision, false)
            attemptCandidate()
            result = await service!.resumeTrial(
              threadId,
              draftId,
              expectedRevision,
              lease!.runId,
              signal,
              assertTurn
            )
            break
          }
          case "undo_trial":
            result = await service!.undoTrial(threadId, lease!.runId, signal, assertTurn)
            break
          case "request_reuse":
            result = await service!.requestReuse(
              threadId,
              id(),
              revision(),
              lease!.runId,
              signal,
              assertTurn
            )
            break
          case "inspect_plugin": {
            const plugins = getPlugins()
            result = {
              report: pluginMigrationReport(plugins, args.pluginId),
              ...(args.pluginId
                ? { assets: await listMigrationAssets(plugins, args.pluginId) }
                : {})
            }
            break
          }
          case "read_plugin_asset":
            if (!args.pluginId || !args.assetPath) throw Error("DEVELOPMENT_INPUT")
            result = await readMigrationAsset(getPlugins(), args.pluginId, args.assetPath)
            break
        }
        assertTurn()
        return JSON.stringify({ ok: true, result })
      } catch (error) {
        const rawCode =
          error instanceof ModFunctionError
            ? error.code
            : error instanceof Error
              ? error.message
              : ""
        const code = /^[A-Z][A-Z0-9_]{2,90}$/.test(rawCode)
          ? rawCode
          : "DEVELOPMENT_OPERATION_FAILED"
        const requiredFields =
          args.action === "scaffold"
            ? ["id", "name", "instruction", "kind"]
            : args.action === "project_patch"
              ? ["id", "revision", "sourceDigest", ...(args.sourcePatch ? [] : ["files"])]
            : args.action === "dependency_prepare"
              ? ["sourceId"]
            : args.action === "dependency_save"
              ? ["id", "name", "revision", "assetPath", "sourceDigest"]
            : ["save", "submit"].includes(args.action)
              ? ["id", "name", "revision", "files"]
              : ["request_trial", "resume_trial"].includes(args.action)
                ? ["id", "revision"]
                : code === "DEVELOPMENT_ID_REQUIRED"
                  ? ["id"]
                  : code === "DEVELOPMENT_REVISION_REQUIRED"
                    ? ["revision"]
                    : []
        const missingFields = [
          "DEVELOPMENT_INPUT",
          "DEVELOPMENT_ID_REQUIRED",
          "DEVELOPMENT_REVISION_REQUIRED"
        ].includes(code)
          ? requiredFields.filter((field) => args[field as keyof typeof args] === undefined)
          : []
        let currentDraft: CurrentAuthoringDraft | undefined
        if ((["AUTHORING_PLUGIN_MANIFEST_REQUIRED", "AUTHORING_INSTALL_PURE_SOURCE_REQUIRED",
          "AUTHORING_VERSION_MISSING", "AUTHORING_VERSION_CHANGED", "PROJECT_DRAFT_SOURCE_CHANGED",
          "PROJECT_DRAFT_REVISION_CHANGED", "PROJECT_DRAFT_FILE_UNSUPPORTED"].includes(code) ||
          args.action === "dependency_prepare" || error instanceof ProjectSourcePatchError) && (args.id || args.sourceId)) {
          try {
            currentDraft = args.action.startsWith("project_")
              ? inspectProjectDraft?.()
              : inspectDraft?.()
          } catch { /* A stale or unreadable scope exposes no guessed draft identity. */ }
        }
        return JSON.stringify({
          ok: false,
          error: code,
          ...(currentDraft ? { currentDraft } : {}),
          ...(error instanceof ProjectSourcePatchError ? {
            sourcePatch: { operationIndex: error.operationIndex, path: error.path },
            sourceUnchanged: true, executed: false
          } : {}),
          ...(error instanceof DependencyPreparationError ? {
            ...(error.currentDraft && !currentDraft
              ? { currentDraft: { ...error.currentDraft, exists: true } } : {}),
            ...(error.reuse ? { reuse: error.reuse } : {}),
            executed: false, grantsAuthority: false
          } : {}),
          ...(error instanceof ProjectDraftFileError ? {
            unsupportedPaths: error.unsupportedPaths,
            ...(error.declarationPath ? { declarationPath: error.declarationPath } : {}),
            sourceUnchanged: true, executed: false
          } : {}),
          ...(error instanceof ProjectContractError ? {
            diagnostics: error.diagnostics.slice(0, 16), diagnosticCount: error.diagnostics.length,
            sourceUnchanged: true, executed: false
          } : {}),
          ...(error instanceof ProjectAuthoringSkillMetadataError ? {
            diagnostics: error.diagnostics,
            diagnosticCount: error.diagnostics.length,
            sourceUnchanged: true, executed: false
          } : {}),
          ...(error instanceof FunctionUserConfigDeclarationError ? {
            diagnostics: [{ scope: "userConfig", ...error.diagnostic }],
            diagnosticCount: 1, executed: false
          } : {}),
          ...(error instanceof AuthoringSourceLimitError ? {
            diagnostics: [{ scope: "source-bundle", ...error.diagnostic }],
            diagnosticCount: 1, executed: false
          } : {}),
          ...(error instanceof AuthoringStructureError ? {
            diagnostics: [error.diagnostic], diagnosticCount: 1,
            executed: false
          } : {}),
          ...(error instanceof NativeCompositionDependencyError
            ? {
                dependencies: error.dependencies.slice(0, 4),
                dependencyCount: error.dependencies.length,
                repair: {
                  discovery: { action: "project_actions", id: args.id,
                    localActionId: error.dependencies[0]?.usedBy },
                  sourceCatalog: { action: "catalog", catalogSection: "project-dependencies" },
                  prepareDependency: [{ action: "dependency_prepare", sourceId: "actual catalog sourceId" }],
                  authoredSourceSave: "save complete files when editing or creating source",
                  nativeInstallationAndPermissionConfirmationRequired: true,
                  nextAfterConfirmation: "Re-read project_actions, patch the actual source provider plugin/actionId, compile the latest saved revision. Execution actions bind separately with project_bind_action. Preserve original Hooks, knowledge, configuration and checks.",
                  executed: false, grantsAuthority: false
                }
              }
            : {}),
          ...(missingFields.length ? { missingFields } : {}),
          ...(error instanceof DevelopmentCandidateError
            ? {
                target: error.target,
                diagnostics: error.diagnostics,
                repair: {
                  attempt: candidateAttempts,
                  maxAttempts: CREATOR_REQUEST_LIMITS.candidates,
                  remaining: Math.max(0, CREATOR_REQUEST_LIMITS.candidates - candidateAttempts),
                  canRetry:
                    error.repairable && candidateAttempts < CREATOR_REQUEST_LIMITS.candidates,
                  previousVersionPreserved: true
                }
              }
            : {}),
          ...(error instanceof ProjectDraftLimitError ? { limit: error.reason } : {}),
          hint:
            error instanceof AuthoringStructureError
              ? "这是清单结构错误。先 read 核对当前完整作者源，按 diagnostics.path 和 message 修正清单，用实际最新 revision 保存并重新检查；保留组件源码、知识、Hooks、配置与权限边界。不要盲目重试、删除必要能力或代用户批准。"
            : error instanceof AuthoringSourceLimitError
              ? (error.diagnostic.resource === "files"
                ? "源码包文件数量必须为 1 至 64，observed 是本次文件数。"
                : "源码包累计 UTF-8 路径与内容字节必须不超过 262144；observedBytes 是首次越限时已累计的字节数，不是完整包总量。") +
                "先 read/project_read 核对保留的作者源；project_compile 也可能由编译生成包越限触发，作者源合法时不要假定输入源过大，应核对生成包大小并报告准确诊断。保留必需 Hooks、知识、配置和检查，仅压缩冗余文本或修正重复生成；不要盲目 scaffold、删除必需文件、放宽限额或绕过预算。修复后使用实际最新 revision 检查。"
            : error instanceof FunctionUserConfigDeclarationError
              ? args.action.startsWith("project_")
                ? "diagnostics.path 是相对 userConfig 的 JSON Pointer。先 project_read 核对当前声明：原生 composition/source.json 位于 /configuration/userConfig，普通清单位于 /userConfig；按 reason/message 和 allowedKeys 只修正对应声明。数字边界用 min/max；保留原配置、Hooks、知识和检查，再用实际最新 revision 编译，不得删除校验或绕过现有预算。"
                : "diagnostics.path 是相对 userConfig 的 JSON Pointer。先 read 核对当前源码；普通 Function 声明在 mods/manifest.json 的 /userConfig。按 reason/message 和 allowedKeys 修正声明，数字边界用 min/max；保留原配置和检查，保存后用实际最新 revision 检查，不得删除校验或绕过现有预算。"
            : error instanceof ProjectSourcePatchError
              ? "sourcePatch 仅修改 composition/source.json：最多16个严格JSON Pointer add/replace/remove/test，add/replace/test须有JSON value、remove不能带value；每value最多16KiB，总patch最多32KiB。add /modules/-追加、replace /modules/2替换、add /resources/-声明资源。不能同时提交完整composition/source.json。新增资源声明与对应files须在同一次project_patch原子保存；任何失败源码和revision不变，先核对currentDraft再修正，不得通过execute/write_file绕过。"
            : args.action === "dependency_prepare"
              ? "用 catalog(catalogSection:project-dependencies) 返回的真实 sourceId 调用 dependency_prepare；不是 project_read 资产，也无需手填文件或摘要。草稿冲突请保留 currentDraft，用显式新 id 准备；可选 revision/sourceDigest 若提供须精确匹配。已有待确认计划请结束本轮走原生卡片；busy/unknown/unconfirmed 不能自动重放，先核对原生状态。check失败请按诊断修改源码并走普通save/check。此操作仅保存、检查、准备，未安装/授权/执行；needs-approval 后立即结束本轮等待原生确认。"
            : error instanceof ProjectDraftFileError
              ? projectDraftFileHint(error)
            : error instanceof ProjectAuthoringSkillMetadataError
              ? "这是新作者编译/doctor/候选准备的 Skill 元数据诊断。按 diagnostics.path 和 declarationPath 读取当前 composition/source.json 引用的作者 Skill，补填小写 YAML name、description 两个非空字符串及真实用途，再保存并用最新 revision 编译。只改作者源，不编辑生成的 skills/native-*，不静默编造描述或批量改名；保留检查、Hooks、知识和预算。存量 Host 固定路径执行仍使用既有兼容规则。"
            : error instanceof ProjectContractError
              ? "按diagnostics.file/path定位当前tests/project-contract.json字段；用project_read读取该文件和composition/source.json实际声明，再project_patch只修改必要文件。Fixture必须使用当前真实stageId、artifact.path及字符串text，不能用content替代；保留原检查、Hooks、知识和配置。预期不匹配须修正样例/契约，不得删校验或把expected改为failed以掩盖问题；原版本保持不变，使用实际最新revision重新编译。"
            : error instanceof NativeCompositionDependencyError
              ? "依赖未解决或契约不匹配。先按 repair.discovery 读真实动作和不匹配原因，按 sourceCatalog 读取真实sourceId；原样复用用dependency_prepare(sourceId)一次保存/检查/准备并结束本轮等待原生确认，无需逐页抄源码或手填摘要。定制仍可save完整源码再check/request_reuse。确认后重读目录并保留原Hooks、知识、配置和检查继续编译。无需先执行 Function trial；禁止猜identity、自动授权或删减业务检查。"
            : args.action === "dependency_save" && code.startsWith("DEVELOPMENT_DEPENDENCY_")
              ? "固定依赖源码未保存。用catalog(catalogSection:project-dependencies,assetPath:sourceId)核对真实sourceId/sourceDigest；assetPath仅sourceId，不能是文件或本机路径。源码变化须重新核对摘要，不能自动重放未知保存结果；原生安装和授权仍须另行确认。"
            : error instanceof DevelopmentCandidateError
              ? error.diagnostics[0].hint
              : args.action === "project_patch" && ["DEVELOPMENT_INPUT", "DEVELOPMENT_ID_REQUIRED",
                  "DEVELOPMENT_REVISION_REQUIRED", "PROJECT_DRAFT_REVISION_CHANGED", "PROJECT_DRAFT_SOURCE_CHANGED",
                  "AUTHORING_SOURCE_INVALID", "AUTHORING_SOURCE_PATH", "AUTHORING_SOURCE_TEXT",
                  "AUTHORING_SOURCE_COLLISION", "AUTHORING_SOURCE_LIMIT"].includes(code)
                ? "先 project_read(id) 核对真实 revision 与 sourceDigest；project_patch可传新增/修改的files，或sourcePatch固定修改composition/source.json，或二者原子合用；遗漏文件保留。新增资源用sourcePatch add /resources/-和files同次提交，无需整份重写source.json；完整composition文件与sourcePatch互斥。大型文件按assetPath/cursor读取，失败或未知不能猜版本重放；保存不代表编译、审批或业务通过。"
              : code === "DEVELOPMENT_BUDGET_UNCONFIRMED"
                ? "本次制作请求的预算记录无法核对，已停止推进。保留草稿和当前运行版，先核对状态；不要自动重试或新开轮次绕过。"
                : code === "DEVELOPMENT_TURN_BUDGET"
                  ? "本次制作请求已达到操作或时间预算。保留草稿和当前运行版，说明已完成与未完成部分，等待用户明确的新要求；不要自动新开请求继续。"
                  : code === "DEVELOPMENT_REPAIR_BUDGET"
                    ? "本轮已检查三个候选（初次制作加两次修复）。保留草稿和当前可用版，说明最后的准确诊断；不要继续循环提交或重放动作。"
                    : code === "DEVELOPMENT_BUSY"
                      ? "当前制作检查仍在进行。等待在途操作结束后用 list/read 核对最新 revision，再继续原请求；不要并发或循环提交。"
                      : args.action.startsWith("project_") && [
                          "AUTHORING_PLUGIN_MANIFEST_REQUIRED", "AUTHORING_INSTALL_PURE_SOURCE_REQUIRED",
                          "AUTHORING_VERSION_MISSING", "AUTHORING_VERSION_CHANGED"
                        ].includes(code)
                        ? "project_save 替换完整快照，不能只传修改的文件。先 project_read(id) 取得真实 revision 和 source.files，在本地合并修改后完整 project_save，保留原清单、源文件、Skills、Hooks、知识、配置和检查文件；不要改成纯函数格式或手写生成的 runtime。已有 composition/source.json 或 devclaw.harness.json 时，保存后用返回的最新 revision 显式 project_compile。读取失败时不要猜 revision 或机械重试。"
                      : code === "AUTHORING_PLUGIN_MANIFEST_REQUIRED"
                        ? "files 缺少插件清单。纯函数提交必须包含 plugin.json、mods/manifest.json 及入口源码；用 catalog.package 或 scaffold 的 result.files 完整数组，不能只提交修改的文件。新草稿 revision=0，已有草稿先 read(id)。"
                        : code === "AUTHORING_INSTALL_PURE_SOURCE_REQUIRED"
                          ? "纯函数入口要求完整 plugin.json（mods 为 mods/manifest.json）、cmb.mods/v2 清单和入口源码，格式以 catalog.package 或 scaffold.result.files 为准。原项目/业务插件走 project_* 或 mod_business，勿删除原有技能、Hooks 或校验来凑此格式。"
                          : code === "AUTHORING_VERSION_MISSING"
                            ? "当前范围没有该已保存草稿；scaffold 只返回文件，不会保存，read 也不会创建。用 scaffold.result.files 或 catalog.package 的完整源码提交 submit，首次 revision=0；若 currentDraft.exists=true，先 read(id) 核对其实际 revision。"
                            : code === "AUTHORING_VERSION_CHANGED"
                              ? "提交版本与当前草稿不一致。先 read(id) 核对完整源码，用 currentDraft.revision 作为修改的 revision；不存在草稿时新建 revision=0。不要猜版本或机械加一，也不要重放未知结果。"
                      : missingFields.length
                        ? `此操作缺少 ${missingFields.join(", ")}。${
                            args.action === "submit" || args.action === "save"
                              ? "同时提供 id、name、revision 和完整 files；新草稿 revision=0，修改已有草稿先 read(id) 取得当前 revision。"
                              : ["request_trial", "resume_trial"].includes(args.action)
                                ? "先 list 找到草稿 id，再 read(id) 取得当前 revision；使用这两个精确值请求试用。"
                                : args.action === "scaffold"
                                  ? "scaffold 同时需要 id、name、kind、instruction，只返回未保存模板。修改 result.files 中的入口实现真实行为，再用完整 files 提交 submit；不需要写工作区临时文件或执行命令。"
                                  : "补齐这些字段后继续当前需求。"
                          }`
                        : error instanceof ProjectDraftLimitError
                          ? projectDraftLimitHint(error.reason)
                          : args.action.startsWith("project_")
                            ? "用 project_list/project_read 核对持久草稿和 revision；公开动作需 project_actions 取得当前真实身份和 schema，未授权或版本改变时经原权限确认，不可猜 ID。修正后 doctor/test；project_request_trial(id,revision,goal) 展示当前聊天原生真实试用卡，确认后使用原项目运行器从起点执行。dev 仅准备目录，pack 不会自动安装；重启恢复源码，不恢复授权或运行。"
                            : "检查草稿版本、当前会话和诊断；失败不会替你批准权限。request_trial 只请求轮次结束后试用。"
        })
      }
    },
    {
      name: "mod_authoring",
      description:
        "For independent Mods, use catalog(query:'tool.call') or catalog(query:'ui.resolve') to read exact real event/SDK signatures and referenced types. Prefer targeted discovery for the needed feature; full catalogSection:types remains paged for additional declarations. Query does not discover or authorize installed actions. " +
        "Keep author source in native draft files: edit scaffold/read result.files and submit the complete files directly. Do not write temporary workspace files or run commands merely to prepare an independent Mod. A scaffold is a placeholder, not the requested implementation. For two cooperating Mods, discover the public provider registration with catalog(query:'platform.action',catalogSection:'events') and the consumer call with catalog(query:'platform.act',catalogSection:'sdk'); provider uses on.capability and consumer calls its declared contract. Prefer this explicit interface over recreating the provider algorithm or inventing tool names. Author-created source is not proof that both providers are active; verify the selected combination after native confirmation. " +
        "A conversation has one development trial slot. When the user requests multiple independently reusable Mods, scaffold(kind:'capability',id,name,instruction) provides a complete stateless public-provider package; replace its placeholder act behavior with the requested implementation, retain the descriptor and full files, save/check then request_reuse for its exact draft and end the turn for native confirmation. catalog(query:'on.capability') also resolves this exact registration; it is not a missing SDK method. After installation is confirmed, create/check/reuse the consumer against the real provider contract; compose the installed selections while preserving existing functions. Do not replace one trial with another and claim both are running, request approval for an invalid consumer, or ask the user to choose routine implementation architecture. " +
        "For a large existing project, first read composition/source.json and only resources needed for this change. project_patch preserves every unread/omitted file: do not page through all Hooks, knowledge or workflows merely to preserve them. Compare actual retained file indexes/digests after patch/compile to verify preservation. Reuse unchanged dependencies with dependency_prepare(sourceId); do not transcribe complete templates or ask the user to choose routine implementation details. Keep the existing operation budget and prepare the native reviewable candidate within this request. " +
        "Native composition checks can use any real authorized Function Mod public action. project_actions() or project_actions(query,cursor) discovers real installed authorized actions; query matches plugin/actionId/name by case-insensitive substring before paging, even if id or localActionId is also supplied. project_actions(id) lists only the source's already declared requirements; project_actions(id,localActionId=usedBy,cursor) evaluates actual actions against one exact declared Host input contract. To add a new capability, discover it without id or with query first; an undeclared localActionId is not a discovery query. Config never supplies missing input fields. catalog(catalogSection:project-dependencies) returns real uninstalled sourceId values. Call dependency_prepare(sourceId) to pin the complete Host-bundled source, save it with ordinary CAS, check its exact revision and prepare the existing native reuse plan in one bounded operation. Default draft id is sourceId and display name is the real plugin.name; optional id/name override draft identity/display only, optional revision/sourceDigest remain strict expectations. Existing different source or unknown reuse outcomes are never overwritten/replayed. No file transcription, hand-filled hash, install, authorization, execution or Function trial occurs. needs-approval means end this turn now and wait for original native confirmation. Returned companion text is bounded inert data: project_patch that text and composition/source.json.resources together when the project needs it; provider installation does not add project-relative files. Large companions remain indexed for catalog reads. project_read reads saved project drafts, never catalog assets. Advanced dependency_save(id,name,revision,assetPath=sourceId,sourceDigest) still saves an exact pinned source only; use check/request_reuse separately. Use catalog assetPath pages and ordinary save when deliberately editing source. After native confirmation re-read project_actions, patch the real provider and compile latest revision. on.capability implements ordinary independent validators; never invent identities, weaken checks or treat compile as execution. " +
        "For existing or large projects prefer project_patch(id,revision,sourceDigest,files?,sourcePatch?): omitted files are preserved. sourcePatch is a bounded array of strict JSON Pointer add/replace/remove/test operations targeting only composition/source.json: add /modules/- appends, replace /modules/2 replaces a middle module, add /resources/- declares a resource; value is required except remove. Up to16 operations,16KiB/value,32KiB total; no root/move/copy, unsafe keys, sparse/out-of-range array writes or implicit parent creation. It applies to an independent JSON clone and saves with files once through original CAS/schema/resource checks; a failed test or invalid patch changes no revision. Newly added Skill/workflow/fixture files and their resource declarations belong in the same atomic call. sourcePatch alone may omit files; do not also send a complete composition/source.json file. Generated files and other JSON files cannot be targeted by sourcePatch. It saves one immutable revision; it does not compile, approve, install or execute. project_read may return readMode:file-index; use assetPath and cursor/nextCursor only for needed exact file pages, then patch using the real sourceDigest/revision. Never treat an index/page as a complete snapshot for project_save. " +
        "Project delivery: project_scaffold/read -> project_save complete snapshot -> project_compile using the returned revision -> inspect doctor/test results -> project_request_trial(id,latestRevision,goal from the user's existing task). After the exact native candidate is prepared, end the turn and wait for user confirmation. project_dev is OPTIONAL development-directory preparation only, NOT a trial candidate or delivery completion; it never substitutes for project_request_trial. If goal is missing, ask the user instead of inventing it. " +
        "project_save replaces the COMPLETE snapshot: preserve all original source, Skills, Hooks, knowledge resources, configuration and check files from project_read/scaffold. After editing composition/source.json or devclaw.harness.json, save the complete files and call project_compile with the returned latest revision; never hand-edit generated runtime files. Follow result.nextStep; it is guidance only and does not execute another action. " +
        "New drafts start with revision:0. scaffold returns saved:false and does NOT create a readable draft; pass ALL result.files (plugin.json, mods/manifest.json, and entry source) to submit. For existing drafts read(id) and use its actual revision. After submit check.valid=true, end the turn and wait for native consent; do not call request_trial again for that candidate. " +
        "Project_list and project_read return a matching trial request with trial.journey when a native project is linked. Read that exact creator/candidate/stage/check/session journal before discussing trial success. Model completion is not validation; checks-passed still needs native transition, missing or truncated receipts are unknown, and an edited candidate needs its own trial. Historical observation survives restart but restores no approval or execution. " +
        "Prefer submit(id,name,revision,files) to save, check and request the trial in one preparation; inspect result.check and repair diagnostics. A no-effect candidate startup preflight returns exact event/source diagnostics before this turn ends. Repair known code errors in this same request, using target.revision as the next expected revision; at most two repairs after the initial candidate. Never retry an unknown outcome or perform external actions to test startup. session.start must return next(event); a void startup handler fails even if syntax compiles. resume_trial(id,revision) re-prepares a persisted current-chat draft after restart and requests fresh consent, without installing. undo_trial stops the first active trial after the turn, or restores the immediately preceding source as a new revision through the same checks and permission envelope. request_reuse(id,revision) only prepares a reviewable formal installation and named combination for reuse in other chats; it does not install, approve, stop or apply before explicit UI confirmation. Do not use formal reuse merely to preserve this chat across restart. " +
        "For executable state-policy extensions use scaffold(kind:state-extension). This generates an ordinary Function Mod with on.capability, a decision command, references/state-migration-plan.json and tests/state-decision-cases.json. Save and check the exact generated files, then request_trial and wait for native confirmation. It is an executable decision scaffold, NOT migrated business state: default hold until the author confirms the real graph; even a configured edge is only a proposal until the original writer, Hooks, knowledge/config bindings and business checks are preserved, bound and actually tested. For full business packages use actual mod_business inspect, save(extensions,files), preview, request_trial and request_review with an inspected kernel and namespaced mods/business/<extensionId>/ implementation; references/business-assembly.md gives the actual route. A pure-function trial is not original-business migration validation. Never introduce a new state SDK or infer unknown legacy edges. Existing Host authority stays Host. " +
        "Create or modify a Mod in this creator session. Read catalog for this build's SDK/types/examples; write actual TypeScript with save (revision=0 for new, latest revision for updates), check diagnostics and repair, then request_trial. Trials apply only after this turn settles and the person approves the capability envelope. Never claim active from queued. For project packages use project_scaffold(id,name,template?) with native-modular for new composable projects, project-lite (compatible default), harness-lite, harness-fullstack or harness-data. native-modular provides a complete composition/source.json, two Skills, actual input/output contracts, artifact tests and result approval; edit its source and compile rather than guessing a runtime manifest. Harness templates need only devclaw.harness.json ordered nodes (id,title,skill,artifacts[{id,path,example,schema?}],approval none/human) and skills. For native reusable business modules author a single composition/source.json (devclaw.native-composition/v1) with versioned modules, typed prior-artifact inputs, checked outputs and optional resultApproval:human. Do not coexist with devclaw.harness.json or a business catalog. Retain declared resources, real skills and tests/project-contract.json; project_compile resolves public check actions only from the current authorized catalogue, generates Host runtime/action locks and runs doctor/artifact tests. A successful compile does not execute business check actions or prove migration equivalence; inspect validation limitations and use the original authorized project trial. After editing node definitions call project_compile(id,revision) to generate a new immutable runtime/contract revision and run isolated artifact contracts; existing public action bindings are preserved. Use project_list to recover the current chat source drafts. Then use project_read, project_save(files,name,revision), project_doctor, project_test, project_dev and project_pack (id,revision). project_request_trial(id,revision,goal) prepares an exact-version native preview card in this chat; the user confirms creation and starts the original project runner to execute real stages and validate actual artifacts. A needs-approval result is not execution. This path supports standard host project packages; it does not convert legacy Python business plugins or run them in the pure-function compiler. project_actions() or project_actions(query,cursor) lists real installed authorized public actions and schemas. project_actions(id) only lists requirements already declared by that source; query selects actual catalog discovery even with id. Omit id to discover an additional action, optionally filtering query by plugin/actionId/name before paging. project_bind_action(id,revision,stageId,localActionId,provider,actionInput,actionConfig?,inputFrom?) reads the catalogue again and locks the chosen identity/schema into a new draft version. Never invent provider IDs/digests. InputFrom is a prior-stage artifact JSON object or an earlier action output object plus JSON pointer; actionInput constants override matching fields. No expressions or internal file imports. Project drafts can include bounded same-package mods/hooks/skills source resources and .mcp.json. The original native exact-source card grants package Mods only in the selected private project workspace; fill required settings in its original native editor first. MCP resolves ${CLAUDE_PLUGIN_ROOT} against that pinned package; never use an author-machine absolute path or a changed live installation. These are not automatic grants or global installation. Project drafts use separate immutable versions; project_test runs isolated production artifact validators, project_dev only prepares an isolated package and empty workspace, project_pack returns a ZIP for the original user installation entry. These do not run a model, action, install, approve or advance a project. inspect_plugin reports original sources to preserve in an independent adapter; it neither executes nor converts the original plugin. Each project draft retains at most 8 revisions; scaffold/save/compile/bind consume revisions. PROJECT_DRAFT_LIMIT includes limit revision/drafts/sessions and a recovery hint. At revision capacity, project_read then project_save with a new draft id, revision:0, the original name and exact source.files continues without renaming the plugin or changing action locks; old previews stay pinned. At 4 drafts per creator session or 16 sessions per process, export checked packages and preserve full source for CLI editing; restart restores persisted source in the same chat, without automatically restoring preview authority, grants or execution; the person may use the original native review-and-recover card to recheck an exact retained project before preparing and approving new work. Another chat has a separate source scope. Approval and promotion are user UI actions, unavailable to this tool.",
      schema
    }
  )
}
