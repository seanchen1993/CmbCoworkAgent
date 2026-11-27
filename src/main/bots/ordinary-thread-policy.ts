import { resolveAgentModeFromMetadata } from "../../shared/agent-mode-metadata"
import { hasOrdinaryBotConversationShape } from "../../shared/ordinary-conversation"
export { hasOrdinaryBotConversationShape } from "../../shared/ordinary-conversation"

/** Admission for new Bot operations; reading does not require a live directory. */
export function isOrdinaryBotConversation(metadata: Record<string, unknown>): boolean {
  return resolveAgentModeFromMetadata(metadata) === "normal" && hasOrdinaryBotConversationShape(metadata)
}
