import { useMemo } from "react"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  BotPromptEditorSurface,
  type BotPromptDraftPort,
  type BotPromptEditorSurfaceProps
} from "./BotPromptEditorSurface"

export type { BotPromptControls, BotPromptSelection } from "./BotPromptEditorSurface"

/** Preserve the original conversation draft/revision and selected reference owner. */
export function BotPromptEditor({
  conversationId,
  ...props
}: Omit<BotPromptEditorSurfaceProps, "editorId" | "ariaLabel" | "owner" | "inlineReferences"> & {
  conversationId: string
}) {
  const owner = useMemo<BotPromptDraftPort>(
    () => ({
      read: () => useBotWorkspaceStore.getState().drafts[conversationId],
      commit(expectedRevision, change) {
        const state = useBotWorkspaceStore.getState()
        const current = state.drafts[conversationId]
        if (!current || current.revision !== expectedRevision) return
        state.updateDraft(conversationId, change)
        return useBotWorkspaceStore.getState().drafts[conversationId]
      },
      canInsertReference: () => useBotWorkspaceStore.getState().selected === conversationId
    }),
    [conversationId]
  )
  return (
    <BotPromptEditorSurface {...props} editorId={`bot-composer-${conversationId}`} owner={owner} />
  )
}
