import { createContext, type ReactNode } from "react"
import type { BotGroupMention } from "../../../../shared/bots/contracts"

/** Opt-in presentation only. Persisted IDs and dispatch remain owned by the Bot host. */
export const BotInlineMentionsContext = createContext<{
  mentions: readonly BotGroupMention[]
  canOpen: (botId: string) => boolean
  open: (botId: string) => void
  renderLabel?: (mention: BotGroupMention) => ReactNode
} | null>(null)
