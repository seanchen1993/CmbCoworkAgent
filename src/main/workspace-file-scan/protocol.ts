import type { WorkspaceFileScanEntry } from "../../shared/workspace-file-scan"

export type WorkspaceFileScanWorkerRequest =
  | {
      type: "open"
      requestId: number
      scanId: string
      workspacePath: string
      cancellationBuffer: SharedArrayBuffer
    }
  | {
      type: "next"
      requestId: number
      scanId: string
      maxEntries: number
      maxBytes: number
      continuation?: string
    }
  | { type: "cancel"; scanId: string }
  | { type: "shutdown" }

export type WorkspaceFileScanWorkerResponse =
  | { type: "open-result"; requestId: number; ok: true }
  | {
      type: "next-result"
      requestId: number
      ok: true
      files: WorkspaceFileScanEntry[]
      done: boolean
      truncated: boolean
      continuation?: string
    }
  | {
      type: "open-result" | "next-result"
      requestId: number
      ok: false
      error: { code: string; message: string; stack?: string }
    }
  | { type: "shutdown-complete" }

export const WORKSPACE_FILE_SCAN_CANCELLED = "WORKSPACE_FILE_SCAN_CANCELLED"
