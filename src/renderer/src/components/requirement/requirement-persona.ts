import {
  getRequirementSettings,
  updateRequirementSettings,
  type RequirementPersona
} from "@/lib/requirement-product-store"

export type { RequirementPersona }

export const REQUIREMENT_PERSONA_CHANGED_EVENT = "requirement:persona-changed"

export function readStoredRequirementPersona(): RequirementPersona | null {
  return getRequirementSettings().quickStart.persona
}

export function readSkipRequirementPersonaSelection(): boolean {
  return getRequirementSettings().quickStart.skipPersonaSelection
}

export function saveRequirementPersonaSettings(
  persona: RequirementPersona,
  skipPersonaSelection: boolean
): void {
  updateRequirementSettings((current) => ({
    ...current,
    quickStart: { persona, skipPersonaSelection }
  }))
}

export function shouldAutoOpenRequirementQuickStart(
  localRequirementCount: number,
  persona: RequirementPersona | null
): boolean {
  return localRequirementCount === 0 && persona === null
}

export function isRequirementDevelopmentUnavailable(): boolean {
  const persona = readStoredRequirementPersona()
  return persona === "business" || persona === "design"
}

export function getRequirementPersonaWelcome(persona: RequirementPersona | null): string | null {
  if (persona === "business") return "欢迎你，业务老师～"
  if (persona === "development") return "欢迎你，developer～"
  if (persona === "design") return "欢迎你，UI设计师～"
  return null
}
