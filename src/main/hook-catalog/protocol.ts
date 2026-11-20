import type { HookCatalogPage, HookCatalogPageInput } from "../types"

export const HOOK_CATALOG_DEFAULT_PAGE_SIZE = 96
export const HOOK_CATALOG_MAX_PAGE_SIZE = 256
export const HOOK_CATALOG_MAX_RESPONSE_BYTES = 512 * 1024
export const HOOK_CATALOG_MAX_FILE_BYTES = 1024 * 1024
export const HOOK_CATALOG_MAX_SKILL_MD_BYTES = 256 * 1024
export const HOOK_CATALOG_MAX_STORE_BYTES = 4 * 1024 * 1024
export const HOOK_CATALOG_MAX_TOTAL_READ_BYTES = 64 * 1024 * 1024
export const HOOK_CATALOG_MAX_DIRECTORIES = 60_000
export const HOOK_CATALOG_MAX_FILES = 80_000
export const HOOK_CATALOG_MAX_SKILLS = 20_000
export const HOOK_CATALOG_MAX_ENTRIES = 4_096
export const HOOK_CATALOG_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const HOOK_CATALOG_MAX_WORKSPACE_SNAPSHOT_BYTES = 2 * 1024 * 1024

export interface HookCatalogSourceConfig {
  openworkDir: string
  globalHooksPath: string
  pluginsStorePath: string
  disabledSkillsPath: string
  skillSourceDirs: string[]
  /** Main-process revision shared by every renderer window. */
  globalRevision: number
  workspacePath?: string
  /** Main-process revision for workspace-only hook files. */
  workspaceRevision: number
}

export interface HookCatalogReadRequest {
  type: "read-page"
  requestId: number
  input: HookCatalogPageInput
  source: HookCatalogSourceConfig
  cancelBuffer: SharedArrayBuffer
}

export interface HookCatalogShutdownRequest {
  type: "shutdown"
}

export type HookCatalogWorkerRequest = HookCatalogReadRequest | HookCatalogShutdownRequest

export interface HookCatalogReadSuccess {
  type: "read-page-result"
  requestId: number
  ok: true
  page: HookCatalogPage
}

export interface HookCatalogReadFailure {
  type: "read-page-result"
  requestId: number
  ok: false
  error: { code: string; message: string; stack?: string }
}

export interface HookCatalogShutdownComplete {
  type: "shutdown-complete"
}

export type HookCatalogWorkerResponse =
  | HookCatalogReadSuccess
  | HookCatalogReadFailure
  | HookCatalogShutdownComplete

export const HOOK_CATALOG_CANCELLED = "HOOK_CATALOG_CANCELLED"
