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

export type RequirementSessionCapabilities = {
  allowedExperts: string[]
  allowedSkills: string[]
}

export function getRequirementSessionCapabilities(): RequirementSessionCapabilities {
  return {
    allowedExperts: REQUIREMENT_BOUND_EXPERTS.map((item) => item.id),
    allowedSkills: REQUIREMENT_BOUND_SKILLS.map((item) => item.id)
  }
}

export async function enableRequirementSessionExperts(
  allowedExperts: readonly string[]
): Promise<void> {
  await Promise.all(allowedExperts.map((name) => window.api.expertAgents.setEnabled(name, true)))
}
