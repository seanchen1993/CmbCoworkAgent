import type { ProjectMetricGroup } from "../../shared/project-metrics"
import { DASHBOARD_UNCLASSIFIED_ORG, readOrgText } from "./dashboard-org-fields"

export function validateProjectMetricGroups(groups: ProjectMetricGroup[] | undefined): void {
  if (
    groups !== undefined &&
    (!Array.isArray(groups) ||
      groups.some(
        (group) =>
          !readOrgText(group?.roomName) ||
          readOrgText(group?.roomName) === DASHBOARD_UNCLASSIFIED_ORG ||
          !readOrgText(group?.groupName)
      ))
  )
    throw new Error("组筛选无效")
}

/** 按室约束组名，避免同名组跨室匹配。室权限由调用方用独立条件约束。 */
export function projectMetricGroupFilter(
  groups: ProjectMetricGroup[] | undefined,
  roomField: string,
  groupField: string
): Record<string, unknown> | null {
  if (!groups?.length) return null
  const byRoom = new Map<string, Set<string>>()
  for (const group of groups) {
    const room = readOrgText(group.roomName)
    if (!room || !readOrgText(group.groupName)) continue
    const names = byRoom.get(room) ?? new Set<string>()
    names.add(group.groupName)
    byRoom.set(room, names)
  }
  return {
    bool: {
      should: [...byRoom].map(([room, names]) => ({
        bool: { filter: [{ term: { [roomField]: room } }, { terms: { [groupField]: [...names] } }] }
      })),
      minimum_should_match: 1
    }
  }
}
