import type { ReactNode } from "react"
import { FunctionSite } from "./FunctionSite"

/** Presentation only: the caller retains the stored text, copy action and model transcript. */
export function FunctionMessageText({
  threadId,
  role,
  text,
  isExpanded,
  isFirstOfReply,
  fallback
}: {
  threadId: string
  role: "user" | "assistant"
  text: string
  isExpanded: boolean
  isFirstOfReply: boolean
  fallback: ReactNode
}): ReactNode {
  // Keep oversized messages on the original renderer without copying their whole contents to IPC.
  if (text.length > 10000 || !text.trim()) return fallback
  return (
    <FunctionSite
      threadId={threadId}
      component={role === "user" ? "UserMessage" : "AssistantMessage"}
      className="contents"
      facts={
        role === "user"
          ? { text, origin: { kind: "unclassified" }, isExpanded }
          : { text, isFirstOfReply }
      }
      fallback={fallback}
    />
  )
}
