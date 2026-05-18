import type { MarketItem } from "@/api/market"
import type { SkillMetadata } from "@/types"

export interface WelcomeSkillBuckets {
  generalSkills: SkillMetadata[]
  programmingSkills: SkillMetadata[]
  enabledCustomSkills: SkillMetadata[]
  disabledLocalSkills: SkillMetadata[]
}

export function groupWelcomeSkills(
  skills: SkillMetadata[],
  goodSkillsData: Pick<MarketItem, "name">[],
  isLocalSkillDisabled: (skill: SkillMetadata) => boolean,
  isProgrammingSkill: (skill: SkillMetadata) => boolean
): WelcomeSkillBuckets {
  const builtInSkills = skills.filter((skill) => skill.source === "project")
  const userSkills = skills.filter((skill) => skill.source === "user")
  const enabledBuiltInSkills = builtInSkills.filter((skill) => !isLocalSkillDisabled(skill))

  const goodSkillNames = new Set(goodSkillsData.map((g) => g.name))
  const pureCustomSkills = userSkills.filter(
    (skill) => !goodSkillNames.has(skill.name) && skill.name !== "encrypt-password"
  )

  return {
    generalSkills: enabledBuiltInSkills.filter((skill) => !isProgrammingSkill(skill)),
    programmingSkills: enabledBuiltInSkills.filter(isProgrammingSkill),
    enabledCustomSkills: pureCustomSkills.filter((skill) => !isLocalSkillDisabled(skill)),
    disabledLocalSkills: pureCustomSkills.filter(isLocalSkillDisabled)
  }
}
