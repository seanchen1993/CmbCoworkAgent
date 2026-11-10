export type RequirementPersona = "business" | "design" | "development"

export const REQUIREMENT_PERSONA_STORAGE_KEY = "requirement:quick-start-persona"
export const REQUIREMENT_PERSONA_SKIP_STORAGE_KEY = "requirement:quick-start-skip-persona"
export const REQUIREMENT_PERSONA_CHANGED_EVENT = "requirement:persona-changed"

export function readStoredRequirementPersona(): RequirementPersona | null {
  const stored = localStorage.getItem(REQUIREMENT_PERSONA_STORAGE_KEY)
  return stored === "business" || stored === "design" || stored === "development" ? stored : null
}

export function shouldHideRequirementDevelopment(): boolean {
  const persona = readStoredRequirementPersona()
  return persona === "business" || persona === "design"
}

export function getRequirementPersonaWelcome(persona: RequirementPersona | null): string | null {
  if (persona === "business") return "欢迎你，业务老师～"
  if (persona === "development") return "欢迎你，developer～"
  if (persona === "design") return "欢迎你，UI设计师～"
  return null
}
