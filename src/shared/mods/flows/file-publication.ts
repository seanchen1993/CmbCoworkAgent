export interface FlowFileReview {
  runId: string
  runDigest: string
  reviewDigest: string
  state: "unpublished" | "published" | "unknown"
  canPublish: boolean
  changeCount: number
  limited: boolean
  changes: Array<{ path: string; kind: "add" | "replace"; bytes: number; preview: string }>
  operations: Array<{
    id: string
    kind: "reviewed-export" | "workspace-writeback"
    state: "intent" | "settled" | "unknown" | "failed"
    recoveryDirectory?: string
  }>
}
export type FlowFilePublicationRequest =
  | { kind: "review" }
  | { kind: "export"; reviewDigest: string; destination: string }
  | { kind: "publish"; reviewDigest: string }
export interface FlowFilePublicationOutcome {
  state: "exported" | "published"
  operationId: string
  reviewDigest: string
}
export interface FlowFilePublicationApi {
  flowFileReview(threadId: string, runId: string): Promise<FlowFileReview>
  flowFilePublish(input: {
    threadId: string
    runId: string
    runDigest: string
    reviewDigest: string
    requestId: string
    kind: "export" | "publish"
  }): Promise<FlowFilePublicationOutcome | null>
  flowFileCancel(threadId: string, requestId: string): Promise<void>
}
