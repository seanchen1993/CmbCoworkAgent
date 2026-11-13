import type { RequirementRecord, RequirementUser } from "./requirement-data"

export type RequirementSourceFilter = "all" | "local" | "remote" | "space"

function normalizeUserIdentity(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export function isRequirementMine(
  requirement: RequirementRecord,
  currentUser: RequirementUser | null
): boolean {
  if (requirement.origin === "local") return true
  if (!currentUser || !requirement.owner) return false
  const currentIdentities = new Set(
    [currentUser.id, currentUser.name].map(normalizeUserIdentity).filter(Boolean)
  )
  return [requirement.owner.id, requirement.owner.name]
    .map(normalizeUserIdentity)
    .some((identity) => Boolean(identity) && currentIdentities.has(identity))
}

export function filterRequirementsBySystem(
  requirements: RequirementRecord[],
  systemId: string | null
): RequirementRecord[] {
  if (!systemId) return requirements
  return requirements.filter((item) => item.systemId === systemId)
}

export function filterRequirements(
  requirements: RequirementRecord[],
  options: {
    currentUser: RequirementUser | null
    mineOnly: boolean
    query: string
    sourceFilter: RequirementSourceFilter
    systemId: string | null
  }
): RequirementRecord[] {
  const normalized = options.query.trim().toLocaleLowerCase()
  return requirements.filter((item) => {
    if (item.origin === "local" && options.systemId && item.systemId !== options.systemId)
      return false
    if (options.sourceFilter !== "all" && item.origin !== options.sourceFilter) return false
    if (options.mineOnly && !isRequirementMine(item, options.currentUser)) return false
    if (!normalized) return true
    return [
      item.id,
      item.title,
      item.system,
      item.sourceName,
      item.initialDescription,
      item.status,
      item.owner?.name,
      ...(item.collaborators ?? []).map((user) => user.name)
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized)
  })
}
