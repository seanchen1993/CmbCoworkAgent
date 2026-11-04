export interface ModApprovalSource {
  id: string
  modId: string
  threadId: string
}
export interface ModApprovalRequest extends ModApprovalSource {
  requestId: string
  title: string
  message: string
  detail: string
  allowLabel: string
  canViewRequest: boolean
}
export interface ModApprovalSnapshot {
  current: ModApprovalRequest | null
  queued: number
  paused: ModApprovalSource[]
}
export interface ModApprovalInboxApi {
  snapshot(): Promise<ModApprovalSnapshot>
  decide(input: { requestId: string; decision: "allow" | "deny" | "details" }): Promise<void>
  resume(sourceId: string): Promise<void>
  onChanged(callback: () => void): () => void
}
