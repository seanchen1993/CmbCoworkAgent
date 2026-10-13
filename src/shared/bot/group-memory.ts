/** Private local Partner DTOs, not additions to the frozen public Bot API. */
export type GroupMemorySource =
  | { kind: "manual" }
  | { kind: "task"; taskId: string; taskVersion: number }
  | { kind: "result"; runId: string }

export interface GroupMemory {
  id: string
  spaceId: string
  groupId: string
  version: number
  text: string
  status: "active" | "disabled"
  source: GroupMemorySource
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}
export interface GroupMemorySnapshot {
  revision: number
  memories: GroupMemory[]
}
export interface GroupMemoryList extends GroupMemorySnapshot {
  botPolicies: Array<{
    botId: string
    botVersionId: string
    memoryPolicy: "disabled" | "explicit_only"
  }>
  canManage: boolean
}
export interface GroupMemoryWrite {
  text: string
  source: GroupMemorySource
}
export interface GroupMemoryUpdate extends GroupMemoryWrite {
  memoryId: string
  expectedVersion: number
  status: "active" | "disabled"
}
export interface GroupMemoryReceipt {
  revision: number
  memory: GroupMemory
}

export const GROUP_MEMORY_LIMITS = Object.freeze({
  stored: 100,
  active: 10,
  text: 512,
  encoded: 10000
})
export function groupMemorySourceRef(memory: Pick<GroupMemory, "id" | "version">): string {
  return `memory:${memory.id}:v${memory.version}`
}
/** Same ordering and escaping as the existing prompt assembler. */
export function groupMemoryEncodedLength(memories: readonly GroupMemory[]): number {
  return JSON.stringify(
    memories.map((m) => ({ scope: "group", sourceRef: groupMemorySourceRef(m), text: m.text }))
  ).replace(/[<>&`]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).length
}
