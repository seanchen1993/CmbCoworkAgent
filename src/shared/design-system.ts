export const DESIGN_SYSTEM_MAX_BYTES = 1024 * 1024
export const DESIGN_SYSTEM_EXTRACTION_PROGRESS = "design:system-extraction-progress"

export interface DesignSystemInfo {
  /** Immutable reference. A personal system gets a new ID for each revision. */
  id: string
  name: string
  description: string
  ownership?: "builtin" | "user"
  libraryId?: string
  version?: number
  isLatest?: boolean
  updatedAt?: number
  category?: string
  source?: string
  sourceUrl?: string
  origin?: string
  license?: string
  path: string
  tokens?: {
    bg: string
    surface: string
    fg: string
    muted: string
    border: string
    accent: string
  }
}

export interface DesignSystemDraft {
  name: string
  content: string
  /** Updating requires the exact revision being edited; omitted for new copies. */
  baseId?: string
  source?: "file" | "web" | "builtin-copy" | "manual"
  sourceUrl?: string
}

export interface DesignSystemResult {
  success: boolean
  system?: DesignSystemInfo
  content?: string
  draft?: DesignSystemDraft
  canceled?: boolean
  needsUserAction?: boolean
  error?: string
}

export interface DesignSystemExtractionRequest {
  requestId: string
  source: "url" | "current-browser"
  url?: string
}

export interface DesignSystemExtractionProgress {
  requestId: string
  message: string
}

export interface DesignSystemLibraryApi {
  readSystem: (id: string) => Promise<DesignSystemResult>
  saveSystem: (draft: DesignSystemDraft) => Promise<DesignSystemResult>
  selectSystemFile: () => Promise<DesignSystemResult>
  exportSystem: (content: string) => Promise<DesignSystemResult>
  extractSystem: (request: DesignSystemExtractionRequest) => Promise<DesignSystemResult>
  cancelSystemExtraction: (requestId: string) => Promise<boolean>
  onSystemExtractionProgress: (
    callback: (event: DesignSystemExtractionProgress) => void
  ) => () => void
}
