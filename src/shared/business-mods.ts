/** Portable business implementations. These declarations confer no execution permission. */
import type { ClawActionExport } from "./mods/claw-actions"
import type { CapabilityUsage } from "./mods/capability-usage"
export const BUSINESS_MOD_MANIFEST = "mods/business/manifest.json"
export const BUSINESS_MOD_ASSEMBLY = "devclaw.business-assembly.json"

export interface BusinessModDefinition {
  id: string
  title: string
  node: Record<string, unknown>
  skill: { entry: string; resources: string[] }
  resources: string[]
  dependencies: { required: string[]; advisory: string[] }
  checks: { validators: string[]; guards: string[] }
  insertAfter?: string
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
}
export interface BusinessModCatalog {
  apiVersion: "devclaw.business-mods/v1"
  kind: "catalog"
  kernel?: {
    id: string
    version: string
    resources: string[]
    boardConfigPath: string
    pluginFields?: Record<string, unknown>
  }
  kernelRef?: { id: string; version: string }
  modules: BusinessModDefinition[]
  extensions?: BusinessModExtensionDefinition[]
}
export interface BusinessModInspection {
  id: string
  sourceName: string
  sourceDigest: string
  kernel?: { id: string; version: string }
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
  kernel: { id: string; version: string; files: Array<{ path: string; digest: string }> }
  sources: Array<{ name: string; digest: string; mods: string[] }>
  mods: Array<{ id: string; nodeId: string; sourceDigest: string }>
  extensions?: Array<{ id: string; sourceDigest: string }>
  files: Array<{ path: string; digest: string }>
}
