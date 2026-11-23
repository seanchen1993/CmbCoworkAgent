import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useThreadContext } from "@/lib/thread-context"
import { loadBotConversationDraft } from "@/lib/bot-conversation-draft"
import { groupDraftKey, useBotGroupDrafts } from "@/lib/bot-group-drafts"
import { loadGroupDraft } from "@/lib/bot-group-draft-storage"
import { botSidebarPreview } from "@/lib/bot-sidebar-view"

export type BotPreviewConversation = { hostId: string; id: string; threadId?: string }

/** Mounted only inside an open tooltip. Read the existing draft owner, never a transcript copy. */
export function BotSidebarPreview({
  conversation,
  preview,
  waiting
}: {
  conversation: BotPreviewConversation
  preview: string
  waiting: boolean
}) {
  const context = useThreadContext()
  const { hostId, id, threadId } = conversation
  const groupKey = groupDraftKey(hostId, id)
  const saved = useMemo(
    () => (threadId ? loadBotConversationDraft(hostId, id).draft : loadGroupDraft(groupKey).draft),
    [hostId, id, threadId, groupKey]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      threadId
        ? context.subscribeToThreadState(threadId, listener)
        : useBotGroupDrafts.subscribe(listener),
    [context, threadId]
  )
  const snapshot = useCallback(() => {
    const current = threadId
      ? context.getAllThreadStates()[threadId]
      : useBotGroupDrafts.getState().drafts[groupKey]
    const text = current
      ? "draftInput" in current
        ? current.draftInput
        : current.text
      : saved?.text
    const files = current
      ? "draftAttachments" in current
        ? current.draftAttachments
        : current.attachments
      : saved?.attachments
    return text?.trim() || files?.map((file) => file.filename).join("、") || ""
  }, [context, threadId, groupKey, saved])
  // A primitive snapshot means streaming updates do not rerender the hover card.
  const draft = useSyncExternalStore(subscribe, snapshot, () => "")
  const value = botSidebarPreview(preview, draft, waiting)
  if (!value.text) return null
  return (
    <span className="bot-sidebar-tooltip-preview" data-draft={value.isDraft || undefined}>
      {value.isDraft && <span className="bot-sidebar-tooltip-draft">草稿 </span>}
      {value.text}
    </span>
  )
}
