/** An optional use of the existing prompt.section event, not a new execution protocol. */
export const CREATOR_PLANNING_SECTION = "creator.planning"
export const CREATOR_PLANNING_MAX_CHARS = 3000
export interface CreatorPlanningReference {
  pluginId: string
  name: string
  digest: string
}
export interface CreatorPlanningStatus {
  revision: number
  state: "native" | "ready" | "fallback"
  selected?: CreatorPlanningReference
  diagnostic?: string
}
export interface CreatorPlanningCatalog {
  status: CreatorPlanningStatus
  candidates: Array<CreatorPlanningReference & { state: string }>
}
export interface CreatorPlanningApi {
  planningCatalog(input: {
    threadId: string
    expectedWorkspace: string
  }): Promise<CreatorPlanningCatalog>
  selectPlanning(input: {
    threadId: string
    expectedWorkspace: string
    expectedRevision: number
    selected: CreatorPlanningReference | null
  }): Promise<CreatorPlanningCatalog>
}
