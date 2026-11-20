export type MemoryCatalogScope = "global" | "project"

export type MemoryCatalogFileType = "user" | "feedback" | "project" | "reference"

export interface MemoryCatalogFile {
  name: string
  size: number
  modifiedAt: string
  type: MemoryCatalogFileType | null
  displayName: string | null
  description: string | null
  recallCount: number
}

export interface MemoryCatalogProject {
  projectId: string
  displayName: string
  memoryDir: string
  gitRoot?: string
  fileCount: number
  totalSize: number
  indexSize: number
  isCurrent: boolean
}

export interface MemoryCatalogDreamState {
  lastRunAt: number
  sessionsSinceLastRun: number
}

export interface MemoryCatalogStats {
  fileCount: number
  totalSize: number
  indexSize: number
  enabled: boolean
  dreamEnabled: boolean
  dreamState: MemoryCatalogDreamState
  scope: MemoryCatalogScope
  memoryDir: string
  projectId?: string
  gitRoot?: string
}

export interface MemoryCatalogScanStats {
  scannedEntries: number
  scannedFiles: number
  readBytes: number
}

export interface MemoryCatalogPageBase {
  nextCursor?: string
  hasMore: boolean
  totalCount: number
  truncated: boolean
  truncatedReasons: string[]
  scanStats: MemoryCatalogScanStats
}

export interface MemoryProjectsPage extends MemoryCatalogPageBase {
  items: MemoryCatalogProject[]
}

export interface MemoryFilesPage extends MemoryCatalogPageBase {
  items: MemoryCatalogFile[]
  stats: MemoryCatalogStats
}

export interface MemoryFileContent {
  content: string
  bytesRead: number
  totalBytes: number
  truncated: boolean
  truncatedReason?: "response-bytes" | "file-size"
}

export interface MemoryPageRequest {
  requestScope?: string
  cursor?: string
  limit?: number
}

export interface MemoryProjectsPageRequest extends MemoryPageRequest {
  workspacePath?: string | null
}

export interface MemoryFilesPageRequest extends MemoryPageRequest {
  scope?: MemoryCatalogScope
  workspacePath?: string | null
  projectId?: string | null
}
