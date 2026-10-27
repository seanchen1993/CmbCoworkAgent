export const REQUIREMENT_DESIGN_ENTRY_KEY = "pending-requirement-design"
export const REQUIREMENT_DESIGN_NAVIGATE_EVENT = "requirement-design:navigate"

export type RequirementDesignEntry = {
  requirementId: string
  requirementName?: string
  functionName?: string
  workspacePath: string
  requirementFilePath: string
  prompt: string
  htmlId: string
}

export function openRequirementDesign(entry: RequirementDesignEntry): void {
  localStorage.setItem(REQUIREMENT_DESIGN_ENTRY_KEY, JSON.stringify(entry))
  window.dispatchEvent(new Event(REQUIREMENT_DESIGN_NAVIGATE_EVENT))
}
