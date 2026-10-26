import { tool } from "langchain"
import { NativeCompositionDependencyError } from "../../plugins/native-composition"
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
import { DevelopmentCandidateError } from "../../mods/devtools/development-candidate-diagnostics"
import { CREATOR_REQUEST_LIMITS } from "../../mods/devtools/creator-request-budget"
import { AUTHORING_BUNDLE_LIMITS } from "../../mods/devtools/authoring-bundle"
import { getProjectStageDebugSessions } from "../../mods/devtools/project-stage-debug"

const schema = z
  .object({
    action: z.enum([
      "catalog",
      "list",
      "scaffold",
      "read",
      "save",
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
    debugMode: z.enum(["stage", "downstream"]).optional(),
    kind: z.enum(AUTHORING_TEMPLATE_KINDS).optional(),
    files: z
      .array(z.object({ path: z.string().max(240), text: z.string().max(65536) }))
      .min(1)
      .max(AUTHORING_BUNDLE_LIMITS.files)
      .optional(),
    pluginId: z.string().min(1).max(200).optional(),
    stageId: z.string().min(1).max(100).optional(),
    localActionId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
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
    catalogSection: z.enum(["overview", "types", "events", "sdk", "support"]).optional(),
    cursor: z.number().int().min(0).max(100000).optional()
  })
  .strict()

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
          if (!args.id) throw Error("DEVELOPMENT_ID_REQUIRED")
          return args.id
        }
        const revision = () => {
          if (args.revision === undefined) throw Error("DEVELOPMENT_REVISION_REQUIRED")
          return args.revision
        }
        const attemptCandidate = () => {
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
            const start = args.cursor ?? 0
            const actions: ClawActionDescriptor[] = []
            let cursor = start
            while (cursor < catalog.length && actions.length < 4) {
              const candidate = catalog[cursor]
              if (Buffer.byteLength(JSON.stringify([...actions, candidate])) > 64 * 1024) {
                if (!actions.length) throw Error("PROJECT_ACTION_CATALOG_ENTRY_LIMIT")
                break
              }
              actions.push(candidate)
              cursor++
            }
            result = {
              actions,
              nextCursor: cursor < catalog.length ? cursor : null,
              scope: "installed-authorized-public-actions",
              executed: false,
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
            result = await projectAuthoringSessions.compile(
              context.scope,
              id(),
              revision(),
              context.guard
            )
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
            result = { ...draft, ...(trial?.draftId === draft.id ? { trial } : {}) }
            break
          }
          case "project_save": {
            if (!args.name || !args.files) throw Error("DEVELOPMENT_INPUT")
            const context = project()
            result = await projectAuthoringSessions.save(
              context.scope,
              {
                id: id(),
                name: args.name,
                revision: revision(),
                files: args.files
              },
              context.guard
            )
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
            result = await projectAuthoringSessions.inspect(
              context.scope,
              id(),
              revision(),
              args.action.slice("project_".length) as "doctor" | "test" | "dev" | "pack",
              context.guard,
              actions
            )
            break
          }
          case "catalog":
            result = developmentCatalogPage(args.catalogSection, args.cursor)
            break
          case "list":
            result = service!.status(threadId)
            break
          case "scaffold":
            if (!args.name || !args.instruction || !args.kind) throw Error("DEVELOPMENT_INPUT")
            result = createAuthoringTemplate({
              id: id(),
              name: args.name,
              instruction: args.instruction,
              kind: args.kind
            })
            break
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
          case "submit":
            if (!args.name || !args.files) throw Error("DEVELOPMENT_INPUT")
            attemptCandidate()
            result = await service!.submit(
              threadId,
              {
                id: id(),
                name: args.name,
                expectedRevision: revision(),
                files: args.files
              },
              lease!.runId,
              signal,
              assertTurn
            )
            break
          case "check":
            result = await service!.check(threadId, id(), revision(), signal)
            break
          case "request_trial":
            attemptCandidate()
            result = await service!.requestTrial(
              threadId,
              id(),
              revision(),
              lease!.runId,
              signal,
              assertTurn
            )
            break
          case "resume_trial":
            attemptCandidate()
            result = await service!.resumeTrial(
              threadId,
              id(),
              revision(),
              lease!.runId,
              signal,
              assertTurn
            )
            break
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
            ? ["name", "instruction", "kind"]
            : ["save", "submit"].includes(args.action)
              ? ["name", "files"]
              : []
        const missingFields =
          code === "DEVELOPMENT_INPUT"
            ? requiredFields.filter((field) => !args[field as keyof typeof args])
            : []
        return JSON.stringify({
          ok: false,
          error: code,
          ...(error instanceof NativeCompositionDependencyError ? { dependencies: error.dependencies } : {}),
          ...(missingFields.length ? { missingFields } : {}),
          ...(error instanceof DevelopmentCandidateError
            ? {
                target: error.target,
                diagnostics: error.diagnostics,
                repair: {
                  attempt: candidateAttempts,
                  maxAttempts: CREATOR_REQUEST_LIMITS.candidates,
                  remaining: Math.max(0, CREATOR_REQUEST_LIMITS.candidates - candidateAttempts),
                  canRetry: error.repairable && candidateAttempts < CREATOR_REQUEST_LIMITS.candidates,
                  previousVersionPreserved: true
                }
              }
            : {}),
          ...(error instanceof ProjectDraftLimitError ? { limit: error.reason } : {}),
          hint:
            error instanceof DevelopmentCandidateError
              ? error.diagnostics[0].hint
              : code === "DEVELOPMENT_BUDGET_UNCONFIRMED"
                ? "本次制作请求的预算记录无法核对，已停止推进。保留草稿和当前运行版，先核对状态；不要自动重试或新开轮次绕过。"
              : code === "DEVELOPMENT_TURN_BUDGET"
                ? "本次制作请求已达到操作或时间预算。保留草稿和当前运行版，说明已完成与未完成部分，等待用户明确的新要求；不要自动新开请求继续。"
              : code === "DEVELOPMENT_REPAIR_BUDGET"
                ? "本轮已检查三个候选（初次制作加两次修复）。保留草稿和当前可用版，说明最后的准确诊断；不要继续循环提交或重放动作。"
                : missingFields.length
                  ? `此操作缺少 ${missingFields.join(", ")}；补齐这些字段后继续当前需求。`
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
        "Project_list and project_read return a matching trial request with trial.journey when a native project is linked. Read that exact creator/candidate/stage/check/session journal before discussing trial success. Model completion is not validation; checks-passed still needs native transition, missing or truncated receipts are unknown, and an edited candidate needs its own trial. Historical observation survives restart but restores no approval or execution. " +
        "Prefer submit(id,name,revision,files) to save, check and request the trial in one preparation; inspect result.check and repair diagnostics. A no-effect candidate startup preflight returns exact event/source diagnostics before this turn ends. Repair known code errors in this same request, using target.revision as the next expected revision; at most two repairs after the initial candidate. Never retry an unknown outcome or perform external actions to test startup. session.start must return next(event); a void startup handler fails even if syntax compiles. resume_trial(id,revision) re-prepares a persisted current-chat draft after restart and requests fresh consent, without installing. undo_trial stops the first active trial after the turn, or restores the immediately preceding source as a new revision through the same checks and permission envelope. request_reuse(id,revision) only prepares a reviewable formal installation and named combination for reuse in other chats; it does not install, approve, stop or apply before explicit UI confirmation. Do not use formal reuse merely to preserve this chat across restart. " +
        "For executable state-policy extensions use scaffold(kind:state-extension). This generates an ordinary Function Mod with on.capability, a decision command, references/state-migration-plan.json and tests/state-decision-cases.json. Save and check the exact generated files, then request_trial and wait for native confirmation. It is an executable decision scaffold, NOT migrated business state: default hold until the author confirms the real graph; even a configured edge is only a proposal until the original writer, Hooks, knowledge/config bindings and business checks are preserved, bound and actually tested. For full business packages use actual mod_business inspect, save(extensions,files), preview, request_trial and request_review with an inspected kernel and namespaced mods/business/<extensionId>/ implementation; references/business-assembly.md gives the actual route. A pure-function trial is not original-business migration validation. Never introduce a new state SDK or infer unknown legacy edges. Existing Host authority stays Host. " +
        "Create or modify a Mod in this creator session. Read catalog for this build's SDK/types/examples; write actual TypeScript with save (revision=0 for new, latest revision for updates), check diagnostics and repair, then request_trial. Trials apply only after this turn settles and the person approves the capability envelope. Never claim active from queued. For project packages use project_scaffold(id,name,template?) with native-modular for new composable projects, project-lite (compatible default), harness-lite, harness-fullstack or harness-data. native-modular provides a complete composition/source.json, two Skills, actual input/output contracts, artifact tests and result approval; edit its source and compile rather than guessing a runtime manifest. Harness templates need only devclaw.harness.json ordered nodes (id,title,skill,artifacts[{id,path,example,schema?}],approval none/human) and skills. For native reusable business modules author a single composition/source.json (devclaw.native-composition/v1) with versioned modules, typed prior-artifact inputs, checked outputs and optional resultApproval:human. Do not coexist with devclaw.harness.json or a business catalog. Retain declared resources, real skills and tests/project-contract.json; project_compile resolves public check actions only from the current authorized catalogue, generates Host runtime/action locks and runs doctor/artifact tests. A successful compile does not execute business check actions or prove migration equivalence; inspect validation limitations and use the original authorized project trial. After editing node definitions call project_compile(id,revision) to generate a new immutable runtime/contract revision and run isolated artifact contracts; existing public action bindings are preserved. Use project_list to recover the current chat source drafts. Then use project_read, project_save(files,name,revision), project_doctor, project_test, project_dev and project_pack (id,revision). project_request_trial(id,revision,goal) prepares an exact-version native preview card in this chat; the user confirms creation and starts the original project runner to execute real stages and validate actual artifacts. A needs-approval result is not execution. This path supports standard host project packages; it does not convert legacy Python business plugins or run them in the pure-function compiler. project_actions(cursor) lists real installed authorized public actions and schemas. project_bind_action(id,revision,stageId,localActionId,provider,actionInput,actionConfig?,inputFrom?) reads the catalogue again and locks the chosen identity/schema into a new draft version. Never invent provider IDs/digests. InputFrom is a prior-stage artifact JSON object or an earlier action output object plus JSON pointer; actionInput constants override matching fields. No expressions or internal file imports. Project drafts can include bounded same-package mods/hooks/skills source resources and .mcp.json. The original native exact-source card grants package Mods only in the selected private project workspace; fill required settings in its original native editor first. MCP resolves ${CLAUDE_PLUGIN_ROOT} against that pinned package; never use an author-machine absolute path or a changed live installation. These are not automatic grants or global installation. Project drafts use separate immutable versions; project_test runs isolated production artifact validators, project_dev only prepares an isolated package and empty workspace, project_pack returns a ZIP for the original user installation entry. These do not run a model, action, install, approve or advance a project. inspect_plugin reports original sources to preserve in an independent adapter; it neither executes nor converts the original plugin. Each project draft retains at most 8 revisions; scaffold/save/compile/bind consume revisions. PROJECT_DRAFT_LIMIT includes limit revision/drafts/sessions and a recovery hint. At revision capacity, project_read then project_save with a new draft id, revision:0, the original name and exact source.files continues without renaming the plugin or changing action locks; old previews stay pinned. At 4 drafts per creator session or 16 sessions per process, export checked packages and preserve full source for CLI editing; restart restores persisted source in the same chat, without automatically restoring preview authority, grants or execution; the person may use the original native review-and-recover card to recheck an exact retained project before preparing and approving new work. Another chat has a separate source scope. Approval and promotion are user UI actions, unavailable to this tool.",
      schema
    }
  )
}
