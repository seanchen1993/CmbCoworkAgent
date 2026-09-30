import type { RequirementRecord } from "./requirement-data"

export function filterRequirementsBySystem(
  requirements: RequirementRecord[],
  systemId: string | null
): RequirementRecord[] {
  if (!systemId) return requirements
  return requirements.filter((item) => item.systemId === systemId)
}
