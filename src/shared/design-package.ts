export const DESIGN_ASSET_SCHEME = "design-asset"
export const DESIGN_ASSET_RUNTIME_PATH = "__cmb_runtime__/canvas.js"

export type DesignArtifactPackageSourceKind = "html" | "zip" | "prototype_zip"

export interface DesignArtifactPackageRef {
  version: string
  entryPath: string
  assetCount: number
  sourceKind: DesignArtifactPackageSourceKind
}

export interface DesignPackageStageResult {
  success: boolean
  canceled?: boolean
  stageId?: string
  sourceKind?: "html" | "zip"
  label?: string
  detail?: string
  pages?: string[]
  defaultEntryPath?: string
  fileCount?: number
  totalBytes?: number
  missingAssets?: string[]
  outOfScopeAssets?: string[]
  warnings?: string[]
  error?: string
}

export interface DesignPackageCommitParams {
  stageId: string
  entryPath: string
  sessionId?: string | null
  createNew: boolean
  workspacePath?: string
  designSystemId?: string | null
  preserveComposerDraft?: boolean
}

export interface DesignAssetPreviewTicket {
  url: string
  origin: string
  token: string
  previewInstanceId: string
  revision: number
}
