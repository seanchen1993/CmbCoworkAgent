/** Explicit, local project deliverables. Never a stage transition or automatic upload. */
export interface ProjectLibraryEntry {
  id: string
  projectId: string
  operationId: string
  stageId: string
  title: string
  note: string
  kind: "knowledge" | "delivery"
  createdAt: number
  files: Array<{
    path: string
    sha256: string
    size: number
    status: "pending" | "uploaded" | "failed" | "unknown"
  }>
  endpoint?: string
  remotePath?: string
  status: "saved" | "sending" | "partial" | "sent" | "unknown"
  error?: string
  catalogStatus?: "uploaded" | "failed" | "unknown"
  source?: { projectId: string; entryId: string }
}

export interface ProjectLibraryApi {
  list(projectId: string): Promise<ProjectLibraryEntry[]>
  capture(
    projectId: string,
    input: {
      operationId: string
      kind: "knowledge" | "delivery"
      title: string
      note: string
    }
  ): Promise<ProjectLibraryEntry>
  read(projectId: string, id: string, path: string): Promise<{ text: string; truncated: boolean }>
  send(
    projectId: string,
    id: string,
    input: { endpoint: string; remotePath: string }
  ): Promise<ProjectLibraryEntry>
  remove(projectId: string, id: string): Promise<void>
  reuse(sourceProjectId: string, id: string, targetProjectId: string): Promise<ProjectLibraryEntry>
}
