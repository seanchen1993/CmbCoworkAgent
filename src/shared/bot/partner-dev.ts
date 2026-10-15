/** Redacted, fixed local-development IPC surface. Never carries credentials. */
import type { GroupMemorySnapshot } from "./group-memory"
import type { ExpertMemoryList, ExpertMemorySnapshot, ExpertMemoryUpdate } from "./expert-memory"
export interface PartnerDevStatus {
  connectionMode?: "local-default"
  expertName?: string | null
  expertDataPath?: string | null
  expertMemoryAdopted?: boolean
  canManageExpertMemory?: boolean
  configured: boolean
  connected: boolean
  nodeEnabled: boolean
  model: "simulated"
  url: string | null
  spaceId: string | null
  nodeId: string | null
  ownerPrincipalId: string | null
  businessPrincipalId: string | null
  workspacePath: string | null
  groupId: string | null
  botId: string | null
  lastError: string | null
  activeRunId: string | null
  lastRunId: string | null
  lastTaskNumber: string | null
}
export interface PartnerDevMessageReply {
  kind: "ignored" | "clarify" | "task"
  notice: string
  taskId?: string
  taskNumber?: string
  taskVersion?: number
  runId?: string
  runStatus?: string
}
export interface PartnerDevRunView {
  runId: string
  status: string
  version: number
  result: { outcome: "succeeded" | "failed"; text: string; settledAt: string } | null
  memorySnapshot?: GroupMemorySnapshot | ExpertMemorySnapshot | null
}
export interface PartnerDevApi {
  getStatus(): Promise<PartnerDevStatus>
  importConnection(): Promise<PartnerDevStatus>
  chooseWorkspace(): Promise<PartnerDevStatus>
  connect(): Promise<PartnerDevStatus>
  disconnect(): Promise<PartnerDevStatus>
  stopNode(): Promise<PartnerDevStatus>
  createExpert(input: { name: string; instructions: string }): Promise<PartnerDevStatus>
  startExpert(): Promise<PartnerDevStatus>
  listExpertMemories(): Promise<ExpertMemoryList>
  createExpertMemory(input: { text: string }): Promise<ExpertMemoryList>
  updateExpertMemory(input: ExpertMemoryUpdate): Promise<ExpertMemoryList>
  disableExpertMemory(input: {
    memoryId: string
    expectedVersion: number
  }): Promise<ExpertMemoryList>
  revokeLocalAuthorization(): Promise<PartnerDevStatus>
  sendMessage(input: { mentioned: boolean; text: string }): Promise<PartnerDevMessageReply>
  analyzeTask(input: { taskNumber: string }): Promise<PartnerDevMessageReply>
  inspectRun(input: { runId: string }): Promise<PartnerDevRunView>
  cancelPending(input: { runId: string; expectedVersion: number }): Promise<PartnerDevRunView>
}
