export interface GitPanelRepository {
  path: string
  branch: string | null
  source: "workspace" | "authorized"
}
