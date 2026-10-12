import type { BotMessage, BotReadState } from "./bot-types"

export interface BotThreadSummary {
  rootId: string
  count: number
  readState: BotReadState
}

export interface BotThread extends BotThreadSummary {
  conversationId: string
  root: BotMessage
}
