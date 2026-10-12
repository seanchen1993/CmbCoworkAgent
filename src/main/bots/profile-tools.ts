import { randomUUID } from "node:crypto"
import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import {
  agentProfilePatch,
  createAgentParameters,
  updateAgentParameters
} from "./upstream/grok-agent-profiles"

export const BOT_PROFILE_MUTATION_TOOLS = new Set(["create_bot", "update_bot"])
export type ApproveLocalBotAction = (
  id: string,
  action: unknown,
  operation: () => string,
  commit?: (operation: () => string | Promise<string>) => Promise<string>
) => Promise<string>

/** Grok profile tools adapted to Cmb's revision, approval and local transaction boundary. */
export function botProfileTools(
  request: BotRuntimeRequest,
  check: () => void,
  approve: ApproveLocalBotAction
): StructuredToolInterface[] {
  const { store, bot, run, lease } = request
  const recoverable = async (operation: () => Promise<string>) => {
    try {
      check()
      return await operation()
    } catch (error) {
      if (
        error instanceof BotDomainError &&
        ["revision_conflict", "bot_busy", "bot_limit", "not_found"].includes(error.code)
      )
        return JSON.stringify({ ok: false, error: error.code, message: error.message })
      throw error
    }
  }
  return [
    tool(
      ({ agent_id }) => {
        check()
        const profile = store.getBot(agent_id)
        return JSON.stringify({
          agent_id: profile.id,
          revision: profile.revision,
          name: profile.name,
          title: profile.title ?? "",
          description: profile.instructions,
          modelRef: profile.modelRef,
          workspacePath: profile.workspacePath,
          connectorIds: profile.connectorIds ?? []
        })
      },
      {
        name: "read_bot",
        description:
          "Read a Bot's current profile and exact revision before updating it. Use list_bots for IDs. Contains responsibilities and configured capabilities, never private conversations or memory.",
        schema: z.object({ agent_id: z.string().min(1).max(160) })
      }
    ),
    tool(
      (input, call) =>
        recoverable(async () => {
          const id = `bot-create:${run.id}:${call.toolCall?.id ?? randomUUID()}`
          const settings = {
            modelRef: bot.modelRef,
            workspacePath: bot.workspacePath,
            connectorIds: bot.connectorIds ?? []
          }
          return approve(id, { botProfile: { operation: "create", ...input, ...settings } }, () => {
            check()
            const created = store.createBot(
              {
                nonce: id,
                expectedDataEpoch: store.dataEpoch(),
                name: input.name,
                instructions: input.description,
                ...settings
              },
              lease
            )
            return JSON.stringify({ ok: true, ...created })
          })
        }),
      {
        name: "create_bot",
        description:
          "Create a persistent teammate only when requested by the user, after approval of its name, responsibilities and capabilities. It inherits this Bot's configured model, project directory and connector selection, shown in the approval. Private history, memory, credentials, plugin grants and routines are not copied. After successful configuration it may open its own chat with a tool-free hello; this does not start work. Use message_bot with the returned bot.id to assign work. Read the receipt; a denied or failed creation is not success.",
        schema: createAgentParameters
      }
    ),
    tool(
      (input, call) =>
        recoverable(async () => {
          const patch = agentProfilePatch(input)
          if (!Object.keys(patch).length)
            return JSON.stringify({
              ok: false,
              error: "empty_patch",
              message: "未提供需要修改的职责或名称"
            })
          const id = `bot-update:${run.id}:${call.toolCall?.id ?? randomUUID()}`
          // The approval binds the exact patch and expected version. Do not read a newer
          // revision on replay, which could silently expand an earlier authorization.
          return approve(
            id,
            {
              botProfile: {
                operation: "update",
                agent_id: input.agent_id,
                revision: input.revision,
                ...patch
              }
            },
            () => {
              check()
              const updated = store.updateBotProfile(lease, {
                id: input.agent_id,
                revision: input.revision,
                name: patch.name,
                instructions: patch.description
              })
              return JSON.stringify({ ok: true, bot: updated, appliesFrom: "next_turn" })
            }
          )
        }),
      {
        name: "update_bot",
        description:
          "Update a Bot's name or responsibilities only as requested by the user, after approval. Read its exact ID and revision with read_bot first. Omitted or empty fields are unchanged. Capabilities cannot be changed here. New responsibilities apply to subsequent turns; another Bot with active work must finish or be stopped first. On conflict reread and confirm; never blindly overwrite or report success after an error.",
        schema: updateAgentParameters.extend({ revision: z.number().int().min(1) })
      }
    )
  ]
}
