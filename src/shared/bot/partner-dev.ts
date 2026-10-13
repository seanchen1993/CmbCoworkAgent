/** Redacted, fixed local-development IPC surface. Never carries credentials. */
import type {
  GroupMemoryList,
  GroupMemorySnapshot,
  GroupMemoryWrite,
  GroupMemoryUpdate
} from "./group-memory"
export interface PartnerDevStatus {
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
  memorySnapshot?: GroupMemorySnapshot | null
}
export interface PartnerDevApi {
  getStatus(): Promise<PartnerDevStatus>
  importConnection(): Promise<PartnerDevStatus>
  chooseWorkspace(): Promise<PartnerDevStatus>
  connect(): Promise<PartnerDevStatus>
  disconnect(): Promise<PartnerDevStatus>
  enableNode(): Promise<PartnerDevStatus>
  stopNode(): Promise<PartnerDevStatus>
  createTeam(input: {
    name: string
    instructions: string
    useMemory?: boolean
  }): Promise<PartnerDevStatus>
  bindTeam(input: { groupId: string }): Promise<PartnerDevStatus>
  authorizeTeam(): Promise<PartnerDevStatus>
  revokeTeam(): Promise<PartnerDevStatus>
  listMemories(): Promise<GroupMemoryList>
  createMemory(input: GroupMemoryWrite): Promise<GroupMemoryList>
  updateMemory(input: GroupMemoryUpdate): Promise<GroupMemoryList>
  disableMemory(input: { memoryId: string; expectedVersion: number }): Promise<GroupMemoryList>
  enableTeamMemory(): Promise<PartnerDevStatus>
  sendMessage(input: { mentioned: boolean; text: string }): Promise<PartnerDevMessageReply>
  analyzeTask(input: { taskNumber: string }): Promise<PartnerDevMessageReply>
  inspectRun(input: { runId: string }): Promise<PartnerDevRunView>
  cancelPending(input: { runId: string; expectedVersion: number }): Promise<PartnerDevRunView>
}
