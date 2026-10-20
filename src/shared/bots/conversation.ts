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
