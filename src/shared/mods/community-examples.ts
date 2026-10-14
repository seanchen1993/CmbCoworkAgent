export type CommunityExampleId = "token-weather" | "replay-theater" | "blast-radius"

export interface CommunityExample {
  id: CommunityExampleId
  pluginName: string
  title: string
  description: string
  usage: string
  conflictNote?: string
  upstreamUrl: string
  commit: string
  installation?: { state: "missing" | "installed" | "conflict"; pluginId?: string }
}

export interface CommunityExampleInstallation {
  pluginId: string
  pluginName: string
  alreadyInstalled: boolean
  requiresApproval: true
}

export interface CommunityExamplesApi {
  list(): Promise<{ examples: CommunityExample[] }>
  install(input: { exampleId: CommunityExampleId }): Promise<CommunityExampleInstallation>
}
