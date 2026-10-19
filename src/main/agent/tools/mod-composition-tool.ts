import { tool } from "langchain"
import { z } from "zod"
import { getModDevelopmentService } from "../../mods/devtools/development-service"
import { getCreatorCompositionService } from "../../mods/devtools/creator-composition"
import { captureLocalThreadRunLease, getLocalThreadRunLease } from "../thread-run-lease"
import type { CreatorCompositionInput } from "../../mods/devtools/creator-composition"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { CREATOR_REQUEST_LIMITS } from "../../mods/devtools/creator-request-budget"

export function createModCompositionTool(input: {
  threadId: string
  workspace: string
  signal?: AbortSignal
}) {
  const { threadId, workspace, signal } = input
  const lease = getLocalThreadRunLease(threadId)
  const ownsLease = captureLocalThreadRunLease(threadId)
  const development = getModDevelopmentService()
  const assertCreator = development?.captureCreatorMode?.(threadId, workspace)
  const started = performance.now()
  let operations = 0
  return tool(
    async (args) => {
      try {
        const assertTurn = () => {
          signal?.throwIfAborted()
          if (
            !lease ||
            lease.owner !== "desktop" ||
            !ownsLease?.() ||
            !development?.isCreatorMode(threadId, workspace)
          )
            throw Error("DEVELOPMENT_TURN_CHANGED")
          assertCreator?.()
        }
        assertTurn()
        development!.claimAuthoringBudget?.(threadId, lease!.runId, "operation")
        if (++operations > CREATOR_REQUEST_LIMITS.operations ||
          performance.now() - started > CREATOR_REQUEST_LIMITS.durationMs)
          throw Error("DEVELOPMENT_TURN_BUDGET")
        const service = getCreatorCompositionService()
        if (!service) throw Error("COMPOSITION_UNAVAILABLE")
        let result: unknown
        switch (args.action) {
          case "list":
            result = await service.catalog(threadId, args.cursor, {
              query: args.query,
              refresh: args.refresh
            })
            break
          case "details":
            if (!args.pluginId) throw Error("COMPOSITION_PLUGIN_ID_REQUIRED")
            result = await service.details(threadId, args.pluginId, args.catalogToken)
            break
          case "status":
            result = await service.refreshStatus(threadId)
            break
          case "cancel":
            result = service.cancel(threadId, workspace)
            break
          case "undo":
            result = await service.undo(threadId, workspace, { turnId: lease!.runId, assertTurn })
            break
          case "save":
            if (!args.savedName) throw Error("COMPOSITION_SAVED_NAME_REQUIRED")
            result = await service.save(
              threadId,
              args.savedName,
              args.savedRevision ?? 0,
              args.catalogToken ?? "",
              assertTurn,
              { turnId: lease!.runId, signal }
            )
            break
          case "apply_saved":
            if (!args.savedName || args.savedRevision === undefined)
              throw Error("COMPOSITION_SAVED_REVISION_REQUIRED")
            result = await service.applySaved(
              threadId,
              lease!.runId,
              args.savedName,
              args.savedRevision,
              assertTurn
            )
            break
          case "stage":
            result = await service.stage(
              threadId,
              lease!.runId,
              {
                catalogToken: args.catalogToken ?? "",
                capabilities: args.capabilities ?? [],
                name: args.name,
                replace: args.replace,
                removePluginIds: args.removePluginIds,
                removeConfigPaths: args.removeConfigPaths,
                models: args.models,
                skills: args.skills,
                mcp: args.mcp,
                builtins: args.builtins,
                flow: args.flow
              } as CreatorCompositionInput,
              assertTurn
            )
            break
        }
        assertTurn()
        return JSON.stringify({ ok: true, result })
      } catch (error) {
        const code =
          error instanceof ModFunctionError
            ? error.code
            : error instanceof Error
              ? error.message
              : ""
        return JSON.stringify({
          ok: false,
          error: /^[A-Z][A-Z0-9_]+$/.test(code) ? code : "COMPOSITION_OPERATION_FAILED",
          hint: code === "DEVELOPMENT_TURN_BUDGET" || code === "DEVELOPMENT_BUDGET_UNCONFIRMED"
            ? "本次制作请求的预算已耗尽或无法核对，停止提交并说明已完成与未完成部分。保留草稿和当前组合，不得自动新开请求绕过预算。"
            : "先 list 取得当前真实身份和 catalogToken。stage 默认保留已有组合，只改变当前对话，成功轮次结束且空闲后应用。未授权能力需用户经原权限入口处理。提交前检查失败会保留原组合；MODS_COMPOSITION_APPLY_UNCONFIRMED 表示提交后的清理或切换未确认，必须核对状态和操作结果，不可自动重试。queued 不代表已生效。"
        })
      }
    },
    {
      name: "mod_composition",
      description:
        "Compose authorized current-chat capabilities. list(query?,cursor?,refresh?) returns concise real identities/component summaries, selection resources and saved template names/revisions; directory pages reuse a short metadata snapshot. details(pluginId,catalogToken?) returns only that Mod's full config schemas; existing setting values remain hidden. stage always revalidates live sources and accumulates same-turn changes; default preserves choices and deep-merges objects, arrays replace entirely, null is literal. removeConfigPaths deletes explicit JSON Pointer fields within a named component config; array indices cannot be deleted. models/skills/mcp/builtins/flow change only when explicitly supplied; null clears a selection. flow accepts only a listed saved id/revision/digest and never executes it. save(savedName,savedRevision=0,catalogToken) stores the queued/current selection; existing names need exact revision. If current features include trials, save returns saved:false and prepares the original trusted reuse approval; it saves automatically only after exact confirmed dependencies become active. Explain that confirmation is required; never claim saved from needs-approval. list.save reports the pending save; restart needs-review and failed/unknown must not be replayed automatically. cancel cancels the pending named save without undoing an already confirmed installation. apply_saved uses savedName+savedRevision with fresh authority checks. undo queues the exact previous selection without replaying actions; cancel discards queued work. Application waits for successful turn end and idle. Never approve, install, guess identities, retry unconfirmed effects, or claim queued is active.",
      schema: z
        .object({
          action: z.enum([
            "list",
            "details",
            "status",
            "stage",
            "cancel",
            "undo",
            "save",
            "apply_saved"
          ]),
          cursor: z.number().int().min(0).max(100000).optional(),
          query: z.string().max(200).optional(),
          refresh: z.boolean().optional(),
          pluginId: z.string().min(1).max(256).optional(),
          catalogToken: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          name: z.string().min(1).max(80).optional(),
          savedName: z.string().min(1).max(80).optional(),
          savedRevision: z.number().int().min(0).optional(),
          replace: z.boolean().optional(),
          removePluginIds: z.array(z.string().min(1).max(256)).max(8).optional(),
          removeConfigPaths: z
            .array(
              z
                .object({
                  pluginId: z.string().min(1).max(256),
                  componentId: z.string().min(1).max(80),
                  path: z.string().min(1).max(1024)
                })
                .strict()
            )
            .max(64)
            .optional(),
          models: z
            .object({
              default: z.string().min(1).max(256).optional(),
              roles: z.record(z.string(), z.string().min(1).max(256))
            })
            .strict()
            .nullable()
            .optional(),
          skills: z
            .object({
              mode: z.enum(["all", "selected"]),
              items: z
                .array(
                  z
                    .object({
                      id: z.string().min(1).max(1024),
                      name: z.string().min(1).max(256),
                      digest: z.string().regex(/^[a-f0-9]{64}$/)
                    })
                    .strict()
                )
                .max(512)
            })
            .strict()
            .nullable()
            .optional(),
          mcp: z
            .object({
              mode: z.enum(["all", "selected"]),
              items: z
                .array(
                  z
                    .object({
                      id: z.string().min(1).max(1024),
                      name: z.string().min(1).max(256),
                      digest: z.string().regex(/^[a-f0-9]{64}$/)
                    })
                    .strict()
                )
                .max(512)
            })
            .strict()
            .nullable()
            .optional(),
          builtins: z.object({ contextMeter: z.boolean() }).strict().optional(),
          flow: z
            .object({
              id: z.string().min(1).max(100),
              revision: z.number().int().min(1),
              digest: z.string().regex(/^[a-f0-9]{64}$/)
            })
            .strict()
            .nullable()
            .optional(),
          capabilities: z
            .array(
              z
                .object({
                  pluginId: z.string().min(1).max(256),
                  name: z.string().min(1).max(256),
                  digest: z.string().regex(/^[a-f0-9]{64}$/),
                  components: z
                    .object({
                      mode: z.enum(["all", "selected"]),
                      ids: z.array(z.string().min(1).max(80)).max(32),
                      config: z.record(z.string(), z.record(z.string(), z.unknown()))
                    })
                    .strict()
                    .optional()
                })
                .strict()
            )
            .max(8)
            .optional()
        })
        .strict()
    }
  )
}
