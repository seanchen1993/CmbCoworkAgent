import { useMemo, type ReactNode } from "react"
import { FunctionSite } from "./FunctionSite"
import { functionMessageTextMode } from "../../../../shared/mods/v2/host-message"
import { useModsChatScope } from "../../lib/mods-chat-scope"
import type { ModObject } from "../../../../shared/mods/types"

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
  const enabled = useModsChatScope(threadId)
  const facts = useMemo((): ModObject => {
    if (role === "user") return { text, origin: { kind: "unclassified" }, isExpanded }
    return { text, isFirstOfReply }
  }, [role, text, isExpanded, isFirstOfReply])
  const mode = functionMessageTextMode(text)
  // An old peer cannot publish a host-only message. Never make a failed or
  // unsupported protected read an instruction to display the unprotected body.
  if (
    enabled &&
    mode === "host-message" &&
    (typeof window === "undefined" || typeof window.api.mods.siteRead !== "function")
  )
    return <p role="alert">当前版本无法安全显示此消息，请更新应用后重试。</p>
  return (
    <FunctionSite
      threadId={threadId}
      component={role === "user" ? "UserMessage" : "AssistantMessage"}
      presentationId={presentationId}
      messageId={role === "user" ? messageId : undefined}
      className="contents"
      facts={facts}
      fallback={fallback}
      renderNative={(safe) => (typeof safe.text === "string" ? renderText(safe.text) : null)}
    />
  )
}
