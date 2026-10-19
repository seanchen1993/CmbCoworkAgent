import type { ReactNode } from "react"
import { FunctionSite } from "./FunctionSite"

/** Presentation only: the caller retains the stored text, copy action and model transcript. */
export function FunctionMessageText({
  threadId,
  messageId,
  presentationId = messageId,
  role,
  text,
  isExpanded,
  isFirstOfReply,
  fallback,
  renderText
}: {
  threadId: string
  messageId: string
  presentationId?: string
  role: "user" | "assistant"
  text: string
  isExpanded: boolean
  isFirstOfReply: boolean
  fallback: ReactNode
  renderText(text: string): ReactNode
}): ReactNode {
  // Keep oversized messages on the original renderer without copying their whole contents to IPC.
  if (text.length > 10000 || !text.trim()) return fallback
  return (
    <FunctionSite
      threadId={threadId}
      component={role === "user" ? "UserMessage" : "AssistantMessage"}
      presentationId={presentationId}
      messageId={role === "user" ? messageId : undefined}
      className="contents"
      facts={
        role === "user"
          ? { text, origin: { kind: "unclassified" }, isExpanded }
          : { text, isFirstOfReply }
      }
      fallback={fallback}
      renderNative={(safe) => (typeof safe.text === "string" ? renderText(safe.text) : null)}
    />
  )
}
