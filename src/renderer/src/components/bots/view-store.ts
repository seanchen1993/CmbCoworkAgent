import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { BotDefinition, BotGroup } from "../../../../shared/bots/contracts"
import type { BotChatRecipient } from "@/lib/bot-chat-recipients"
import { BotDraftFileTransfer } from "@/lib/bot-new-chat-files"

/** Unsubmitted composer state is renderer-session only: File bytes are never serialized. */
export function createBotNewChatDraft() {
  return {
    recipients: [] as BotChatRecipient[],
    text: "",
    files: [] as File[],
    busy: false,
    transfer: { current: new BotDraftFileTransfer() },
    attempt: { current: 0 },
    creating: { current: false },
    group: { current: null as BotGroup | null },
    createdRecipients: { current: new Map<string, BotDefinition>() },
    pendingRecipients: { current: new Map<string, Promise<BotDefinition>>() },
    privateRecipient: { current: null as BotDefinition | null }
  }
}
type BotNewChatDraft = ReturnType<typeof createBotNewChatDraft>

export interface BotSidebarSection {
  id: string
  name: string
  botIds: string[]
  groupIds?: string[]
  collapsed: boolean
}

export interface BotViewState {
  activeWorkIdByBot: Record<string, string | null>
  selectedId: string | null
  groupId: string | null
  detailOpen: boolean
  detailTab: "details" | "memory" | "files" | "computer"
  groupDetailTab: "details" | "files" | "members" | "computer"
  showArchived: boolean
  showExecutionDetails: boolean
  accentMode: "neutral" | "bot"
  sidebarWidth: number
  detailWidth: number
  pinnedBotIds: string[]
  /** Optional mixed Bot/group order; older preferences retain their existing layout. */
  pinnedConversationIds?: string[]
  hiddenBotIds: string[]
  pinnedGroupIds: string[]
  hiddenGroupIds: string[]
  sections: BotSidebarSection[]
}
export const DEFAULT_BOT_VIEW: BotViewState = {
  activeWorkIdByBot: {},
  selectedId: null,
  groupId: null,
  detailOpen: true,
  detailTab: "details",
  groupDetailTab: "details",
  showArchived: false,
  showExecutionDetails: false,
  accentMode: "neutral",
  sidebarWidth: 264,
  detailWidth: 320,
  pinnedBotIds: [],
  hiddenBotIds: [],
  pinnedGroupIds: [],
  hiddenGroupIds: [],
  sections: []
}
// Leaves room for the native macOS traffic lights, including their hit targets.
export const BOT_COMPACT_SIDEBAR_WIDTH = 80
export const clampBotPanelWidth = (kind: "sidebar" | "detail", width: number): number =>
  Number.isFinite(width)
    ? kind === "sidebar" && width < 180
      ? BOT_COMPACT_SIDEBAR_WIDTH
      : Math.max(kind === "sidebar" ? 218 : 280, Math.min(480, Math.round(width)))
    : kind === "sidebar"
      ? 264
      : 320

interface BotViewStore {
  hosts: Record<string, BotViewState>
  newChatDrafts: Record<string, BotNewChatDraft>
  updateNewChat(hostId: string, draft: BotNewChatDraft | undefined): void
  update(hostId: string, patch: Partial<BotViewState>): void
}

/** Conversation drafts/streams still belong to ThreadContext after the composer hands off. */
export const useBotViewStore = create<BotViewStore>()((set, get, api) =>
  persist<BotViewStore, [], [], Pick<BotViewStore, "hosts">>(
    (persistedSet) => ({
      hosts: {},
      newChatDrafts: {},
      updateNewChat: (hostId, draft) =>
        // Bypass persistence for live File references, even when localStorage is unavailable.
        set((state) => {
          const drafts = { ...state.newChatDrafts }
          if (draft) drafts[hostId] = draft
          else delete drafts[hostId]
          return { newChatDrafts: drafts }
        }),
      update: (hostId, patch) =>
        persistedSet((state) => ({
          hosts: {
            ...Object.fromEntries(
              Object.entries(state.hosts)
                .filter(([id]) => id !== hostId)
                .slice(-7)
            ),
            [hostId]: { ...DEFAULT_BOT_VIEW, ...state.hosts[hostId], ...patch }
          }
        }))
    }),
    { name: "cmb-bots-view-v1", partialize: (state) => ({ hosts: state.hosts }) }
  )(set, get, api)
)
