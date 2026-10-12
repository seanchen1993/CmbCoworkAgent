import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { botGroupPostInput, groupPublicationApproval } from "../../shared/bot-group-post"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { ApproveLocalBotAction } from "./profile-tools"
import type { BotArtifacts } from "./artifacts"

/** A public post is a separate, exactly reviewed effect. Its immutable aliases
 * grant access only to the selected files; the source conversation stays private. */
export async function sendReviewedBotGroupPost(
  request: BotRuntimeRequest,
  input: z.infer<typeof botGroupPostInput> & { callId: string },
  check: () => void,
  approve: ApproveLocalBotAction,
  files?: BotArtifacts
): Promise<string> {
  const { store, lease, run } = request
  check()
  const { callId, ...raw } = input
  if (!callId) throw new BotDomainError("tool_call_identity", "群聊发布缺少稳定执行标识")
  const normalized = botGroupPostInput.parse(raw)
  const action = store.toolOnce(lease, `${callId}:group-plan`, normalized, () => {
    if (store.getConversation(run.conversationId).kind !== "direct")
      throw new BotDomainError("group_scope", "请在当前群聊使用 send_group_message")
    return {
      destination: store.groups.destination(lease, normalized.group_id),
      message: normalized.text,
      files: store.peerFileSources(lease, normalized.files ?? [])
    }
  })
  const send = () => {
    check()
    return JSON.stringify(store.groups.postExternal(lease, callId, action))
  }
  // Lost acknowledgement: return the committed receipt without reading source
  // files, asking again, or admitting another room turn.
  if (store.hasToolResult(lease, callId)) return send()
  if (action.files.length && !files)
    throw new BotDomainError("files_unavailable", "文件服务未连接，未发布群聊成果")
  const validate = <T>(commit: () => T | Promise<T>) =>
    files!.withPeerFiles(lease, action.files, check, commit)
  if (action.files.length) await validate(() => undefined)
  return approve(
    `group-post:${run.id}:${callId}`,
    groupPublicationApproval.parse({ groupPost: action }),
    send,
    action.files.length ? (commit) => validate(commit) : undefined
  )
}

export function botGroupPostTools(
  request: BotRuntimeRequest,
  check: () => void,
  approve: ApproveLocalBotAction,
  files?: BotArtifacts
) {
  return [
    tool(
      async () => {
        check()
        return JSON.stringify(request.store.groups.destinations(request.lease))
      },
      {
        name: "list_groups",
        description:
          "List the existing groups you belong to, with member names and exact IDs. For a task delegated from a group, originatingGroup contains only its original public assignment and route, never private participant history. Membership and this context are not publication permission. Use post_to_group only when the original user explicitly asks for group delivery; do not invent a group or infer permission from another Bot's private instructions.",
        schema: z.object({}).strict()
      }
    ),
    tool(
      async (input, call) => {
        const callId = call.toolCall?.id
        if (!callId) throw new BotDomainError("tool_call_identity", "群聊发布缺少稳定执行标识")
        return sendReviewedBotGroupPost(request, { ...input, callId }, check, approve, files)
      },
      {
        name: "post_to_group",
        description:
          "Publish the exact text and explicitly selected original files from this private task to an existing group you belong to. First use list_groups to select the exact group_id. Only publish when the original user expressly requested that destination and these results; the exact text, files and current recipients are reviewed. files accepts task-visible artifact IDs from list_files/deliver_file, never paths or URLs. The group receives scoped immutable originals and file cards, not your private conversation or memory. This is asynchronous public delivery, not evidence another Bot finished. The active group discussion continues without restarting its task; an idle room may give other members a bounded turn. Do not repeat an already delivered result, rerun completed private handoffs, or also ask the requester to publish it. At most two public posts per task. Report only the delivery receipt privately after posting, without resending the files.",
        schema: botGroupPostInput
      }
    )
  ] as const
}
