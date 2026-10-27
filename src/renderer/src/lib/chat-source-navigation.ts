import { create } from "zustand"

/** One explicit navigation request. Never persisted with conversation or model data. */
export const useChatSourceNavigation = create<{
  target: { threadId: string; messageId: string; ordinal: number } | null
  request(target: { threadId: string; messageId: string; ordinal: number }): void
  clear(): void
}>((set) => ({
  target: null,
  request: (target) => set({ target }),
  clear: () => set({ target: null })
}))
