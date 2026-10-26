import {
  rebaseGroupMentions,
  validGroupMentions,
  groupMessageRecipients,
  type BotGroupMention
} from "./bot-group-mentions"
import { botErrorMessage } from "./bot-error-message"
import { create } from "zustand"
import type { BotClient, BotGroup, SendBotGroupMessageInput } from "../../../shared/bots/contracts"
import type { FileAttachment } from "../../../shared/file-attachment"
import { buildAttachmentMessageParts } from "../../../shared/attachment-message-parts"
import { loadGroupDraft, saveGroupDraft, pruneSavedGroupDrafts } from "./bot-group-draft-storage"
import { parseGroupMessage } from "../../../shared/bots/validation"

interface GroupDraft {
  text: string
  targets: string[] | null
  mentions: BotGroupMention[]
  replyTo: { id: string; ordinal: number; text: string; authorBotId: string | null } | null
  attachments: FileAttachment[]
  revision: number
  sending: boolean
  error: string | null
  storageError: string | null
  request: {
    id: string
    text: string
    targets: string
    mentions?: string
    replyToId?: string
    revision: number
  } | null
}

export const EMPTY_GROUP_DRAFT: GroupDraft = {
  text: "",
  targets: null,
  mentions: [],
  replyTo: null,
  attachments: [],
  revision: 0,
  sending: false,
  error: null,
  storageError: null,
  request: null
}
export const groupDraftKey = (hostId: string, groupId: string) => JSON.stringify([hostId, groupId])

function persistDraft(key: string, draft: GroupDraft): GroupDraft {
  return { ...draft, storageError: saveGroupDraft(key, draft) }
}

const prunedGroupSets = new Map<string, string>()

/** Composer state only; Runtime messages/checkpoints remain authoritative after submission. */
export const useBotGroupDrafts = create<{
  drafts: Record<string, GroupDraft>
  restore(key: string): void
  edit(
    key: string,
    patch: Partial<Pick<GroupDraft, "text" | "targets" | "attachments" | "mentions" | "replyTo">>
  ): void
  prune(hostId: string, groupIds: readonly string[]): void
}>()((set) => ({
  drafts: {},
  restore: (key) =>
    set((state) => {
      if (state.drafts[key]) return state
      const saved = loadGroupDraft(key)
      return {
        drafts: {
          ...state.drafts,
          [key]: {
            ...EMPTY_GROUP_DRAFT,
            ...saved.draft,
            mentions: saved.draft?.mentions ?? [],
            replyTo: saved.draft?.replyTo
              ? { ...saved.draft.replyTo, authorBotId: saved.draft.replyTo.authorBotId ?? null }
              : null,
            sending: false,
            error: saved.draft?.request
              ? "上次发送结果尚未确认；重试同一份消息不会重复交办。"
              : null,
            storageError: saved.error ?? null
          }
        }
      }
    }),
  edit: (key, patch) =>
    set((state) => {
      const previous = state.drafts[key] ?? EMPTY_GROUP_DRAFT
      const text = patch.text ?? previous.text
      const mentions = validGroupMentions(
        text,
        patch.mentions ?? rebaseGroupMentions(previous.text, text, previous.mentions)
      )
      return {
        drafts: {
          ...state.drafts,
          [key]: persistDraft(key, {
            ...previous,
            ...patch,
            mentions,
            revision: previous.revision + 1
          })
        }
      }
    }),
  prune: (hostId, groupIds) =>
    set((state) => {
      const signature = JSON.stringify([...groupIds].sort())
      if (prunedGroupSets.get(hostId) !== signature) {
        try {
          pruneSavedGroupDrafts(hostId, groupIds)
          prunedGroupSets.set(hostId, signature)
        } catch {
          // Retry on the next authoritative snapshot; never drop an in-memory draft here.
        }
      }
      const keep = new Set(groupIds.map((id) => groupDraftKey(hostId, id)))
      const prefix = JSON.stringify([hostId]).slice(0, -1) + ","
      const entries = Object.entries(state.drafts).filter(
        ([key]) => !key.startsWith(prefix) || keep.has(key)
      )
      return entries.length === Object.keys(state.drafts).length
        ? state
        : { drafts: Object.fromEntries(entries) }
    })
}))

/** A retry keeps the accepted request's payload, independently of later membership changes. */
export function hasUnchangedGroupRequest(draft: Pick<GroupDraft, "request" | "revision">): boolean {
  return draft.request !== null && draft.request.revision === draft.revision
}

