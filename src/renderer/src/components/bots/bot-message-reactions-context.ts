import { createContext, useContext } from "react"
import type { BotMessageReactionState } from "../../../../shared/bots/message-reactions"

export interface BotReactionContext {
  stateFor(id: string): BotMessageReactionState | undefined
  pending(id: string): boolean
  errorFor(id: string): string | undefined
  readOnly: boolean
  set(id: string, emoji: string, present: boolean): Promise<void>
  retry(): void
}
export const BotMessageReactionsContext = createContext<BotReactionContext | null>(null)
export const useBotMessageReactions = () => useContext(BotMessageReactionsContext)
