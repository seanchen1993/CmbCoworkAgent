import type { SkillPluginCatalogPage, SkillPluginCatalogPageInput } from "../types"
import type { SkillPreviewGrantRequest } from "../../shared/skill-preview"

export const SKILL_PLUGIN_CATALOG_DEFAULT_PAGE_SIZE = 128
export const SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE = 128
export const SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES = 512 * 1024
export const SKILL_PLUGIN_CATALOG_MAX_SKILL_MD_BYTES = 256 * 1024
export const SKILL_PLUGIN_CATALOG_MAX_STORE_BYTES = 8 * 1024 * 1024
export const SKILL_PLUGIN_CATALOG_MAX_DISABLED_STORE_BYTES = 2 * 1024 * 1024
export const SKILL_PLUGIN_CATALOG_MAX_TOTAL_READ_BYTES = 64 * 1024 * 1024
export const SKILL_PLUGIN_CATALOG_MAX_DIRECTORIES = 60_000
export const SKILL_PLUGIN_CATALOG_MAX_FILES = 80_000
export const SKILL_PLUGIN_CATALOG_MAX_SKILLS = 20_000
export const SKILL_PLUGIN_CATALOG_MAX_PLUGINS = 10_000
export const SKILL_PLUGIN_CATALOG_MAX_ENTRIES = 30_000

export interface SkillPluginCatalogSourceConfig {
  builtinSkillsDir: string
  customSkillsDir: string
  pluginsStorePath: string
  disabledSkillsPath: string
}

export interface SkillPluginCatalogReadRequest {
  type: "read-page"
  requestId: number
  input: SkillPluginCatalogPageInput
  source: SkillPluginCatalogSourceConfig
  cancelBuffer: SharedArrayBuffer
}

export interface SkillPluginCatalogResolvePreviewRequest {
  type: "resolve-preview"
  requestId: number
  input: SkillPreviewGrantRequest
  source: SkillPluginCatalogSourceConfig
  cancelBuffer: SharedArrayBuffer
}

export interface SkillPluginCatalogShutdownRequest {
  type: "shutdown"
}

export type SkillPluginCatalogWorkerRequest =
  | SkillPluginCatalogReadRequest
  | SkillPluginCatalogResolvePreviewRequest
  | SkillPluginCatalogShutdownRequest

export interface SkillPluginCatalogReadSuccess {
  type: "read-page-result"
  requestId: number
  ok: true
  page: SkillPluginCatalogPage
}

export interface SkillPluginCatalogReadFailure {
  type: "read-page-result" | "resolve-preview-result"
  requestId: number
  ok: false
  error: { code: string; message: string; stack?: string }
}

export interface SkillPluginCatalogResolvePreviewSuccess {
  type: "resolve-preview-result"
  requestId: number
  ok: true
  resolution: { filePath: string } | null
}

export interface SkillPluginCatalogShutdownComplete {
  type: "shutdown-complete"
}

export type SkillPluginCatalogWorkerResponse =
  | SkillPluginCatalogReadSuccess
  | SkillPluginCatalogResolvePreviewSuccess
  | SkillPluginCatalogReadFailure
  | SkillPluginCatalogShutdownComplete

export const SKILL_PLUGIN_CATALOG_CANCELLED = "SKILL_PLUGIN_CATALOG_CANCELLED"
export const SKILL_PLUGIN_CATALOG_CURSOR_EXPIRED = "SKILL_PLUGIN_CATALOG_CURSOR_EXPIRED"
