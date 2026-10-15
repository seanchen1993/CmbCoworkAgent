import type { GroupMemory } from "./group-memory"

export interface ExpertMemory extends Omit<GroupMemory, "groupId" | "source"> {
  botId: string
  source: { kind: "manual" }
}
export interface ExpertMemorySnapshot {
  scope: "bot"
  botId: string
  revision: number
  memories: ExpertMemory[]
}
export interface ExpertMemoryList {
  botId: string
  revision: number
  memories: ExpertMemory[]
  canManage: boolean
}
export interface ExpertMemoryReceipt {
  revision: number
  memory: ExpertMemory
}
export interface ExpertMemoryUpdate {
  memoryId: string
  expectedVersion: number
  text: string
  status: "active" | "disabled"
}
