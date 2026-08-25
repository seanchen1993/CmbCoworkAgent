export interface WorkspaceFileScanEntry {
  path: string
  is_dir: boolean
  size?: number
  modified_at?: string
}

export interface WorkspaceFileScanOpenResult {
  success: boolean
  scanId?: string
  workspacePath?: string
  ordered?: boolean
  error?: string
}

export interface WorkspaceFileScanPageResult {
  success: boolean
  files: WorkspaceFileScanEntry[]
  done: boolean
  truncated?: boolean
  continuation?: string
  workspacePath?: string
  error?: string
}

export const WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES = 128
export const WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES = 96 * 1024
export const WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES = 10_000
export const WORKSPACE_FILE_SCAN_SEGMENT_MAX_BYTES = 8 * 1024 * 1024
export const WORKSPACE_FILE_SCAN_SEGMENT_MAX_DIRECTORIES = 2_000
export const WORKSPACE_FILE_SCAN_SEGMENT_MAX_ACTIVE_MS = 5_000
export const WORKSPACE_GITIGNORE_MAX_BYTES = 256 * 1024
export const WORKSPACE_GITIGNORE_MAX_RULES = 2_048
