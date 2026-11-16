import { createContext } from "react"
import type { ReactNode } from "react"
import type { Message, ToolCall, ToolResult } from "@/types"
import type { BotMessageReply } from "../../../../shared/bots/contracts"
import type { BotSkillSelection } from "../../../../shared/bots/skill-selection"

/** Display metadata from a trusted origin; never sent as a same-thread reply ID. */
export type ChatQuotedReply = BotMessageReply & { sourceThreadId?: string }

/** Host-resolved Bot references. */
export const ChatReplySourceContext = createContext<{
  resolve(messageId: string): Promise<BotMessageReply>
  quoteFor(message: Message): ChatQuotedReply | undefined
  skillFor?(messageId: string): BotSkillSelection | undefined
  editReady?: boolean
} | null>(null)
export const ChatReplyActionsContext = createContext<{
  canReply?: boolean
  editReady?: boolean
  reply(messageId: string): void
  setDraftReply(reply: BotMessageReply | null): void
  quoteFor(message: Message): ChatQuotedReply | undefined
  jump(reply: BotMessageReply): void
} | null>(null)

/** Presentation only. The existing message store and runtime remain the owners of turns. */
export const ChatPresentationContext = createContext<"default" | "bot">("default")
export const ChatDesktopWorkIdContext = createContext<string | undefined>(undefined)

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
  ((tool: ToolCall, result?: Pick<ToolResult, "content" | "is_error">, assistantMessageId?: string,
    deliveryScope?: Message["botHistoryDeliveryScope"]) => ReactNode) | null
>(null)

export const ChatMessagePresentationContext = createContext<
  ((message: Message) => ReactNode) | null
>(null)

/** Host-verified Bot mention presentation; ordinary user text remains plain. */
export const ChatUserTextPresentationContext = createContext<
  ((message: Message, text: string) => ReactNode) | null
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

/** Public group Markdown uses the group's Host-resolved root, independent of its author. */
export const ChatFileWorkspaceContext = createContext<{
  threadId: string
  workspacePath: string | null
} | null>(null)

/** Optional hidden rows for verified quiet background turns; underlying messages remain intact. */
export const ChatMessageVisibilityContext = createContext<ReadonlySet<string>>(new Set())

/** Validated, local task-history navigation; absent for ordinary links and external channels. */
export const ChatHistorySourceContext = createContext<((href: string) => void) | null>(null)
