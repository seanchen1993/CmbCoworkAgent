import type {
  HarnessBoardCatalogPageInput,
  HarnessBoardCatalogPageResult,
  HarnessDeployUnitMapping,
  HarnessProjectMetadata
} from "../../shared/harness-board-types"
import type { PluginMetadata } from "../types"

export const HARNESS_CATALOG_DEFAULT_PAGE_SIZE = 24
export const HARNESS_CATALOG_MAX_PAGE_SIZE = 64
export const HARNESS_CATALOG_MAX_RESPONSE_BYTES = 512 * 1024
export const HARNESS_PROJECT_CONTEXT_MAX_PROJECTS = 8
export const HARNESS_DIALOG_TIPS_MAX_RESPONSE_BYTES = 64 * 1024
export const HARNESS_LEAN_TOKEN_MAX_RESPONSE_BYTES = 16 * 1024

export interface HarnessProjectContextConfigSnapshot {
  value: Record<string, unknown> | null
  error: string | null
}

export interface HarnessProjectContextItem {
  project: HarnessProjectMetadata
  plugin: PluginMetadata | null
  configSnapshot: HarnessProjectContextConfigSnapshot | null
  projectDirectoryExists: boolean
  selectedDeployUnits?: HarnessDeployUnitMapping[]
  leanToken?: string
}

export interface HarnessProjectContextReadOptions {
  featureSlug?: string
}

export interface HarnessProjectContextResult {
  projects: Record<string, HarnessProjectContextItem | null>
  stats: {
    durationMs: number
    responseBytes: number
    projectRows: number
    cancelled: boolean
  }
}

export interface HarnessDialogTipsResult {
  tips: string | null
  stats: {
    durationMs: number
    responseBytes: number
    cancelled: boolean
  }
}

export interface HarnessLeanTokenResult {
  leanToken: string
  stats: {
    durationMs: number
    responseBytes: number
    cancelled: boolean
  }
}

export interface HarnessCatalogReadRequest {
  type: "read-page"
  requestId: number
  projectStorePath: string
  pluginStorePath: string
  input: HarnessBoardCatalogPageInput
  maxResponseBytes: number
  cancelBuffer: SharedArrayBuffer
}

export interface HarnessProjectContextReadRequest {
  type: "read-project-contexts"
  requestId: number
  projectStorePath: string
  pluginStorePath: string
  leanTokenStorePath: string
  projectIds: string[]
  featureSlug?: string
  featureBindingStorePath?: string
  deployUnitMappingStorePath?: string
  maxResponseBytes: number
  cancelBuffer: SharedArrayBuffer
}

export interface HarnessDialogTipsReadRequest {
  type: "read-dialog-tips"
  requestId: number
  projectStorePath: string
  pluginStorePath: string
  leanTokenStorePath: string
  projectId: string
  slug: string
  maxResponseBytes: number
  cancelBuffer: SharedArrayBuffer
}

export interface HarnessLeanTokenReadRequest {
  type: "read-lean-token"
  requestId: number
  leanTokenStorePath: string
  maxResponseBytes: number
  cancelBuffer: SharedArrayBuffer
}

export interface HarnessCatalogShutdownRequest {
  type: "shutdown"
}

export type HarnessCatalogWorkerRequest =
  | HarnessCatalogReadRequest
  | HarnessProjectContextReadRequest
  | HarnessDialogTipsReadRequest
  | HarnessLeanTokenReadRequest
  | HarnessCatalogShutdownRequest

export interface HarnessCatalogReadSuccess {
  type: "read-page-result"
  requestId: number
  ok: true
  result: HarnessBoardCatalogPageResult
}

export interface HarnessCatalogReadFailure {
  type: "read-page-result"
  requestId: number
  ok: false
  error: { message: string; stack?: string }
}

export interface HarnessProjectContextReadSuccess {
  type: "read-project-contexts-result"
  requestId: number
  ok: true
  result: HarnessProjectContextResult
}

export interface HarnessProjectContextReadFailure {
  type: "read-project-contexts-result"
  requestId: number
  ok: false
  error: { message: string; stack?: string }
}

export interface HarnessDialogTipsReadSuccess {
  type: "read-dialog-tips-result"
  requestId: number
  ok: true
  result: HarnessDialogTipsResult
}

export interface HarnessDialogTipsReadFailure {
  type: "read-dialog-tips-result"
  requestId: number
  ok: false
  error: { message: string; stack?: string }
}

export interface HarnessLeanTokenReadSuccess {
  type: "read-lean-token-result"
  requestId: number
  ok: true
  result: HarnessLeanTokenResult
}

export interface HarnessLeanTokenReadFailure {
  type: "read-lean-token-result"
  requestId: number
  ok: false
  error: { message: string; stack?: string }
}

export interface HarnessCatalogShutdownComplete {
  type: "shutdown-complete"
}

export type HarnessCatalogWorkerResponse =
  | HarnessCatalogReadSuccess
  | HarnessCatalogReadFailure
  | HarnessProjectContextReadSuccess
  | HarnessProjectContextReadFailure
  | HarnessDialogTipsReadSuccess
  | HarnessDialogTipsReadFailure
  | HarnessLeanTokenReadSuccess
  | HarnessLeanTokenReadFailure
  | HarnessCatalogShutdownComplete
