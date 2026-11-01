import type { AuthoringScope } from "./authoring"

export interface ProjectPromptDraftIdentity {
  id: string
  name: string
  revision: number
  sourceDigest: string
}

export interface ProjectStagePrompt {
  id: string
  title: string
  description?: string
  skillPath: string
  inputs: string[]
  outputs: { id: string; path: string }[]
  checks: string[]
  body: string
  editable: boolean
  diagnostic?: string
}

export interface ProjectPromptDraftList {
  threadId: string
  workspace: string
  drafts: ProjectPromptDraftIdentity[]
}

export interface ProjectStagePromptsView {
  threadId: string
  workspace: string
  draft: ProjectPromptDraftIdentity
  stages: ProjectStagePrompt[]
  diagnostic?: string
}

export type SaveProjectStagePromptInput = AuthoringScope & {
  id: string
  revision: number
  sourceDigest: string
  stageId: string
  body: string
}

export interface ProjectStagePromptsApi {
  listProjectPromptDrafts(input: AuthoringScope): Promise<ProjectPromptDraftList>
  readProjectStagePrompts(input: AuthoringScope & { id: string }): Promise<ProjectStagePromptsView>
  saveProjectStagePrompt(input: SaveProjectStagePromptInput): Promise<ProjectStagePromptsView>
}
