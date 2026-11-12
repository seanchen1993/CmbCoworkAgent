export const DESIGN_IMPORT_PROGRESS_CHANNEL = "design:import-url-progress"

export type DesignImportStage =
  | "loading"
  | "waiting_render"
  | "needs_user_action"
  | "extracting"
  | "saving_assets"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled"

export interface DesignImportRequest {
  requestId: string
  source: "url" | "current-browser"
  url?: string
  workspacePath: string
  viewport?: { width: number; height: number }
  /** Explicitly capture a login/challenge page as the intended design. */
  allowRestrictedPage?: boolean
}

export interface DesignImportProgress {
  requestId: string
  stage: DesignImportStage
  message: string
}

export interface DesignImportWarning {
  code: string
  message: string
}

export interface DesignImportResult {
  success: boolean
  requestId: string
  status: "completed" | "needs_user_action" | "failed" | "cancelled"
  html?: string
  artifactPath?: string
  finalUrl?: string
  title?: string
  screenshotDataUrl?: string
  warnings: DesignImportWarning[]
  error?: string
}

export interface DesignUrlImportApi {
  importFromUrl: (request: DesignImportRequest | string) => Promise<DesignImportResult>
  cancelUrlImport: (requestId: string) => Promise<boolean>
  finishUrlImport: (requestId: string, keep: boolean) => Promise<boolean>
  prepareUrlImportForEditing: (
    requestId: string,
    sessionId: string
  ) => Promise<{
    success: boolean
    artifactPath?: string
    error?: string
  }>
  onUrlImportProgress: (callback: (event: DesignImportProgress) => void) => () => void
  openImportBrowser: (url: string) => Promise<{ success: boolean; error?: string }>
}