/** Keep the in-flight lock and retry identity outside the mounted conversation. */
export async function sendGroupDraft(client: BotClient, group: BotGroup): Promise<void> {
  const key = groupDraftKey(client.hostId, group.id)
  const draft = useBotGroupDrafts.getState().drafts[key] ?? EMPTY_GROUP_DRAFT
  if (draft.sending) return
  const retry = hasUnchangedGroupRequest(draft) ? draft.request : null
  let request: NonNullable<GroupDraft["request"]>
  let input: SendBotGroupMessageInput
  if (retry) {
    request = retry
    try {
      // Do not recompute recipients or metadata: the Host may already have accepted this request.
      input = parseGroupMessage({
        groupId: group.id,
        requestId: request.id,
        text: request.text,
        targetBotIds: JSON.parse(request.targets),
        ...(request.replyToId ? { replyToId: request.replyToId } : {}),
        // Pre-upgrade requests omitted mention metadata; preserve that wire contract too.
        ...(request.mentions !== undefined ? { mentions: JSON.parse(request.mentions) } : {})
      })
    } catch (cause) {
      useBotGroupDrafts.setState((state) => ({
        drafts: {
          ...state.drafts,
          [key]: { ...draft, error: botErrorMessage(cause, "原发送记录无效，请编辑后重新发送。") }
        }
      }))
      return
    }
  } else {
    const text =
      `${draft.text.trim() || (draft.attachments.length ? "请分析以下文件内容。" : "")}${buildAttachmentMessageParts(draft.attachments).attachmentModelBlocks}`.trim()
    const mentions = validGroupMentions(draft.text, draft.mentions)
    const recipients = groupMessageRecipients(mentions, group.memberIds, {
      targets: draft.targets,
      replyAuthorId: draft.replyTo?.authorBotId
    })
    if (recipients.error) {
      useBotGroupDrafts.setState((state) => ({
        drafts: { ...state.drafts, [key]: { ...draft, error: recipients.error } }
      }))
      return
    }
    const targetBotIds = [...new Set(recipients.ids)].sort()
    if (!text || !targetBotIds.length) return
    if (text.length > 30_000) {
      useBotGroupDrafts.setState((state) => ({
        drafts: {
          ...state.drafts,
          [key]: { ...draft, error: "消息和附件内容合计超过 30,000 字符，请减少内容后重试。" }
        }
      }))
      return
    }
    const leading = draft.text.length - draft.text.trimStart().length
    const sentMentions = mentions.map((mention) => ({
      ...mention,
      start: mention.start - leading,
      end: mention.end - leading
    }))
    request = {
      id: crypto.randomUUID(),
      text,
      targets: JSON.stringify(targetBotIds),
      mentions: JSON.stringify(sentMentions),
      ...(draft.replyTo ? { replyToId: draft.replyTo.id } : {}),
      revision: draft.revision
    }
    input = {
      groupId: group.id,
      requestId: request.id,
      text,
      targetBotIds,
      ...(request.replyToId ? { replyToId: request.replyToId } : {}),
      ...(sentMentions.length ? { mentions: sentMentions } : {})
    }
  }
  const pending = persistDraft(key, { ...draft, request, sending: true, error: null })
  if (pending.storageError) {
    pending.sending = false
    pending.error = "发送标识未能保存，请重试后再发送，避免重复交办。"
  }
  useBotGroupDrafts.setState((state) => ({ drafts: { ...state.drafts, [key]: pending } }))
  if (pending.storageError) return
  let error: string | null = null
  try {
    await client.sendGroup(input)
  } catch (cause) {
    error = botErrorMessage(cause, "发送失败，请重试。")
  }
  useBotGroupDrafts.setState((state) => {
    const current = state.drafts[key]
    // A deleted group must not be resurrected by a late response.
    if (!current || current.request?.id !== request.id) return state
    return {
      drafts: {
        ...state.drafts,
        [key]: persistDraft(key, {
          ...current,
          sending: false,
          error,
          text: !error && current.revision === request.revision ? "" : current.text,
          mentions: !error && current.revision === request.revision ? [] : current.mentions,
          replyTo: !error && current.revision === request.revision ? null : current.replyTo,
          attachments: error
            ? current.attachments
            : current.attachments.filter(
                (file) => !draft.attachments.some((sent) => sent.filePath === file.filePath)
              ),
          request: error ? request : null
        })
      }
    }
  })
}
