export type GitBranchKind = "local" | "remote"

// Git forbids ASCII whitespace in refs but accepts Unicode spaces as part of a name.
export function trimGitBranchInput(value: string): string {
  return value.replace(/^[ \t-\r]+|[ \t-\r]+$/g, "")
}

export const GIT_BRANCH_REFRESH_EVENT = "cmb:git-branch-switched"
export interface GitBranchSwitched {
  workspacePath: string
  repositoryPath: string
  gitRoot?: string
  branch: string | null
  gitDir?: string
}

export interface GitCurrentBranchResult {
  gitRoot?: string
  isGitRepo: boolean
  branch: string | null
  isWorktree: boolean
  isInsideWorkTree?: boolean
  gitDir?: string
  isMultiRepo?: boolean
  repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
  error?: string
}

export interface GitBranchChoice {
  name: string
  kind: GitBranchKind
}

export interface GitBranchListResult {
  success: boolean
  branches: string[]
  choices: GitBranchChoice[]
  branch?: string | null
  error?: string
}

export interface GitBranchMenuCursor {
  snapshot: number
  offset: number
}

export interface GitBranchMenuPage {
  // Git refs cannot contain newlines. Each page ends on a complete ref.
  local: string
  remote: string
  next?: GitBranchMenuCursor
}

export interface GitBranchMenuResult extends GitBranchMenuPage {
  success: boolean
  branch?: string | null
  error?: string
}

export type GitBranchMutationResult = (
  | { success: true; branch: string; headChanged: boolean; warning?: string }
  | { success: false; error: string; branch?: string | null; headChanged?: boolean }
) & { gitDir?: string; gitRoot?: string }
