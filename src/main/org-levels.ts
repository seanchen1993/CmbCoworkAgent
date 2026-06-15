export interface OrgLevels {
  upperOrgLv0: string
  upperOrgLv1: string
  upperOrgLv2: string
  upperOrgLv3: string
}

const EMPTY_ORG_LEVELS: OrgLevels = {
  upperOrgLv0: "",
  upperOrgLv1: "",
  upperOrgLv2: "",
  upperOrgLv3: ""
}

export function deriveUpperOrgLevelsFromPath(pathName?: string): OrgLevels {
  const parts =
    typeof pathName === "string"
      ? pathName
          .split("/")
          .map((part) => part.trim())
          .filter(Boolean)
      : []
  const itDeptIndex = parts.findIndex((part) => part.includes("信息技术部"))
  if (itDeptIndex < 0) return EMPTY_ORG_LEVELS

  const lowerParts = parts.slice(itDeptIndex + 1)
  const startsWithTeam = lowerParts[0]?.includes("团队") ?? false
  if (startsWithTeam) {
    return {
      upperOrgLv0: lowerParts[2] ?? "",
      upperOrgLv1: lowerParts[1] ?? "",
      upperOrgLv2: lowerParts[0] ?? "",
      upperOrgLv3: "本部团队"
    }
  }

  return {
    upperOrgLv0: lowerParts[3] ?? "",
    upperOrgLv1: lowerParts[2] ?? "",
    upperOrgLv2: lowerParts[1] ?? "",
    upperOrgLv3: lowerParts[0] ?? ""
  }
}

export function deriveUpperOrgLv1FromPath(pathName?: string): string {
  return deriveUpperOrgLevelsFromPath(pathName).upperOrgLv1
}
