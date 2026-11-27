import type { DesignSystemInfo } from "./design-system"
import type { DesignTemplatePackage } from "./design-template"

export const DESIGN_MARKET_CATEGORIES = ["企业应用", "移动端", "数据展示", "通用"] as const
export type DesignMarketCategory = (typeof DESIGN_MARKET_CATEGORIES)[number]

export const DESIGN_MARKET_SCENARIOS = ["列表", "表单", "流程", "看板", "详情", "通用"] as const
export type DesignMarketScenario = (typeof DESIGN_MARKET_SCENARIOS)[number]

export const DESIGN_MARKET_SYSTEM_MAX_BYTES = 1024 * 1024
export const DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES = 120 * 1024 * 1024
export const DESIGN_MARKET_COVER_MAX_BYTES = 2 * 1024 * 1024
export const DESIGN_MARKET_DOWNLOAD_PROGRESS = "design-market:download-progress"

export type MarketSystemPalette = [string, string, string, string]
export type MarketAssetStatus = "published" | "unpublished" | "admin_removed"
export type MarketTemplateVisibility = "visible" | "hidden_by_system_owner"
export type MarketTemplateEffectiveStatus =
  | "published"
  | "unpublished"
  | "parent_unpublished"
  | "hidden_by_system_owner"
  | "admin_removed"

export interface DesignMarketActor {
  userId: string
  userName: string
  orgName?: string
  isAdmin?: boolean
  rawIds?: string[]
}

/**
 * Normalizes 6-digit ystId and 80-prefixed 8-digit sapId aliases as well as
 * "id / name / org" format into one canonical primary account ID.
 */
export function normalizeMarketAccountId(rawUserId?: string | null): string {
  const trimmed = String(rawUserId || "").trim()
  if (!trimmed) return ""
  const primarySegment = trimmed.replace(/／/g, "/").split("/")[0]?.trim() || ""
  if (!primarySegment) return ""
  const sap80 = /^80(\d{6})$/.exec(primarySegment)
  if (sap80) return sap80[1]
  return primarySegment
}

export interface MarketVersionRecord {
  versionId: string
  version: string
  changelog: string
  createdAt: string
  createdById: string
  createdByName: string
  bytes: number
  sha256: string
}

export interface MarketSystemVersionRecord extends MarketVersionRecord {
  markdown: string
  palette: MarketSystemPalette
}

export interface MarketTemplateVersionRecord extends MarketVersionRecord {
  minSystemVersion: string
  defaultEntryPath: string
  pages: string[]
  filesCount: number
  framework: string
  coverDataUrl: string
}

export interface MarketSystemDraft {
  name: string
  description: string
  category: DesignMarketCategory
  markdown: string
  palette: MarketSystemPalette
  version: string
  changelog: string
  revision: number
  updatedAt: string
  dirty: boolean
}

export interface MarketTemplateDraft {
  name: string
  description: string
  scenario: DesignMarketScenario
  minSystemVersion: string
  defaultEntryPath: string
  pages: string[]
  filesCount: number
  totalBytes: number
  framework: string
  packageFilename?: string
  stagedBlobSha256?: string
  coverDataUrl: string
  version: string
  changelog: string
  revision: number
  updatedAt: string
  dirty: boolean
}

export interface MarketGovernanceNotice {
  id: string
  assetKind: "system" | "template"
  assetId: string
  assetName: string
  action: "hide_template" | "restore_template" | "admin_takedown" | "admin_restore" | "parent_unpublished" | "parent_republished"
  reason: string
  actorId: string
  actorName: string
  createdAt: string
}

export interface MarketAuditRecord {
  id: string
  assetKind: "system" | "template"
  assetId: string
  action: string
  reason: string
  actorId: string
  actorName: string
  createdAt: string
}

export interface MarketSystemSummary {
  systemId: string
  name: string
  description: string
  category: DesignMarketCategory
  ownerId: string
  ownerName: string
  palette: MarketSystemPalette
  status: MarketAssetStatus
  latestVersion: string | null
  latestVersionId: string | null
  highestPublishedVersion: string | null
  templateCount: number
  updatedAt: string
  hasDraft: boolean
  canEdit: boolean
  canManageTemplates: boolean
  canModerate: boolean
  matchedTemplates?: MarketTemplateSummary[]
}

export interface MarketTemplateSummary {
  templateId: string
  systemId: string
  systemName: string
  name: string
  description: string
  scenario: DesignMarketScenario
  ownerId: string
  ownerName: string
  status: MarketAssetStatus
  visibility: MarketTemplateVisibility
  visibilityReason?: string
  parentStatus: MarketAssetStatus
  effectiveStatus: MarketTemplateEffectiveStatus
  latestVersion: string | null
  latestVersionId: string | null
  highestPublishedVersion: string | null
  minSystemVersion: string
  defaultEntryPath: string
  pages: string[]
  framework: string
  totalBytes: number
  coverDataUrl: string
  updatedAt: string
  hasDraft: boolean
  canEdit: boolean
  canSystemOwnerManage: boolean
  canModerate: boolean
}

