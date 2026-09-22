export const MODS_API_VERSION = "cmb.mods/v1" as const

export type ModJson = null | boolean | number | string | ModJson[] | ModObject
export type ModObject = { [key: string]: ModJson }
export type ModEvent = "tool.call" | "prompt.context" | "command.run" | "ui.render"
export type ModEffect = "read" | "write" | "unknown"
export type ModExecution = "not_started" | "running" | "succeeded" | "failed" | "unknown"

export interface ModManifest {
  apiVersion: typeof MODS_API_VERSION
  id: string
  name: string
  entry: string
  events: ModEvent[]
  tools: string[]
  permissions: {
    readTools: string[]
    writeTools: string[]
    context: string[]
    store: boolean
    artifacts?: boolean
  }
  activation: "project" | "plugin"
  before?: string[]
  after?: string[]
}

export interface ModIdentity {
  callId: string
  toolCallId?: string
  parentCallId?: string
  threadId: string
  turnId: string
  agentId: string
  workspace: string
  origin: "model" | "mod" | "user-action"
  modId?: string
  grantEpoch: number
}

export interface ModProjection {
  text: string
  data?: ModJson
}

export interface ModToolResult {
  receipt: string
  execution: ModExecution
  projection: ModProjection
}

export interface ModRegistration {
  id: string
  event: ModEvent
  tools?: string[]
  command?: string
  slot?: "tool.result.after" | "turn.summary"
}

export type ModUiNode =
  | { type: "text" | "code" | "badge"; text: string }
  | { type: "card"; title: string; children: ModUiNode[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "button"; label: string; command: string; args: ModObject; actionId?: string }
  | { type: "artifact-link"; label: string; artifactId: string }

export interface ModArtifact {
  id: string
  workspace: string
  threadId: string
  modId: string
  digest: string
  label: string
  text: string
  createdAt: number
}

export interface ModCard {
  id: string
  agentId: string
  modId: string
  name: string
  threadId: string
  callId: string
  nodes: ModUiNode[]
  slot?: "tool.result.after" | "turn.summary"
}

export interface ModCommandDescriptor {
  apiVersion?: "cmb.mods/v2"
  isHidden?: true
  immediate?: true
  argumentHint?: string
  turnId: string
  modId: string
  name: string
  command: string
  digest: string
  grantEpoch: number
  workspaceEpoch: number
}

export interface ModCommandJob {
  presentation?: "inline"
  id: string
  threadId: string
  workspace: string
  command: string
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown"
  createdAt: number
  finishedAt?: number
  result?: ModProjection
  error?: string
}

export interface ModDiagnostic {
  modId: string
  code: string
  at: number
}

export interface ModStatus {
  pluginId: string
  manifest: ModManifest | null
  digest: string | null
  state: "disabled" | "needs-approval" | "ready" | "invalid"
  error?: string
  required: boolean
}

export interface ModWorkspaceStatus {
  functionMods?: import("./v2/commands").FunctionPluginStatus[]
  workspace: string
  /** Application-level switch; false prevents all Mod runtime interception. */
  globalEnabled?: boolean
  enabled: boolean
  outputPolicy: boolean
  mods: ModStatus[]
  diagnostics: ModDiagnostic[]
  policy?: { id: string; digest: string; required: boolean }
  recovery?: string
}

export interface ModAuditEntry {
  cursor: number
  callId: string
  toolId: string
  identity: ModIdentity | null
  status: ModExecution
  startedAt: number
  finishedAt: number | null
  originalArgsHash: string
  finalArgsHash: string | null
  policyDigest: string | null
  publication: "pending" | "published" | "blocked"
  ruleIds: string[]
  reconciliation: "confirmed-success" | "confirmed-failure" | null
  modelUsage?: {
    modelRef: string
    outputTokenLimit: number
    inputTokens?: number
    outputTokens?: number
  }
}

export interface ModRuntimeRequest {
  type: "load" | "invoke" | "dispose" | "reply" | "cancel"
  id: string
  runtimeId: string
  code?: string
  registration?: string
  event?: ModObject
  value?: ModJson
  error?: string
}

export interface ModRuntimeResponse {
  type: "ready" | "result" | "error" | "call" | "heartbeat"
  id?: string
  runtimeId?: string
  requestId?: string
  method?: string
  value?: ModJson
  error?: string
}
