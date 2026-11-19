import type { KnowledgeUserDetail } from "../../shared/dashboard-knowledge-overview"
import { parseKnowledgeDistribution } from "./dashboard-knowledge-overview"

export function demoKnowledgeActiveCount(orgIds: string[] | null): number {
  return Math.round(25 * (orgIds ? Math.min(1, orgIds.length / 3) : 1))
}

export function demoKnowledgePeople(
  rooms: Map<string, string>,
  orgIds: string[] | null
): KnowledgeUserDetail[] {
  return [...rooms].flatMap(([roomName, roomId], index) => {
    if (orgIds && !orgIds.includes(roomId)) return []
    return Array.from({ length: 12 }, (_, i) => ({
      userName: `演示用户${index * 12 + i + 1}`,
      roomName,
      roomId,
      groupName: i === 11 ? null : ["应用开发组", "平台开发组"][i % 2],
      groupId: i === 11 ? null : `${roomId}-${i % 2}`,
      totalNum: 420 - (index % 3) * 40 - i * 11,
      abandonedNum: (i + index) % 5,
      recentNum: 216 - (index % 3) * 20 - i * 9,
      updateActiveNum: Math.max(0, 96 - (index % 3) * 10 - i * 7),
      readActiveNum: i % 3 === 0 ? 0 : 60 - i * 4
    }))
  })
}

export function demoKnowledgeOrgs(people: KnowledgeUserDetail[], singleRoom: boolean) {
  return parseKnowledgeDistribution(
    people.map((row) => ({
      id: singleRoom ? row.groupId : row.roomId,
      name: singleRoom ? row.groupName : row.roomName,
      value: row.totalNum
    })),
    singleRoom ? "group" : "room"
  )
}
