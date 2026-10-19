/** Internal service text review. Distinct from file Artifact/Approval and delivery transport. */
export interface TextDeliveryHead {
  spaceId: string
  groupId: string
  taskId: string
  botId: string
  revision: number
  versionId: string
  number: number
  status: "pending" | "changes_requested" | "invalidated" | "completed"
  reviewerPrincipalId: string
  feedbackMessageId: string | null
  updatedAt: string
}
export interface TextDeliverySummary {
  taskId: string
  taskVersion: number
  taskStatus: "active" | "awaiting_business" | "completed"
  head: TextDeliveryHead | null
  canReview: boolean
}
export interface TextDeliveryVersionSummary {
  id: string
  spaceId: string
  groupId: string
  taskId: string
  botId: string
  number: number
  sourceRunId: string
  sourceAttemptId: string
  inputTaskVersion: number
  digest: string
  sizeBytes: number
  createdAt: string
  createdBy: string
  baseVersionId: string | null
  feedbackMessageId: string | null
}
export interface TextDeliveryVersion extends TextDeliveryVersionSummary {
  text: string
}
export interface TextDeliveryDecision {
  id: string
  spaceId: string
  taskId: string
  versionId: string
  principalId: string
  decision: "approve" | "reject"
  comment: string | null
  createdAt: string
  feedbackMessageId: string | null
  taskVersion: number
}
export interface TextDeliveryReceipt {
  versionId: string
  decision: TextDeliveryDecision | null
  summary: TextDeliverySummary
}
export interface TextDeliveryDetail {
  summary: TextDeliverySummary
  version: TextDeliveryVersion
  decision: TextDeliveryDecision | null
}
export interface TextDeliveryInput {
  runId: string
  spaceId: string
  taskId: string
  taskVersion: number
  versionId: string
  number: number
  digest: string
  text: string
  feedbackMessageId: string
  feedbackText: string
  feedbackTaskVersion: number
}
export interface ServiceDeliveryActionView {
  id: string
  kind: "publish" | "approve" | "reject" | "retry"
  state: "saving" | "blocked" | "done"
  notice: string | null
  requestId: string | null
}
export interface ServiceDeliveryView {
  summary: TextDeliverySummary
  versions: TextDeliveryVersionSummary[]
  nextBefore: number | null
  actions: ServiceDeliveryActionView[]
}
