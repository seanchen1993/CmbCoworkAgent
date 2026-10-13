import type { GroupMemory, GroupMemoryList } from "../../src/shared/bot/group-memory"
export function memoryFixture(patch: Partial<GroupMemory> = {}): GroupMemory {
  return {
    id: "memory-a",
    spaceId: "A",
    groupId: "group",
    version: 1,
    text: "交易查询仅提供T+1数据",
    status: "active",
    source: { kind: "manual" },
    createdBy: "owner",
    updatedBy: "owner",
    createdAt: "2026-10-12T08:00:00Z",
    updatedAt: "2026-10-12T08:00:00Z",
    ...patch
  }
}
export function memoryListFixture(): GroupMemoryList {
  return {
    revision: 1,
    memories: [memoryFixture()],
    botPolicies: [{ botId: "expert", botVersionId: "expert-v1", memoryPolicy: "explicit_only" }],
    canManage: true
  }
}
