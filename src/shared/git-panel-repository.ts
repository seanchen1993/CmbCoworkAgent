export interface GitPanelRepository {
  path: string
  branch: string | null
  source: "workspace" | "authorized"
}

export interface GitPanelSnapshot {
  panelBindingVersion?: string
  panelRevision?: string
}

export interface GitPanelOperationOptions extends GitPanelSnapshot {
  worktreePath?: string
  panelRepository?: boolean
}
