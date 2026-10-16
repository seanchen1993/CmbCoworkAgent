import { selectChatFlow, type ChatFlowChoice } from "./chat-flow-choice"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"

export const CHAT_FLOW_USE_EVENT = "devclaw:chat-flow-use"
export const CHAT_COMPOSER_FOCUS_EVENT = "devclaw:chat-composer-focus"
export type ChatFlowUseRequest = ChatFlowChoice & { threadId: string }
export type ChatComposerFocusRequest = Pick<ChatFlowUseRequest, "threadId" | "workspace">
const focusRequests = new Map<string, ChatComposerFocusRequest>()

/** Navigation may commit after the event; retain at most one focus-only intent per chat. */
export function requestChatComposerFocus(request: ChatComposerFocusRequest): void {
  focusRequests.delete(request.threadId)
  focusRequests.set(request.threadId, { ...request })
  while (focusRequests.size > 64) focusRequests.delete(focusRequests.keys().next().value!)
  window.dispatchEvent(new CustomEvent(CHAT_COMPOSER_FOCUS_EVENT, { detail: request }))
}

export function consumeChatComposerFocus(request: ChatComposerFocusRequest): boolean {
  const pending = focusRequests.get(request.threadId)
  if (
    !pending ||
    normalizeWorkspacePathKey(pending.workspace) !== normalizeWorkspacePathKey(request.workspace)
  )
    return false
  focusRequests.delete(request.threadId)
  return true
}

/** An explicit, one-message UI selection. Never starts execution or rewrites the draft. */
export function requestChatFlowUse(request: ChatFlowUseRequest): void {
  const { threadId, ...choice } = request
  selectChatFlow(threadId, choice)
  requestChatComposerFocus(request)
  window.dispatchEvent(new CustomEvent(CHAT_FLOW_USE_EVENT, { detail: request }))
}
