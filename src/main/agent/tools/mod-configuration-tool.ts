import { tool } from "langchain"
import { z } from "zod"
import { getModDevelopmentService } from "../../mods/devtools/development-service"
import { getCreatorUserConfigService } from "../../mods/devtools/creator-user-config"
import { captureLocalThreadRunLease, getLocalThreadRunLease } from "../thread-run-lease"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export function createModConfigurationTool(input: {
  threadId: string
  workspace: string
  signal?: AbortSignal
}) {
  const { threadId, workspace } = input
  const lease = getLocalThreadRunLease(threadId)
  const ownsLease = captureLocalThreadRunLease(threadId)
  const development = getModDevelopmentService()
  const assertCreator = development?.captureCreatorMode?.(threadId, workspace)
  return tool(async args => {
    try {
      const assertTurn = () => {
        input.signal?.throwIfAborted()
        if (!lease || lease.owner !== "desktop" || !ownsLease?.() ||
          !development?.isCreatorMode(threadId, workspace)) throw Error("DEVELOPMENT_TURN_CHANGED")
        assertCreator?.()
      }
      assertTurn()
      // Shares the durable cumulative request ledger with authoring and composition.
      development!.claimAuthoringBudget?.(threadId, lease!.runId, "operation")
      const service = getCreatorUserConfigService()
      if (!service) throw Error("MODS_CONFIGURATION_UNAVAILABLE")
      const signal = input.signal ?? new AbortController().signal
      let result: unknown
      if (args.action === "status") result = service.status(threadId)
      else if (args.action === "inspect") {
        if (!args.pluginId) throw Error("MODS_CONFIG_ARGUMENTS")
        result = await service.inspect(threadId, workspace, args.pluginId, signal, assertTurn)
      } else {
        if (!args.pluginId || !args.digest || args.revision === undefined)
          throw Error("MODS_CONFIG_ARGUMENTS")
        result = await service.change(threadId, workspace,
          { pluginId: args.pluginId, digest: args.digest, revision: args.revision },
          args.action, args.key, args.value, signal, assertTurn)
      }
      assertTurn()
      return JSON.stringify({ ok: true, result })
    } catch (error) {
      const code = error instanceof ModFunctionError ? error.code :
        error instanceof Error ? error.message : ""
      return JSON.stringify({ ok: false,
        error: /^[A-Z][A-Z0-9_]+$/.test(code) ? code : "MODS_CONFIGURATION_FAILED",
        hint: "inspect 读取真实 schema、版本和脱敏状态。仅修改用户要求的非敏感字段；目录、文件和敏感字段使用 request_input，让用户在当前聊天原生参数卡片中选择或填写。不得把秘密写入工具参数。版本改变重新读取，未知结果先核对，不重放。参数在项目中共享；保存后原运行器等待任务结束安全应用，pending 不代表已生效。" })
    }
  }, {
    name: "mod_configuration",
    description: "Configure original plugin userConfig, distinct from component appearance config. " +
      "inspect(pluginId) returns current schema, nonsecret values and secret presence only. " +
      "set/reset require exact pluginId,digest,revision,key from inspect; reset removes an ordinary override to restore the current schema default. " +
      "Directory/file/sensitive fields require request_input with the same binding, showing the original trusted native editor in this chat; never accept a secret or guess a path. " +
      "User-config is shared by chats in this workspace, not saved in named compositions. " +
      "apply uses the original idle-safe application; pending is not applied. status returns the input request reference only; inspect verifies actual saved/effective state. " +
      "No authorization, plugin installation, automatic reload or external action replay.",
    schema: z.object({
      action: z.enum(["inspect", "set", "reset", "request_input", "apply", "status"]),
      pluginId: z.string().min(1).max(256).optional(),
      digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      revision: z.number().int().min(0).optional(),
      key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional(),
      value: z.union([z.string().max(32768), z.number().finite(), z.boolean(),
        z.array(z.string().max(32768)).max(256)]).optional()
    }).strict().superRefine((args, ctx) => {
      if ((args.action !== "set" && args.value !== undefined) ||
        (args.action === "set" && args.value === undefined))
        ctx.addIssue({ code: "custom", message: "Only ordinary set accepts value" })
    })
  })
}
