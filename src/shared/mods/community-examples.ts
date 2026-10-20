export type CommunityExampleId =
  | "token-weather"
  | "replay-theater"
  | "blast-radius"
  | "task-workbench-provider"
  | "task-workbench-consumer"
  | "task-behavior-prefix"
  | "task-behavior-compact"
  | "edit-reminder"
  | "stage-debugger"

interface CommunityExampleBase {
  id: CommunityExampleId
  pluginName: string
  title: string
  description: string
  usage: string
  conflictNote?: string
  installation?: { state: "missing" | "installed" | "conflict"; pluginId?: string }
}

export type CommunityExample = CommunityExampleBase &
  (
    | { origin?: "anthropic"; upstreamUrl: string; commit: string }
    | { origin: "devclaw"; sourcePath: string; version: string }
  )

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
