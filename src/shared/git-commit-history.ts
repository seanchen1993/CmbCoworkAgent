export interface GitCommitHistoryRecord {
  id: string
  projectPath: string
  branch?: string | null
  commitSha?: string
  committedAt: string
  cardNumber: string
  commitType: string
  commitMessage: string
  fullMessage: string
}
