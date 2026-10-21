/** Portable business implementations. These declarations confer no execution permission. */
import type { ClawActionExport } from "./mods/claw-actions"
import type { CapabilityUsage } from "./mods/capability-usage"
import type { FunctionUserConfig } from "./mods/v2/user-config"
import type { ModObject } from "./mods/types"
import type { ProjectRuntimeManifest } from "./project-runtime"
export const BUSINESS_MOD_MANIFEST = "mods/business/manifest.json"
export const BUSINESS_MOD_ASSEMBLY = "devclaw.business-assembly.json"

/** A platform-reviewed static projection, never a path to author code. */
export type BusinessModAssemblyAdapterId = "autobiz-v1" | "host-linear-v1"
export interface BusinessModKernel {
  id: string
  version: string
  resources: string[]
  /** Omitted only for pre-adapter catalogs using the legacy compatibility projection. */
  runtime?:
    | { adapter: "autobiz-v1" }
    | { adapter: "host-linear-v1"; capabilities?: ProjectRuntimeManifest["capabilities"] }
  boardConfigPath?: string
  pluginFields?: Record<string, unknown>
}
/** Reuses the existing Host linear executor and its admission/check semantics. */
export interface BusinessModHostDeclaration {
  stage: Pick<
    ProjectRuntimeManifest["stages"][number],
    "actionIds" | "artifactIds" | "checkIds" | "approval"
  >
  actions: ProjectRuntimeManifest["actions"]
  artifacts: ProjectRuntimeManifest["artifacts"]
  checks: ProjectRuntimeManifest["checks"]
  environment: ProjectRuntimeManifest["environment"]
}

export interface BusinessModDefinition {
  id: string
  title: string
  node: Record<string, unknown>
  skill: { entry: string; resources: string[] }
  resources: string[]
  dependencies: { required: string[]; advisory: string[] }
  checks: { validators: string[]; guards: string[] }
  host?: BusinessModHostDeclaration
  insertAfter?: string
  /** Required schema only; installed user values and credentials never enter the catalog. */
  userConfig?: FunctionUserConfig
}
/** Optional functions accompany a workflow; they are never sequential business stages. */
export interface BusinessModExtensionDefinition {
  id: string
  title: string
  kind: "function"
  entry: string
  resources: string[]
  dependencies: { required: string[]; advisory: string[] }
  usage?: CapabilityUsage
  actions?: ClawActionExport[]
  configSchema?: ModObject
  userConfig?: FunctionUserConfig
  contextProvider?: {
    entry: string
    operations: Array<"session-context" | "sync-knowledge">
    knowledgeBinding?: string
    required: boolean
  }
  /** Plugin-owned recovery protocol; selection never grants execution or repository reset. */
  stageRecoveryAdapter?: {
    apiVersion: "devclaw.plugin-stage-recovery/v1"
    entry: string
    runtime: "python"
    isolation: "private-output-copy"
    codeSource: "keep"
    externalEffects: "network-requires-confirmation"
  }
  /** Auxiliary native Skills exposed through the plugin's ordinary search roots. */
  skills?: string[]
}
export interface BusinessModCatalog {
  apiVersion: "devclaw.business-mods/v1"
  kind: "catalog"
  kernel?: BusinessModKernel
  kernelRef?: { id: string; version: string }
  modules: BusinessModDefinition[]
  extensions?: BusinessModExtensionDefinition[]
}
export interface BusinessModInspection {
  id: string
  sourceName: string
  sourceDigest: string
  kernel?: { id: string; version: string; runtimeAdapter?: BusinessModAssemblyAdapterId }
  mods: Array<{
    id: string
    title: string
    kind?: "business" | "function"
    nodeId?: string
    dependsOn: string[]
    advisory: string[]
    insertAfter?: string
  }>
  excluded: string[]
  warnings: string[]
}
export interface BusinessModAssemblyRequest {
  sources: Array<{ inspectionId: string; modIds: string[] }>
  name: string
  version: string
  order?: string[]
  acceptFixedWorkflow?: boolean
  /** Opt-in checked output IDs; export uses the original fixed verified-context bundle. */
  verifiedArtifactIds?: string[]
}
export interface BusinessModPreview {
  previewId: string
  digest: string
  name: string
  version: string
  steps: Array<{ id: string; title: string; sourceName: string; added?: boolean }>
  extensions?: Array<{ id: string; title: string; sourceName: string; added?: boolean }>
  files: Array<{ path: string; digest: string; bytes: number }>
  sources: Array<{ name: string; digest: string }>
  diagnostics: string[]
  valid: boolean
  runtime?: {
    adapter: BusinessModAssemblyAdapterId
    mode: "host" | "legacy"
    stateOwner: "host" | "plugin"
  }
  requiresFixedWorkflowAcknowledgement?: boolean
}
export interface BusinessModCopy {
  copyId: string
  name: string
  version: string
  digest: string
  status: "created" | "checked" | "installed"
  fileCount: number
  pluginId?: string
  /** Host materialization intent; installation must use the original native ZIP update. */
  exportOnly?: boolean
}
export interface BusinessModExport {
  output: string
  digest: string
  files: number
}
export interface BusinessModAssemblyLock {
  apiVersion: "devclaw.business-assembly/v1"
  name: string
  version: string
  kernel: {
    id: string
    version: string
    runtime?: BusinessModKernel["runtime"]
    files: Array<{ path: string; digest: string }>
  }
  sources: Array<{ name: string; digest: string; mods: string[] }>
  mods: Array<{ id: string; nodeId: string; sourceDigest: string }>
  extensions?: Array<{ id: string; sourceDigest: string }>
  files: Array<{ path: string; digest: string }>
}
