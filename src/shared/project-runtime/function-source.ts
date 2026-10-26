import type { FunctionConfigApi } from "../mods/v2/config-api"
export interface ProjectFunctionDependencyReview {
  pluginId: string
  name: string
  digest: string
  actionIds: string[]
  state: "ready" | "needs-approval" | "disabled" | "missing" | "source-changed" | "invalid"
  capabilities: string[]
  hasConfiguration?: boolean
  configurationReady?: boolean
}
export interface ProjectFunctionSourceReview {
  projectId: string
  projectVersion: number
  packageDigest: string
  workspace: string
  workspaceEnabled?: boolean
  globallyEnabled?: boolean
  dependencies?: ProjectFunctionDependencyReview[]
  source?: {
    pluginId?: string
    name: string
    digest: string
    state: "ready" | "needs-approval" | "disabled"
    capabilities: string[]
    scannedMethods: string[]
    scanIncomplete: boolean
    hasConfiguration?: boolean
    configurationReady?: boolean
    /** Native metadata/configuration only: never a guest or execution approval. */
    configurationOnly?: true
  }
}
export interface ProjectFunctionSourceApi {
  config: FunctionConfigApi
  read(projectId: string): Promise<ProjectFunctionSourceReview>
  approve(input: {
    projectId: string
    projectVersion: number
    packageDigest: string
    compiledDigest: string
  }): Promise<ProjectFunctionSourceReview>
  approveDependency?(input: {
    projectId: string
    projectVersion: number
    packageDigest: string
    pluginId: string
    compiledDigest: string
  }): Promise<ProjectFunctionSourceReview>
}
