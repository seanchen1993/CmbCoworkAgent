import { BadgeCheck, FileText, type LucideIcon } from "lucide-react"

export type RequirementSessionCapabilityItem = {
  id: string
  label: string
  icon: LucideIcon
}

export const REQUIREMENT_BOUND_EXPERTS: RequirementSessionCapabilityItem[] = [
  {
    id: "analyst",
    label: "需求分析师",
    icon: BadgeCheck
  }
]

export const REQUIREMENT_BOUND_SKILLS: RequirementSessionCapabilityItem[] = [
  {
    id: "requirement-to-prd",
    label: "需求文档3.0标准化",
    icon: FileText
  }
]

export const REQUIREMENT_WORKBENCH_SKILL_ID = "requirement-workbench"

export type RequirementSessionCapabilities = {
  experts: string[]
  skills: string[]
}

export function getRequirementSessionCapabilities(): RequirementSessionCapabilities {
  return {
    experts: REQUIREMENT_BOUND_EXPERTS.map((item) => item.id),
    skills: [
      ...REQUIREMENT_BOUND_SKILLS.map((item) => item.id),
      REQUIREMENT_WORKBENCH_SKILL_ID
    ]
  }
}

export async function enableRequirementSessionExperts(experts: readonly string[]): Promise<void> {
  await Promise.all(experts.map((name) => window.api.expertAgents.setEnabled(name, true)))
}

export async function enableRequirementSessionSkills(skills: readonly string[]): Promise<void> {
  await Promise.all(skills.map((skillId) => window.api.skills.setDisabledState(skillId, false)))
}
