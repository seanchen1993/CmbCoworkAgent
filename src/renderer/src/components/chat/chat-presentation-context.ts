import { createContext } from "react"
import type { ReactNode } from "react"
import type { Message, ToolCall, ToolResult } from "@/types"

/** Presentation only. The existing message store and runtime remain the owners of turns. */
export const ChatPresentationContext = createContext<"default" | "bot">("default")

/** The ordinary workbench always keeps its existing execution presentation. */
export const ChatExecutionDetailsContext = createContext(true)
/** Workspace-owned activity presentation; null preserves the ordinary workbench indicator. */
export const ChatActivityPresentationContext = createContext<ReactNode>(null)
export const ChatMessageIdentityContext = createContext<string | null>(null)
export const ChatFoldedToolCallsContext = createContext<ReadonlySet<string>>(new Set())
export const ChatFoldedMessageIdsContext = createContext<ReadonlySet<string>>(new Set())

/** Optional workspace presentation; never changes tool execution or approval rendering. */
export const ChatToolPresentationContext = createContext<
  ((tool: ToolCall, result?: Pick<ToolResult, "content" | "is_error">) => ReactNode) | null
>(null)

export const ChatMessagePresentationContext = createContext<
  ((message: Message) => ReactNode) | null
>(null)

/** Optional file card after the existing Markdown workspace-path resolver succeeds. */
export const ChatFilePresentationContext = createContext<
  | ((file: {
      filePath: string
      threadId: string
      label: ReactNode
      messageId?: string
    }) => ReactNode)
  | null
>(null)

/** Optional hidden rows for verified quiet background turns; underlying messages remain intact. */
export const ChatMessageVisibilityContext = createContext<ReadonlySet<string>>(new Set())
