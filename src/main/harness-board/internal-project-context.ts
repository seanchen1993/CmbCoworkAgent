import type { HarnessProjectContextItem } from "./catalog-protocol"
import type { HarnessFeatureDeployUnitBindingRecord } from "./config-v2"
import { basename, isAbsolute, relative, resolve } from "node:path"

import type { DevelopmentScope } from "../mods/v2/development-session"
import type { CreatorModelAccounting } from "../mods/devtools/creator-model-accounting"

interface InternalHarnessProjectCommon {
  featureId: string
  goal: string
  context: HarnessProjectContextItem
  featureBinding: HarnessFeatureDeployUnitBindingRecord
}
export type InternalHarnessProjectOwnerKind = "composition" | "creator-business-trial"
export type InternalHarnessProjectContext = InternalHarnessProjectCommon & (
  | { ownerKind?: "composition"; parentProjectId: string; compositionRunId: string; unitId: string }
  | {
      ownerKind: "creator-business-trial"
      trialId: string
      creatorScope: DevelopmentScope
      captureCreatorAccounting?(threadId: string): CreatorModelAccounting | undefined
      /** Physical admission/cleanup facts only; never a business success assertion. */
      onPhysicalStarted?(input: { threadId: string; requestId: string }): void
      onPhysicalSettlement?(input: {
        threadId: string
        requestId: string
        confirmed: boolean
      }): void
    }
)
/** Main-only directory classification, never a source/content admission or execution grant. */
export interface InternalHarnessProjectWorkspaceIndex {
  projectId: string
  featureId: string
  workspace: string
}
type InternalProjectProvider = (projectId: string) => InternalHarnessProjectContext | undefined
interface Provider {
  read: InternalProjectProvider
  identity?: (projectId: string) => () => void
  workspace?: (projectId: string) => InternalHarnessProjectWorkspaceIndex | undefined
}
// Original main-only source provider dispatch, generalized by explicit owner kind. No records,
// permissions, package catalog or execution authority are stored in this dispatch table.
const providers = new Map<InternalHarnessProjectOwnerKind, Provider>()
function ownerKind(projectId: string): InternalHarnessProjectOwnerKind | undefined {
  if (projectId.startsWith("composition-legacy:")) return "composition"
  if (projectId.startsWith("creator-business-trial:")) return "creator-business-trial"
  return undefined
}
/** Namespace routing only. A true value never admits a source or grants execution. */
export function isInternalHarnessProjectId(projectId: string): boolean {
  return ownerKind(projectId) !== undefined
}
/** Host registration only. Providers enforce their original durable owner/source scope. */
export function registerInternalHarnessProjectProvider(
  next: InternalProjectProvider,
  captureIdentity?: (projectId: string) => () => void,
  readWorkspace?: (projectId: string) => InternalHarnessProjectWorkspaceIndex | undefined,
  kind: InternalHarnessProjectOwnerKind = "composition"
): () => void {
  if (providers.has(kind) && providers.get(kind)!.read !== next)
    throw Error("COMPOSITION_INTERNAL_PROVIDER_ALREADY_REGISTERED")
  const entry: Provider = { read: next, identity: captureIdentity, workspace: readWorkspace }
  providers.set(kind, entry)
  return () => { if (providers.get(kind) === entry) providers.delete(kind) }
}

/** Old providers retain their original full read; a missing modern row never falls back. */
export function readInternalHarnessProjectWorkspaceIndex(
  projectId: string
): InternalHarnessProjectWorkspaceIndex | undefined {
  const kind = ownerKind(projectId), provider = kind && providers.get(kind)
  if (!provider) return undefined
  if (provider.workspace) return provider.workspace(projectId)
  const internal = readInternalHarnessProject(projectId)
  if (!internal) return undefined
  // Preserve the original service projectDirectoryPath constraints for old providers.
  const project = internal.context.project
  const text = (value: unknown) => typeof value === "string" ? value.trim() : ""
  const directory = text(project.projectDir) || text(project.projectCode)
  const root = resolve(project.workspacePath), workspace = resolve(root, directory)
  const child = relative(root, workspace)
  if (workspace === root || basename(workspace) !== directory || child.startsWith("..") || isAbsolute(child))
    throw Error(`Project dir resolves outside workspace: ${directory}`)
  return {
    projectId: internal.context.project.projectId,
    featureId: internal.featureId,
    workspace
  }
}
export function readInternalHarnessProject(
  projectId: string
): InternalHarnessProjectContext | undefined {
  const kind = ownerKind(projectId), provider = kind && providers.get(kind)
  const value = provider?.read(projectId)
  if (value && ((value.ownerKind ?? "composition") !== kind ||
      value.context.project.projectId !== projectId ||
      (value.ownerKind === "creator-business-trial" && value.trialId !== projectId)))
    throw Error("COMPOSITION_INTERNAL_SOURCE_NOT_ADMITTED")
  return value
}

/** Runtime getters check fresh host identity; content checks remain at execution/read boundaries. */
export function captureInternalHarnessProjectIdentityGuard(projectId: string): () => void {
  const kind = ownerKind(projectId), current = kind && providers.get(kind)
  if (!kind || !current?.identity) throw Error("COMPOSITION_INTERNAL_SOURCE_NOT_ADMITTED")
  const guard = current.identity(projectId)
  return () => {
    if (providers.get(kind) !== current) throw Error("COMPOSITION_INTERNAL_PROVIDER_CHANGED")
    guard()
  }
}
