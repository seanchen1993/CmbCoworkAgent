import type { WorkspaceFilePreviewTextResult } from "../../shared/workspace-file-preview"

export type WorkspaceFilePreviewWorkerSource =
  | { threadId: string; filePath: string }
  | { externalFullPath: string; trustedRootPath: string }

interface WorkspaceFilePreviewWorkerRequestBase {
  requestId: number
  cancellationBuffer: SharedArrayBuffer
}

export interface WorkspaceFilePreviewReadWorkerRequest
  extends WorkspaceFilePreviewWorkerRequestBase {
  type: "read-text"
  source: WorkspaceFilePreviewWorkerSource
  workspacePath?: string
  offset: number
}

export interface WorkspaceFilePreviewInspectWorkerRequest
  extends WorkspaceFilePreviewWorkerRequestBase {
  type: "inspect"
  source: WorkspaceFilePreviewWorkerSource
  workspacePath?: string
}

export interface WorkspaceFilePreviewShutdownWorkerRequest {
  type: "shutdown"
}

export type WorkspaceFilePreviewWorkerRequest =
  | WorkspaceFilePreviewReadWorkerRequest
  | WorkspaceFilePreviewInspectWorkerRequest
  | WorkspaceFilePreviewShutdownWorkerRequest

interface WorkspaceFilePreviewWorkerSuccessBase {
  requestId: number
  ok: true
}

export interface WorkspaceFilePreviewReadWorkerSuccess
  extends WorkspaceFilePreviewWorkerSuccessBase {
  type: "read-text-result"
  result: WorkspaceFilePreviewTextResult
  resolvedPath: string
}

export interface WorkspaceFilePreviewInspectWorkerSuccess
  extends WorkspaceFilePreviewWorkerSuccessBase {
  type: "inspect-result"
  resolvedPath: string
  size: number
  modified_at: string
}

export interface WorkspaceFilePreviewWorkerFailure {
  type: "read-text-result" | "inspect-result"
  requestId: number
  ok: false
  error: { code: string; message: string; stack?: string }
}

export interface WorkspaceFilePreviewShutdownComplete {
  type: "shutdown-complete"
}

export type WorkspaceFilePreviewWorkerResponse =
  | WorkspaceFilePreviewReadWorkerSuccess
  | WorkspaceFilePreviewInspectWorkerSuccess
  | WorkspaceFilePreviewWorkerFailure
  | WorkspaceFilePreviewShutdownComplete
