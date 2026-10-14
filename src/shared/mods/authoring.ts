export type AuthoringTemplateKind = "command" | "tool" | "rule" | "panel" | "flow-action"
export interface AuthoringFile {
  path: string
  text: string
}
export interface AuthoringSource {
  schemaVersion: 1
  digest: string
  files: AuthoringFile[]
}
export interface AuthoringSummary {
  id: string
  name: string
  currentRevision: number
  updatedAt: number
}
export interface AuthoringDocument extends AuthoringSummary {
  workspace: string
  revision: number
  source: AuthoringSource
  versions: { revision: number; createdAt: number; digest: string; restoredFrom?: number }[]
}
export interface AuthoringScope {
  threadId: string
  expectedWorkspace: string
}
export type AuthoringHistoryRequest = AuthoringScope & {
  id: string
  expectedRevision: number
  expectedSourceDigest: string
  acknowledgeHistoryLoss: boolean
}
export interface AuthoringApi {
  prune(input: AuthoringHistoryRequest): Promise<AuthoringDocument>
  remove(input: AuthoringHistoryRequest): Promise<void>
  list(threadId: string): Promise<{ workspace: string; drafts: AuthoringSummary[] }>
  read(input: AuthoringScope & { id: string; revision?: number }): Promise<AuthoringDocument>
  generate(
    input: AuthoringScope & {
      id: string
      name: string
      instruction: string
      kind: AuthoringTemplateKind
    }
  ): Promise<AuthoringSource>
  save(
    input: AuthoringScope & {
      id: string
      name: string
      expectedRevision: number
      files: AuthoringFile[]
    }
  ): Promise<AuthoringDocument>
  restore(
    input: AuthoringScope & { id: string; expectedRevision: number; sourceRevision: number }
  ): Promise<AuthoringDocument>
}
