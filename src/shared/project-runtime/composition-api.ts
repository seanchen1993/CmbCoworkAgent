import type {
  CompositionCompletionProof,
  ProjectCompositionDefinition,
  ProjectCompositionSource
} from "./composition"

export type CompositionStatus =
  | "running"
  | "waiting-approval"
  | "succeeded"
  | "failed"
  | "cancel-requested"
  | "cancelled"
  | "unknown"
export interface CompositionUnitState {
  id: string
  status: "pending" | Exclude<CompositionStatus, "cancel-requested">
  attemptId?: string
  engineRunId?: string
  proof?: CompositionCompletionProof
  reason?: string
}
export interface CompositionRun {
  id: string
  requestId: string
  version: number
  definition: ProjectCompositionDefinition
  definitionDigest: string
  status: CompositionStatus
  units: CompositionUnitState[]
  createdAt: number
  updatedAt: number
  /** Native preparation only: no engine may claim a unit until configuration is confirmed. */
  configurationPending?: boolean
  /** Native-confirmed original feature context, frozen before the first engine claim. */
  unitContexts?: Record<string, CompositionUnitContextSelection>
}
export interface CompositionUnitContextSelection {
  deployUnitIds: string[]
  contextFingerprint: string
}
export interface CompositionUnitContextOptions {
  supported: boolean
  required: boolean
  candidates: string[]
  selected: string[]
  contextFingerprint?: string
}
export function parseCompositionUnitContext(value: unknown): CompositionUnitContextSelection {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !Object.hasOwn(value, "deployUnitIds") ||
      !Object.hasOwn(value, "contextFingerprint")) throw Error("COMPOSITION_UNIT_CONTEXT_INVALID")
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.deployUnitIds) || input.deployUnitIds.length > 128 ||
      new Set(input.deployUnitIds).size !== input.deployUnitIds.length ||
      input.deployUnitIds.some(id => typeof id !== "string" || !id.trim() || id !== id.trim() ||
        id.length > 512 || [...id].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) ||
      typeof input.contextFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.contextFingerprint))
    throw Error("COMPOSITION_UNIT_CONTEXT_INVALID")
  return { deployUnitIds: [...input.deployUnitIds] as string[], contextFingerprint: input.contextFingerprint }
}
export function parseCompositionUnitContexts(value: unknown, unitIds: string[]): Record<string, CompositionUnitContextSelection> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !unitIds.includes(key))) throw Error("COMPOSITION_UNIT_CONTEXT_INVALID")
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseCompositionUnitContext(item)]))
}
export interface ProjectCompositionScope {
  threadId: string
  expectedWorkspace: string
  projectId: string
}
export interface ProjectCompositionUnitConfigurationScope {
  scope: ProjectCompositionScope
  runId: string
  unitId: string
  expectedVersion: number
}
/** Native editor routing only. The main process resolves all actual directories and sources. */
export function compositionUnitConfigurationKey(input: ProjectCompositionUnitConfigurationScope): string {
  return JSON.stringify(input)
}
export interface ProjectCompositionCatalogEntry {
  source: ProjectCompositionSource
  sourceName: string
  title: string
  description?: string
  kind: "capability" | "flow"
  available: boolean
  reasons: string[]
  inputs: Array<{ id: string; title: string; required: boolean }>
  outputs: Array<{ id: string; title: string; path: string }>
  workflow?: Pick<import("../node-composition").NativeNodeCatalog, "config" | "nodes">
}
export interface ProjectCompositionCatalog {
  revision: string
  contextKey: string
  projectName: string
  entries: ProjectCompositionCatalogEntry[]
  diagnostics?: string[]
}
export interface ProjectCompositionHostApproval {
  kind?: "host"
  unitId: string
  operationId: string
  operationVersion: number
  inputFingerprint: string
  stageTitle: string
  checks: string[]
  artifacts: string[]
}
export interface ProjectCompositionLegacyApproval {
  kind: "legacy-human-gate"
  unitId: string
  gateId: string
  projectId: string
  featureId: string
  message: string
  sourceThreadId: string
}
export type ProjectCompositionApproval =
  | ProjectCompositionHostApproval
  | ProjectCompositionLegacyApproval
