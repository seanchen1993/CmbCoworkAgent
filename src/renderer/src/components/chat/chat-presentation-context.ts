import { createContext } from "react"
import type { ReactNode } from "react"
import type { Message, ToolCall, ToolResult } from "@/types"
import type { BotMessageReply } from "../../../../shared/bots/contracts"

/** Host-resolved Bot references; absent on ordinary chats and group runtime transcripts. */
export const ChatReplySourceContext = createContext<{
  resolve(messageId: string): Promise<BotMessageReply>
  quoteFor(message: Message): BotMessageReply | undefined
} | null>(null)
export const ChatReplyActionsContext = createContext<{
  reply(messageId: string): void
  setDraftReply(reply: BotMessageReply | null): void
  quoteFor(message: Message): BotMessageReply | undefined
  jump(reply: BotMessageReply): void
} | null>(null)

/** Presentation only. The existing message store and runtime remain the owners of turns. */
export const ChatPresentationContext = createContext<"default" | "bot">("default")

/** The ordinary workbench always keeps its existing execution presentation. */
export const ChatExecutionDetailsContext = createContext(true)
/** Workspace-owned activity presentation; null preserves the ordinary workbench indicator. */
export const ChatActivityPresentationContext = createContext<ReactNode>(null)
export const ChatMessageIdentityContext = createContext<string | null>(null)
export const ChatFoldedToolCallsContext = createContext<ReadonlySet<string>>(new Set())
/** Cards keep their owning row visible when Bot execution records are folded. */
export const ChatExecutionCardCallIdsContext = createContext<ReadonlySet<string>>(new Set())

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
