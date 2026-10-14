import type { ClawActionIdentity } from "../mods/claw-actions"

export const PROJECT_RUNTIME_API_VERSION = "devclaw.project-runtime/v1" as const
export const PROJECT_RUNTIME_MAX_BYTES = 64 * 1024

export interface ProjectRuntimeManifest {
  apiVersion: typeof PROJECT_RUNTIME_API_VERSION
  plugin: { id: string; version: string }
  mode: "host" | "legacy"
  stateOwner: "host" | "plugin"
  /** Array order is the complete linear route in host mode. */
  stages: Array<{
    id: string
    title: string
    skill?: string
    actionIds: string[]
    artifactIds: string[]
    checkIds: string[]
    approval: "none" | "human"
  }>
  actions: Array<{ id: string; ref: ClawActionIdentity }>
  artifacts: Array<{ id: string; path: string; required: boolean }>
  checks: Array<{
    id: string
    kind: "file-exists" | "json-schema" | "action"
    artifactId: string
    schema?: Record<string, unknown>
    actionId?: string
    sideEffect: "read" | "report" | "external"
  }>
  environment: Array<{ id: string; description: string; required: boolean }>
  /** Claimed capabilities are declarations, never authorization or verified support. */
  capabilities: {
    execution: boolean
    conditionalTransition: boolean
    idempotency: boolean
    reconciliation: boolean
    cancellation: boolean
  }
}

export type ProjectRuntimeDescription =
  | { status: "ready"; manifest: ProjectRuntimeManifest; declarationDigest: string }
  | { status: "invalid"; message: string }

/** Construct only from the main process's resolved project and installed plugin binding. */
export interface ProjectRuntimeBinding {
  projectId: string
  featureId: string
  workspace: string
  pluginId: string
  pluginDigest: string | null
}

export interface ProjectRuntimeSnapshot {
  apiVersion: typeof PROJECT_RUNTIME_API_VERSION
  binding: ProjectRuntimeBinding
  stateOwner: "plugin"
  currentStageId: string
  observationFingerprint: string
  stages: Array<{
    id: string
    title: string
    status: string
    artifacts: Array<{
      id: string
      paths: string[]
      required: boolean
      presence: "present" | "missing" | "unknown"
      validation: "valid" | "invalid" | "unknown"
    }>
  }>
  evidence: Array<{
    id: string
    stageId: string
    source: "legacy-hook"
    validity: "unknown"
    historicalStatus: string
    timestamp: string
  }>
  support: {
    snapshot: true
    prepareAction: true
    startAction: false
    requestTransition: false
    cancel: false
    reconcile: false
  }
}

export type ProjectRuntimePreparedAction =
  | { status: "blocked"; reason: string }
  | {
      status: "prepared"
      kind: "legacy-session"
      binding: ProjectRuntimeBinding
      stageId: string
      observationFingerprint: string
      slashSkill?: string
      userMessage?: string
      dialogTips?: string
      preferredPlugin?: { id?: string; name?: string }
      /** Preparing this value does not create a conversation or authorize execution. */
      execution: "existing-session-entry"
    }