export type ProjectCompositionApprovalInput = {
  scope: ProjectCompositionScope
  runId: string
  unitId: string
  expectedVersion: number
  decision: "approved" | "rejected"
} & (
  | { kind?: "host"; operationId: string; inputFingerprint: string }
  | { kind: "legacy-human-gate"; gateId: string }
)
export interface ProjectCapabilityProfile {
  revision: string
  contextKey: string
  sources: ProjectCompositionSource[]
}
export interface ProjectCapabilityPreview {
  id: string
  contextKey: string
  sources: ProjectCompositionSource[]
  addedSources: ProjectCompositionSource[]
  issues: string[]
}
export interface ProjectCompositionPreview {
  id: string
  contextKey: string
  definition: ProjectCompositionDefinition
  addedUnitIds: string[]
  issues: string[]
  optionalOmissions?: Array<{ unitId: string; nodeId: string; path: string }>
  entryInputFallbacks?: Array<{ unitId: string; nodeId: string; path: string; guidance: string }>
}
export interface ProjectCompositionToolApproval {
  unitId: string
  requestId: string
  operation: string
  command?: string
  filePath?: string
  code?: string
  cwd: string
  reason?: string
  allow: boolean
}
export interface ProjectCompositionLegacyDecision {
  unitId: string
  notificationId: string
  message: string
  humanGatePending: boolean
}
export interface ProjectCompositionLegacyDecisionInput {
  scope: ProjectCompositionScope
  runId: string
  unitId: string
  notificationId: string
  expectedVersion: number
  action: "continue" | "new_thread" | "stop"
  message?: string
}
export interface ProjectCompositionApi {
  readUnitContext(input: ProjectCompositionUnitConfigurationScope): Promise<CompositionUnitContextOptions>
  saveUnitContext(input: ProjectCompositionUnitConfigurationScope & CompositionUnitContextSelection): Promise<CompositionRun>
  prepare(input: { scope: ProjectCompositionScope; previewId: string; requestId: string }): Promise<CompositionRun>
  startPrepared(input: { scope: ProjectCompositionScope; runId: string; expectedVersion: number }): Promise<CompositionRun>
  unitMods: import("./function-source").ProjectFunctionSourceApi
  readLegacyDecision(input: {
    scope: ProjectCompositionScope
    runId: string
  }): Promise<ProjectCompositionLegacyDecision | null>
  decideLegacyDecision(input: ProjectCompositionLegacyDecisionInput): Promise<{
    applied: boolean
    message: string
  }>

  readToolApprovals(input: {
    scope: ProjectCompositionScope
    runId: string
  }): Promise<ProjectCompositionToolApproval[]>
  respondToolApproval(input: {
    scope: ProjectCompositionScope
    runId: string
    unitId: string
    requestId: string
    decision: "allow" | "deny"
  }): Promise<void>
  readArtifact(input: {
    scope: ProjectCompositionScope
    runId: string
    unitId: string
    artifactId: string
  }): Promise<{ path: string; title: string; content: string | null; message?: string }>
  openWorkspace(input: {
    scope: ProjectCompositionScope
    runId: string
    unitId: string
  }): Promise<{ path: string }>
  readCapabilities(scope: ProjectCompositionScope): Promise<ProjectCapabilityProfile>
  previewCapabilities(input: {
    scope: ProjectCompositionScope
    catalogRevision: string
    sources: ProjectCompositionSource[]
  }): Promise<ProjectCapabilityPreview>
  applyCapabilities(input: {
    scope: ProjectCompositionScope
    previewId: string
    expectedRevision: string
  }): Promise<ProjectCapabilityProfile>
  waitingApproval(input: {
    scope: ProjectCompositionScope
    runId: string
  }): Promise<ProjectCompositionApproval | null>
  approve(input: ProjectCompositionApprovalInput): Promise<CompositionRun>
  catalog(scope: ProjectCompositionScope): Promise<ProjectCompositionCatalog>
  preview(input: {
    scope: ProjectCompositionScope
    catalogRevision: string
    definition: ProjectCompositionDefinition
  }): Promise<ProjectCompositionPreview>
  start(input: {
    scope: ProjectCompositionScope
    previewId: string
    requestId: string
  }): Promise<CompositionRun>
  read(input: { scope: ProjectCompositionScope; runId: string }): Promise<CompositionRun>
  resume(input: {
    scope: ProjectCompositionScope
    runId: string
    expectedVersion: number
  }): Promise<CompositionRun>
  cancel(input: {
    scope: ProjectCompositionScope
    runId: string
    expectedVersion: number
  }): Promise<CompositionRun>
}
