export const BOT_WORK_REMOTE_ACCESS_BLOCKED =
  "此会话由 Bot 任务管理。请在任务会话继续，或解除任务关联后再接入招乎。"

/** A task points at a conversation; the conversation remains the owner of its transcript/settings. */
export type BotWorkConversationRef =
  | {
      kind: "local_thread"
      threadId: string
      incarnation: { token: string | null; legacyCreatedAt: number }
    }
  | { kind: "project_session"; projectId: string; conversationId: string }
  | { kind: "cloud_session"; serviceId: string; conversationId: string }

export interface BotWorkConversationLink {
  ref: BotWorkConversationRef
  origin: "existing" | "created"
  state: "preparing" | "bound" | "detaching" | "detached"
}
export interface LinkBotWorkConversationInput {
  botId: string
  operationId: string
  title: string
  goal: string
  conversation: BotWorkConversationRef
}
export interface BotWorkConversationResolution {
  bot: import("./contracts").BotDefinition
  work: import("./work").BotWorkItem
  workspacePath: string
  /** Verified original group, retained when opening its task in the ordinary workbench. */
  imConversation?: Pick<import("./im-channel").BotImConversation, "id" | "title" | "state">
}
/** Lightweight, validated sidebar identity. No transcript, instructions or execution authority. */
export interface BotThreadOwner {
  userControlled?: true
  working?: true
  threadId: string
  threadCreatedAt: number
  workId: string
  bot: Pick<import("./contracts").BotDefinition, "id" | "name" | "color" | "shape" | "archived">
}
/** Host-owned operation. The renderer only parks its existing drafts before it commits. */
export type BotConversationTransitionRequest =
  | {
      id: string
      action: "link"
      threadId: string
      incarnation: Extract<BotWorkConversationRef, { kind: "local_thread" }>["incarnation"]
    }
  | {
      id: string
      action: "unlink"
      threadId: string
      link: BotWorkConversationResolution
      /** Verified native thread identity for draft handoff before its first exposure. */
      unexposedRef?: Extract<BotWorkConversationRef, { kind: "local_thread" }>
    }
  | { id: string; action: "delete"; title: string; threadId?: string; work?: { botId: string; workId: string } }
export interface BotConversationDeletionOutcome {
  deletedThreadId?: string
  deletedWork?: { botId: string; workId: string }
  /** Native deletion committed but remaining work bookkeeping needs a retry. */
  error?: string
}
export interface BotConversationClient {
  onTransition?(listener: (request: BotConversationTransitionRequest) => void): () => void
  onTransitionDismissed?(listener: (id: string) => void): () => void
  finishTransition?(id: string, error?: string): Promise<BotConversationDeletionOutcome | void>
  owners?(threadIds: string[]): Promise<BotThreadOwner[]>
  revalidateDraftReply?(
    conversation: import("./thread-history").BotOrdinaryThreadRef,
    reply: import("./contracts").BotMessageReply
  ): Promise<import("./contracts").BotMessageReply>
  resolveHistory?(botId: string, source: import("./thread-history").BotThreadHistorySource): Promise<{ threadId: string; messageId: string; ordinal: number }>
  resolve(threadId: string): Promise<BotWorkConversationResolution | null>
  link(input: LinkBotWorkConversationInput): Promise<import("./work").BotWorkItem>
  expose(botId: string, workId: string): Promise<import("./work").BotWorkItem>
  unlinkHasOpenPages?(botId: string, workId: string): Promise<boolean>
  unlink(
    botId: string,
    workId: string,
    expectedVersion: number
  ): Promise<import("./work").BotWorkItem>
}
