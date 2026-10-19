import { create } from "zustand"
import { persist } from "zustand/middleware"

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

/** Bot-only view preferences; existing thread context continues to own chat drafts and streams. */
export const useBotViewStore = create<{
  hosts: Record<string, BotViewState>
  update(hostId: string, patch: Partial<BotViewState>): void
}>()(
  persist(
    (set) => ({
      hosts: {},
      update: (hostId, patch) =>
        set((state) => ({
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
  )
)
