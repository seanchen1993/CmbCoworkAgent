import type { ServiceDeliveryView, TextDeliveryDetail, TextDeliverySummary } from "./text-delivery"
/** Service-managed text conversations. No credentials, filesystem paths or RunSpec input. */
export type ServiceRequestStatus =
  | "saved"
  | "next_round"
  | "submitting"
  | "queued"
  | "waiting_node"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome_unknown"
  | "blocked"
export interface ServiceConversationOverview {
  conversationId: string | null
  expertName: string | null
  connected: boolean
  nodeEnabled: boolean
  selectedModel: { ref: string; name: string } | null
  models: Array<{ ref: string; name: string }>
}
export interface ServiceTaskView {
  role?: "main" | "task"
  taskStatus?: "active" | "awaiting_business" | "completed"
  busy?: boolean
  taskRef: string
  taskNumber: string | null
  title: string
  status: ServiceRequestStatus
  delivery?: TextDeliverySummary | null
}
export interface ServiceRequestView {
  origin?: { mainRequestId: string }
  coordination?: {
    taskRef: string | null
    title: string | null
    state: "waiting" | "delivered" | "blocked"
  }
  requestId: string
  taskRef: string
  text: string
  status: ServiceRequestStatus
  notice: string | null
  runId: string | null
  supersededBy?: string
  publication?: { state: "saving" | "blocked" | "published" | "history"; notice: string | null }
  result: {
    runId: string
    attemptId: string
    outcome: "succeeded" | "failed"
    text: string
    settledAt: string
  } | null
  createdAt: string
}
export interface ServicePage<T> {
  pending?: boolean
  task?: ServiceTaskView
  selectedTask?: ServiceTaskView
  items: T[]
  nextCursor: string | null
}
export interface ServiceConversationApi {
  openChats(): Promise<ServiceConversationOverview & { mainTaskRef: string | null }>
  chatTasks(input: {
    conversationId: string
    cursor: string | null
    query: string
    selectedRef?: string | null
  }): Promise<ServicePage<ServiceTaskView>>
  chat(input: {
    conversationId: string
    taskRef: string | null
    role: "main" | "task"
    requestId: string
    text: string
  }): Promise<ServiceRequestView>
  taskLifecycle(input: {
    conversationId: string
    taskRef: string
    operationId: string
    action: "complete" | "reopen"
  }): Promise<void>
  retryChat(input: {
    conversationId: string
    taskRef: string
    requestId: string
    operationId: string
  }): Promise<void>
  subscribeInvalidation?(listener: (busy: boolean) => void): () => void
  open(): Promise<ServiceConversationOverview>
  selectModel(input: {
    conversationId: string
    modelRef: string
  }): Promise<ServiceConversationOverview>
  tasks(input: {
    conversationId: string
    cursor: string | null
  }): Promise<ServicePage<ServiceTaskView>>
  read(input: {
    conversationId: string
    taskRef: string
    cursor: string | null
  }): Promise<ServicePage<ServiceRequestView>>
  updates(input: {
    conversationId: string
    taskRef: string
    requestIds: string[]
  }): Promise<ServiceRequestView[]>
  send(input: {
    conversationId: string
    taskRef: string | null
    requestId: string
    text: string
  }): Promise<ServiceRequestView>
  delivery(input: {
    conversationId: string
    taskRef: string
    before: number | null
  }): Promise<ServiceDeliveryView | null>
  deliveryVersion(input: {
    conversationId: string
    taskRef: string
    versionId: string
  }): Promise<TextDeliveryDetail>
  publish(input: { conversationId: string; requestId: string }): Promise<void>
  review(input: {
    conversationId: string
    taskRef: string
    operationId: string
    versionId: string
    decision: "approve" | "reject"
    comment: string | null
  }): Promise<void>
  retryRevision(input: {
    conversationId: string
    taskRef: string
    actionId: string
    operationId: string
  }): Promise<void>
  cancel(input: { conversationId: string; requestId: string }): Promise<void>
}
