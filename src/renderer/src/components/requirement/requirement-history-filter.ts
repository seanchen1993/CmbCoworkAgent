import type { RequirementRecord, RequirementUser } from "./requirement-data"

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