export interface MarketSystemDetail {
  system: MarketSystemSummary
  markdown: string
  versions: MarketSystemVersionRecord[]
  templates: MarketTemplateSummary[]
  draft: MarketSystemDraft | null
  notices: MarketGovernanceNotice[]
}

export interface MarketTemplateDetail {
  template: MarketTemplateSummary
  system: MarketSystemSummary
  versions: MarketTemplateVersionRecord[]
  draft: MarketTemplateDraft | null
  notices: MarketGovernanceNotice[]
}

export interface MarketCatalogQuery {
  query?: string
  category?: DesignMarketCategory | "全部"
  sort?: "recent"
}

export interface MarketCatalogResponse {
  actor: DesignMarketActor | null
  online: boolean
  offlineReason?: string
  categories: readonly DesignMarketCategory[]
  scenarios: readonly DesignMarketScenario[]
  categoryCounts: Record<string, number>
  systems: MarketSystemSummary[]
}

export interface MarketMyUploadsResponse {
  actor: DesignMarketActor | null
  systems: MarketSystemSummary[]
  templates: MarketTemplateSummary[]
  notices: MarketGovernanceNotice[]
}

export interface MarketCreateSystemDraftInput {
  name?: string
  description?: string
  category?: DesignMarketCategory
  markdown: string
  palette?: MarketSystemPalette
  version?: string
  changelog?: string
}

export interface MarketSaveSystemDraftInput {
  systemId: string
  expectedRevision: number
  name: string
  description: string
  category: DesignMarketCategory
  markdown: string
  palette: MarketSystemPalette
  version: string
  changelog: string
}

export interface MarketPublishSystemInput {
  systemId: string
  expectedRevision: number
  version?: string
  changelog?: string
}

export interface MarketStagedPackageInfo {
  stagedBlobSha256: string
  packageFilename: string
  pages: string[]
  defaultEntryPath: string
  filesCount: number
  totalBytes: number
  framework: string
  coverDataUrl: string
  warnings: string[]
}

export interface MarketCreateTemplateDraftInput {
  systemId: string
  name: string
  description: string
  scenario: DesignMarketScenario
  minSystemVersion: string
  defaultEntryPath: string
  pages: string[]
  filesCount: number
  totalBytes: number
  framework: string
  packageFilename?: string
  stagedBlobSha256: string
  coverDataUrl: string
  version?: string
  changelog?: string
}

export interface MarketSaveTemplateDraftInput {
  templateId: string
  expectedRevision: number
  name: string
  description: string
  scenario: DesignMarketScenario
  minSystemVersion: string
  defaultEntryPath: string
  pages: string[]
  filesCount: number
  totalBytes: number
  framework: string
  packageFilename?: string
  stagedBlobSha256?: string
  coverDataUrl: string
  version: string
  changelog: string
}

export interface MarketPublishTemplateInput {
  templateId: string
  expectedRevision: number
  version?: string
  changelog?: string
}

export interface LocalMarketSystemEntry {
  localId: string
  systemId: string
  versionId: string
  version: string
  name: string
  description: string
  category: DesignMarketCategory
  ownerId: string
  ownerName: string
  palette: MarketSystemPalette
  markdownPath: string
  downloadedAt: string
  sha256: string
  bytes: number
  removedFromPicker: boolean
  latestMarketVersion?: string | null
  updateAvailable?: boolean
  marketStatus?: MarketAssetStatus
}

export interface LocalMarketTemplateEntry {
  localId: string
  templateId: string
  systemId: string
  systemName: string
  versionId: string
  version: string
  minSystemVersion: string
  name: string
  description: string
  scenario: DesignMarketScenario
  ownerId: string
  ownerName: string
  defaultEntryPath: string
  pages: string[]
  files: string[]
  totalBytes: number
  framework: string
  coverDataUrl: string
  rootDir: string
  downloadedAt: string
  sha256: string
  removedFromPicker: boolean
  missingCompatibleSystem: boolean
  compatibleSystemVersion?: string | null
  latestMarketVersion?: string | null
  updateAvailable?: boolean
  effectiveStatus?: MarketTemplateEffectiveStatus
}

export interface LocalMarketAssetsState {
  systems: LocalMarketSystemEntry[]
  templates: LocalMarketTemplateEntry[]
}

export interface DesignMarketDownloadProgress {
  downloadKey: string
  kind: "system" | "template"
  assetId: string
  versionId: string
  phase: "resolving" | "downloading" | "verifying" | "committing" | "done" | "error" | "canceled"
  receivedBytes: number
  totalBytes: number
  message: string
  error?: string
}

export interface DesignMarketDownloadPlan {
  kind: "system" | "template"
  assetId: string
  versionId: string
  compatible: boolean
  willDownloadSystem: boolean
  reusedSystemVersion?: string | null
  systemToDownload?: {
    systemId: string
    name: string
    versionId: string
    version: string
    bytes: number
  } | null
  missingReason?: string
}

export interface DesignMarketDownloadResult {
  success: boolean
  canceled?: boolean
  error?: string
  system?: LocalMarketSystemEntry
  template?: LocalMarketTemplateEntry
  alsoDownloadedSystem?: LocalMarketSystemEntry
  reusedExisting?: boolean
}

