/** Versioned internal text profiles; absent means the original M02/M03 protocol. */
export type ExpertConversationProfile = "expert_main_v1" | "expert_task_v1"
export interface ExpertContextMessage {
  role: "user" | "assistant"
  text: string
  sourceId: string
  taskVersion: number
}
export interface ExpertContextTarget {
  taskId: string
  title: string
  status: "active" | "awaiting_business" | "completed"
}
export interface ExpertConversationInput {
  profile: ExpertConversationProfile
  taskId: string
  taskVersion: number
  sourceRequestId: string
  messages: ExpertContextMessage[]
  targets: ExpertContextTarget[]
  digest: string
}
export interface ExpertCoordinationEnvelope {
  reply: string
  intent:
    | null
    | { kind: "create_task"; sourceRequestId: string; title: string; contextSourceIds: string[] }
    | { kind: "append_task"; sourceRequestId: string; targetTaskRef: string }
}
export interface ExpertTaskReceipt {
  task: import("./contracts.generated").Task
  role: "main" | "task"
  botId: string
  principalId: string
  sourceRunId: string | null
  messageId: string | null
}
