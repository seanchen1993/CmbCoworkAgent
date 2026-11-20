import type {
  MemoryFileContent,
  MemoryFilesPage,
  MemoryProjectsPage
} from "../../shared/memory-catalog"

export const MEMORY_CATALOG_DEFAULT_PAGE_SIZE = 128
export const MEMORY_CATALOG_MAX_PAGE_SIZE = 128
export const MEMORY_CATALOG_MAX_RESPONSE_BYTES = 512 * 1024
export const MEMORY_CATALOG_MAX_FILE_CONTENT_BYTES = 480 * 1024
export const MEMORY_CATALOG_MAX_FILE_SIZE = 2 * 1024 * 1024
export const MEMORY_CATALOG_MAX_INDEX_BYTES = 16 * 1024 * 1024
export const MEMORY_CATALOG_MAX_FRONTMATTER_BYTES = 4 * 1024
export const MEMORY_CATALOG_MAX_METADATA_BYTES = 16 * 1024
export const MEMORY_CATALOG_MAX_TOTAL_READ_BYTES = 32 * 1024 * 1024
export const MEMORY_CATALOG_MAX_ENTRIES = 50_000
export const MEMORY_CATALOG_MAX_FILES = 30_000
export const MEMORY_CATALOG_MAX_ITEMS = 20_000

export interface MemoryCatalogSource {
  memoryRootDir: string
  globalMemoryDir: string
  projectsMemoryDir: string
  memorySettingsPath: string
}

export interface MemoryCatalogCurrentProject {
  projectId: string
  gitRoot: string
  memoryDir: string
}

export interface MemoryCatalogProjectsInput {
  kind: "projects"
  cursor?: string
  limit?: number
  currentProject?: MemoryCatalogCurrentProject
}

export interface MemoryCatalogFilesInput {
  kind: "files"
  cursor?: string
  limit?: number
  scope: "global" | "project"
  memoryDir: string
  projectId?: string
  gitRoot?: string
}

export interface MemoryCatalogReadFileInput {
  kind: "file"
  memoryDir: string
  name: string
}

export type MemoryCatalogInput =
  | MemoryCatalogProjectsInput
  | MemoryCatalogFilesInput
  | MemoryCatalogReadFileInput

export type MemoryCatalogResult = MemoryProjectsPage | MemoryFilesPage | MemoryFileContent

export interface MemoryCatalogReadRequest {
  type: "read"
  requestId: number
  input: MemoryCatalogInput
  source: MemoryCatalogSource
  cancelBuffer: SharedArrayBuffer
}

export interface MemoryCatalogShutdownRequest {
  type: "shutdown"
}

export type MemoryCatalogWorkerRequest =
  | MemoryCatalogReadRequest
  | MemoryCatalogShutdownRequest

export interface MemoryCatalogReadSuccess {
  type: "read-result"
  requestId: number
  ok: true
  result: MemoryCatalogResult
}

export interface MemoryCatalogReadFailure {
  type: "read-result"
  requestId: number
  ok: false
  error: { code: string; message: string; stack?: string }
}

export interface MemoryCatalogShutdownComplete {
  type: "shutdown-complete"
}

export type MemoryCatalogWorkerResponse =
  | MemoryCatalogReadSuccess
  | MemoryCatalogReadFailure
  | MemoryCatalogShutdownComplete

export const MEMORY_CATALOG_CANCELLED = "MEMORY_CATALOG_CANCELLED"
export const MEMORY_CATALOG_CURSOR_EXPIRED = "MEMORY_CATALOG_CURSOR_EXPIRED"
