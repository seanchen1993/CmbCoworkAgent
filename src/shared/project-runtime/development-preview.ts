export interface ProjectPreviewDraft {
  id: string
  name: string
  revision: number
  projectId?: string
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
  list(
    threadId: string
  ): Promise<{ threadId: string; workspace: string; drafts: ProjectPreviewDraft[] }>
  create(input: {
    threadId: string
    draftId: string
    revision: number
    goal: string
  }): Promise<string>
  finish(input: { threadId: string; projectId: string }): Promise<void>
}
