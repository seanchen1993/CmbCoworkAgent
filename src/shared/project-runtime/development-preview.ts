import type { CreatorProjectTrialJourney } from "../mods/creator-trial-journey"

export interface ProjectPreviewDraft {
  id: string
  name: string
  revision: number
  digest?: string
  projectId?: string
  journey?: CreatorProjectTrialJourney
  recovery?: {
    projectId: string
    revision: number
    digest: string
    workspace: string
    goal: string
    projectVersion: number | null
    status: "needs-confirmation" | "draft-changed" | "missing" | "completed"
    hasUnconfirmedEffects: boolean
    /** Debug lineage is historical after restart; ordinary recovery cannot revive execution. */
    debugBranch?: boolean
  }
  development?: {
    devId: string
    workspace: string
    currentRevision: number
    currentDigest: string
    pendingRevision: number | null
    activeRuns: number
    updateState: "current" | "queued" | "blocked"
  }
}
export interface ProjectPreviewApi {
  stageDebug?: import("./stage-debug").ProjectStageDebugApi
  list(
    threadId: string
  ): Promise<{ threadId: string; workspace: string; drafts: ProjectPreviewDraft[] }>
  create(input: {
    threadId: string
    draftId: string
    revision: number
    expectedDigest?: string
    goal: string
  }): Promise<string>
  recover(input: {
    threadId: string
    draftId: string
    projectId: string
    revision: number
    expectedDigest: string
    expectedProjectVersion: number
  }): Promise<string>
  finish(input: { threadId: string; projectId: string; draftId?: string }): Promise<void>
}
