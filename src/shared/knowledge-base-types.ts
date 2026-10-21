export type KnowledgeBaseVisibility = "visible" | "unavailable"
export type KnowledgeWorkspaceRole = "read" | "write"
export type KnowledgeWorkspaceStatus = "not_downloaded" | "success" | "failed" | "blocked"

export interface KnowledgeWorkspaceState {
  role: KnowledgeWorkspaceRole
  status: KnowledgeWorkspaceStatus
  lastError: string | null
}

export interface KnowledgeBaseStateItem {
  idKey: string
  type: "public"
  name: string
  description: string
  ownerId: string
  ownerName: string
  repoUrl: string
  sshUrl: string | null
  gitRef: string
  visibility: KnowledgeBaseVisibility
  lastSuccessfulSyncAt?: string
  workspaces: KnowledgeWorkspaceState[]
}

export interface KnowledgeBaseState {
  schemaVersion: 1
  knowledgeBases: KnowledgeBaseStateItem[]
}

export interface KnowledgeWorkspaceListItem extends KnowledgeWorkspaceState {
  localPath: string
  localValid: boolean
  inUse: boolean
  syncing: boolean
}

export interface KnowledgeBaseListItem extends KnowledgeBaseStateItem {
  workspaces: KnowledgeWorkspaceListItem[]
  /** Runtime revision after read synchronization; never persisted in the state file. */
  previewRevision: number
  /** Default preview always uses the read workspace. */
  localPath: string
  localValid: boolean
}

export interface KnowledgeBaseListResult {
  ready: boolean
  knowledgeBases: KnowledgeBaseListItem[]
  refreshing: boolean
  syncingIds: string[]
  writeSyncingIds: string[]
  queryError: string | null
}

export interface KnowledgeWorkspaceSyncResult {
  role: KnowledgeWorkspaceRole
  status: "downloaded" | "up_to_date" | "paused" | "failed"
  message: string
}

export interface KnowledgeBaseSyncResult {
  idKey: string
  status: "downloaded" | "up_to_date" | "paused" | "partial" | "failed"
  message: string
  workspaces: KnowledgeWorkspaceSyncResult[]
}

export interface KnowledgeDepositionWorkspace {
  path: string
  warning?: string
}
