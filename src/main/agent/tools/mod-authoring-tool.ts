import { tool } from "langchain"
import { z } from "zod"
import { getModDevelopmentService } from "../../mods/devtools/development-service"
import { developmentCatalogPage } from "../../mods/devtools/development-catalog"
import { createAuthoringTemplate } from "../../mods/devtools/authoring-templates"
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

const schema = z
  .object({
    action: z.enum([
      "catalog",
      "list",
      "scaffold",
      "read",
      "save",
      "check",
      "request_trial",
      "inspect_plugin",
      "read_plugin_asset",
      "project_scaffold",
      "project_compile",
      "project_read",
      "project_save",
      "project_doctor",
      "project_test",
      "project_dev",
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
      .enum(["project-lite", "harness-lite", "harness-fullstack", "harness-data"])
      .optional(),
    revision: z.number().int().min(0).optional(),
    instruction: z.string().min(1).max(2000).optional(),
    kind: z.enum(["command", "tool", "rule", "panel", "flow-action"]).optional(),
    files: z
      .array(z.object({ path: z.string().max(240), text: z.string().max(65536) }))
      .min(1)
      .max(32)
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
    catalogSection: z.enum(["overview", "types", "events", "sdk"]).optional(),
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
  const lease = getLocalThreadRunLease(threadId)
  const ownsLease = captureLocalThreadRunLease(threadId)
  let operations = 0
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
            !service?.isEnabled(threadId, workspace)
          )
            throw Error("DEVELOPMENT_TURN_CHANGED")
        }
        assertTurn()
        if (++operations > 32 || performance.now() - createdAt > 10 * 60_000)
          throw Error("DEVELOPMENT_TURN_BUDGET")
        const id = () => {
          if (!args.id) throw Error("DEVELOPMENT_ID_REQUIRED")
          return args.id
        }
        const revision = () => {
          if (args.revision === undefined) throw Error("DEVELOPMENT_REVISION_REQUIRED")
          return args.revision
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
          case "project_read": {
            const context = project()
            result = projectAuthoringSessions.read(context.scope, id())
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
          case "check":
            result = await service!.check(threadId, id(), revision(), signal)
            break
          case "request_trial":
            result = await service!.requestTrial(
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
        const code =
          error instanceof Error && /^[A-Z][A-Z0-9_]{2,90}$/.test(error.message)
            ? error.message
            : "DEVELOPMENT_OPERATION_FAILED"
        return JSON.stringify({
          ok: false,
          error: code,
          ...(error instanceof ProjectDraftLimitError ? { limit: error.reason } : {}),
          hint:
            error instanceof ProjectDraftLimitError
              ? projectDraftLimitHint(error.reason)
              : args.action.startsWith("project_")
                ? "用 project_read 核对 revision；公开动作需 project_actions 取得当前真实身份和 schema，未授权或版本改变时让用户经原入口处理，不可猜 ID。修正后 doctor/test；dev 只准备目录，pack 由用户经原入口安装。"
                : "检查草稿版本、当前会话和诊断；失败不会替你批准权限。request_trial 只请求轮次结束后试用。"
        })
      }
    },
    {
      name: "mod_authoring",
      description:
        "Create or modify a Mod in this creator session. Read catalog for this build's SDK/types/examples; write actual TypeScript with save (revision=0 for new, latest revision for updates), check diagnostics and repair, then request_trial. Trials apply only after this turn settles and the person approves the capability envelope. Never claim active from queued. For project packages use project_scaffold(id,name,template?) with project-lite (compatible default), harness-lite, harness-fullstack or harness-data. Harness templates need only devclaw.harness.json ordered nodes (id,title,skill,artifacts[{id,path,example,schema?}],approval none/human) and skills. After editing node definitions call project_compile(id,revision) to generate a new immutable runtime/contract revision and run isolated artifact contracts; existing public action bindings are preserved. Then use project_read, project_save(files,name,revision), project_doctor, project_test, project_dev and project_pack (id,revision). project_actions(cursor) lists real installed authorized public actions and schemas. project_bind_action(id,revision,stageId,localActionId,provider,actionInput,actionConfig?,inputFrom?) reads the catalogue again and locks the chosen identity/schema into a new draft version. Never invent provider IDs/digests. InputFrom is a prior-stage artifact JSON object or an earlier action output object plus JSON pointer; actionInput constants override matching fields. No expressions or internal file imports. Project drafts use separate immutable versions; project_test runs isolated production artifact validators, project_dev only prepares an isolated package and empty workspace, project_pack returns a ZIP for the original user installation entry. These do not run a model, action, install, approve or advance a project. inspect_plugin reports original sources to preserve in an independent adapter; it neither executes nor converts the original plugin. Each project draft retains at most 8 revisions; scaffold/save/compile/bind consume revisions. PROJECT_DRAFT_LIMIT includes limit revision/drafts/sessions and a recovery hint. At revision capacity, project_read then project_save with a new draft id, revision:0, the original name and exact source.files continues without renaming the plugin or changing action locks; old previews stay pinned. At 4 drafts per creator session or 16 sessions per process, export checked packages and preserve full source for CLI editing; another chat or restart does not automatically restore drafts. Approval and promotion are user UI actions, unavailable to this tool.",
      schema
    }
  )
}