export interface DesignMarketActionResult<T = void> {
  success: boolean
  data?: T
  error?: string
  code?: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "OFFLINE"
  conflictRevision?: number
}

export interface DesignMarketApi {
  getActor: () => Promise<DesignMarketActor | null>
  listCatalog: (query?: MarketCatalogQuery) => Promise<MarketCatalogResponse>
  getSystemDetail: (systemId: string) => Promise<DesignMarketActionResult<MarketSystemDetail>>
  getTemplateDetail: (templateId: string) => Promise<DesignMarketActionResult<MarketTemplateDetail>>
  listMyUploads: () => Promise<DesignMarketActionResult<MarketMyUploadsResponse>>
  listDownloaded: () => Promise<LocalMarketAssetsState>
  extractPalette: (markdown: string) => Promise<MarketSystemPalette>
  pickSystemMarkdownFile: () => Promise<DesignMarketActionResult<{ name: string; markdown: string; palette: MarketSystemPalette }>>
  createSystemDraft: (input: MarketCreateSystemDraftInput) => Promise<DesignMarketActionResult<MarketSystemDetail>>
  createSystemDraftFromLocal: (localSystemId: string) => Promise<DesignMarketActionResult<MarketSystemDetail>>
  saveSystemDraft: (input: MarketSaveSystemDraftInput) => Promise<DesignMarketActionResult<MarketSystemDetail>>
  discardSystemDraft: (systemId: string) => Promise<DesignMarketActionResult<MarketSystemDetail>>
  publishSystem: (input: MarketPublishSystemInput) => Promise<DesignMarketActionResult<MarketSystemDetail>>
  setSystemStatus: (
    systemId: string,
    status: "published" | "unpublished"
  ) => Promise<DesignMarketActionResult<{ detail: MarketSystemDetail; affectedTemplateCount: number }>>
  pickAndStageTemplatePackage: (
    source: "file" | "directory"
  ) => Promise<DesignMarketActionResult<MarketStagedPackageInfo> & { canceled?: boolean }>
  stageLocalTemplatePackage: (
    reference: { id: string; entryPath: string }
  ) => Promise<DesignMarketActionResult<MarketStagedPackageInfo>>
  pickManualCoverImage: () => Promise<DesignMarketActionResult<{ coverDataUrl: string }> & { canceled?: boolean }>
  createTemplateDraft: (input: MarketCreateTemplateDraftInput) => Promise<DesignMarketActionResult<MarketTemplateDetail>>
  saveTemplateDraft: (input: MarketSaveTemplateDraftInput) => Promise<DesignMarketActionResult<MarketTemplateDetail>>
  discardTemplateDraft: (templateId: string) => Promise<DesignMarketActionResult<MarketTemplateDetail>>
  publishTemplate: (input: MarketPublishTemplateInput) => Promise<DesignMarketActionResult<MarketTemplateDetail>>
  setTemplateStatus: (
    templateId: string,
    status: "published" | "unpublished"
  ) => Promise<DesignMarketActionResult<MarketTemplateDetail>>
  setTemplateVisibilityBySystemOwner: (
    templateId: string,
    visibility: MarketTemplateVisibility,
    reason?: string
  ) => Promise<DesignMarketActionResult<MarketTemplateDetail>>
  adminTakedown: (
    kind: "system" | "template",
    assetId: string,
    reason: string
  ) => Promise<DesignMarketActionResult<void>>
  adminRestore: (
    kind: "system" | "template",
    assetId: string,
    reason: string
  ) => Promise<DesignMarketActionResult<void>>
  planDownload: (
    kind: "system" | "template",
    assetId: string,
    versionId?: string,
    selectedLocalSystemId?: string | null
  ) => Promise<DesignMarketActionResult<DesignMarketDownloadPlan>>
  downloadSystem: (systemId: string, versionId?: string) => Promise<DesignMarketDownloadResult>
  downloadTemplate: (
    templateId: string,
    versionId?: string,
    selectedLocalSystemId?: string | null
  ) => Promise<DesignMarketDownloadResult>
  cancelDownload: (downloadKey: string) => Promise<boolean>
  countAffectedTemplatesForSystemRemoval: (localSystemId: string) => Promise<number>
  removeSystemFromPicker: (localSystemId: string) => Promise<LocalMarketAssetsState>
  restoreSystemToPicker: (localSystemId: string) => Promise<LocalMarketAssetsState>
  removeTemplateFromPicker: (localTemplateId: string) => Promise<LocalMarketAssetsState>
  restoreTemplateToPicker: (localTemplateId: string) => Promise<LocalMarketAssetsState>
  copySystemToLocal: (localSystemId: string) => Promise<DesignMarketActionResult<DesignSystemInfo>>
  copyTemplateToLocal: (localTemplateId: string) => Promise<DesignMarketActionResult<DesignTemplatePackage>>
  previewDownloadedTemplate: (localTemplateId: string, entryPath?: string) => Promise<DesignMarketActionResult<{ previewUrl: string; pages: string[]; entryPath: string }>>
  onDownloadProgress: (callback: (event: DesignMarketDownloadProgress) => void) => () => void
}
