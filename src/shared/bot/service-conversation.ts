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
  taskRef: string
  taskNumber: string | null
  title: string
  status: ServiceRequestStatus
}
export interface ServiceRequestView {
  requestId: string
  taskRef: string
  text: string
  status: ServiceRequestStatus
  notice: string | null
  runId: string | null
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
  items: T[]
  nextCursor: string | null
}
export interface ServiceConversationApi {
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
  cancel(input: { conversationId: string; requestId: string }): Promise<void>
}
