import type { HarnessRunNode } from "../../../../shared/harness-board-types"

export interface StageNodeGroup {
  key: string
  label: string
  nodes: HarnessRunNode[]
}

export interface StageGroupFilter {
  detailKey: string
  groupKey: string | null
}

export function groupStageNodes(nodes: HarnessRunNode[]): StageNodeGroup[] {
  const groups: StageNodeGroup[] = []
  const groupsByKey = new Map<string, StageNodeGroup>()
  const ungroupedNodes: HarnessRunNode[] = []
  for (const node of nodes) {
    const label = (node.group ?? "").trim()
    if (!label) {
      ungroupedNodes.push(node)
      continue
    }
    const key = `group:${label}`
    const existing = groupsByKey.get(key)
    if (existing) existing.nodes.push(node)
    else {
      const group = { key, label, nodes: [node] }
      groupsByKey.set(key, group)
      groups.push(group)
    }
  }
  if (groups.length && ungroupedNodes.length)
    groups.push({ key: "ungrouped", label: "未分组", nodes: ungroupedNodes })
  return groups
}

/** Inspecting a node never implicitly limits the complete ordered workflow. */
export function harnessStageOverview(
  nodes: HarnessRunNode[],
  groups: StageNodeGroup[],
  detailKey: string,
  filter: StageGroupFilter
): { group: StageNodeGroup | null; nodes: HarnessRunNode[] } {
  const group =
    filter.detailKey === detailKey
      ? (groups.find((item) => item.key === filter.groupKey) ?? null)
      : null
  return { group, nodes: group?.nodes ?? nodes }
}
