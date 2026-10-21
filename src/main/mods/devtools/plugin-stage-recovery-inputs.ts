import { randomUUID } from "node:crypto"
import { StageRecoveryInputs, type StageRecoveryInputSnapshot } from "./stage-recovery-inputs"
import type { ProjectRecoveryContext } from "../../harness-board/project-runtime/recovery-context"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { readPluginManifest } from "../../plugins/manifest"

export interface PluginRecoveryInputSource {
  sourceId: string
  workspace: string
  packageRoot: string
  packageDigest: string
  packageId: string
  packageVersion: string
  guard(): void
}
/** Main-only opaque reference. Never include it in plugin source, model context or approvals. */
export interface PluginRecoveryInputHandle {
  readonly schemaVersion: 1
  readonly id: string
}
type Target = {
  projectId: string
  workspace: string
  packageRoot: string
  installedPluginId?: string
}

/** Shares the original native configuration/knowledge implementation without constructing Host state. */
export class PluginStageRecoveryInputs {
  private readonly native: StageRecoveryInputs
  private closed = false
  private readonly handles = new WeakMap<
    PluginRecoveryInputHandle,
    { snapshot: StageRecoveryInputSnapshot; source: PluginRecoveryInputSource }
  >()
  constructor(deps: ConstructorParameters<typeof StageRecoveryInputs>[0]) {
    this.native = new StageRecoveryInputs(deps)
  }
  close(): void {
    this.closed = true
    this.native.close()
  }
  private read(handle: PluginRecoveryInputHandle) {
    const entry = this.handles.get(handle)
    if (this.closed || !entry) throw Error("PLUGIN_STAGE_RECOVERY_INPUTS_REFERENCE_INVALID")
    return entry
  }
  async capture(source: PluginRecoveryInputSource): Promise<PluginRecoveryInputHandle> {
    if (this.closed) throw Error("PLUGIN_STAGE_RECOVERY_INPUTS_REFERENCE_INVALID")
    if (
      !/^[a-f0-9]{64}$/.test(source.packageDigest) ||
      !source.sourceId ||
      !source.packageId ||
      !source.packageVersion
    )
      throw Error("PLUGIN_STAGE_RECOVERY_INPUTS_SOURCE_INVALID")
    source.guard()
    const metadata = readPluginManifest(source.packageRoot)?.manifest
    if (metadata?.name !== source.packageId || metadata.version !== source.packageVersion)
      throw Error("PLUGIN_STAGE_RECOVERY_INPUTS_SOURCE_CHANGED")
    const snapshot = await this.native.captureOwnedProject({
      ...source,
      inputIdentity: source.packageDigest,
      retainAuthority: true
    })
    source.guard()
    if (!snapshot) throw Error("PLUGIN_STAGE_RECOVERY_INPUTS_SNAPSHOT_REQUIRED")
    const handle = Object.freeze({ schemaVersion: 1 as const, id: randomUUID() })
    this.handles.set(handle, { snapshot, source: { ...source } })
    return handle
  }
  /** Async: re-preloads the genuine native source/schema, then verifies source values and knowledge. */
  async assertCurrent(
    handle: PluginRecoveryInputHandle,
    guard: () => void = () => {}
  ): Promise<void> {
    const current = this.read(handle)
    const check = () => {
      current.source.guard()
      guard()
    }
    check()
    await this.native.assertCurrent(current.snapshot, check)
    check()
  }
  /** Stable Main-only facts hash, not a serialized handle or native input payload. */
  identity(handle: PluginRecoveryInputHandle): string {
    const current = this.read(handle)
    current.source.guard()
    return this.native.identity(current.snapshot)
  }
  async bind(handle: PluginRecoveryInputHandle, target: Target, guard: () => void): Promise<void> {
    const current = this.read(handle)
    await this.assertCurrent(handle, guard)
    if (
      normalizeWorkspacePathKey(current.source.workspace) ===
      normalizeWorkspacePathKey(target.workspace)
    )
      throw Error("PLUGIN_STAGE_RECOVERY_INPUTS_TARGET_INVALID")
    await this.native.bindOwnedEquivalent(
      current.snapshot,
      { ...target, installedPluginId: target.installedPluginId ?? target.projectId },
      () => {
        current.source.guard()
        guard()
      }
    )
    guard()
  }
  /** Use before source-side execution; the returned roots are app-owned frozen copies only. */
  async prepareProviderInputs(
    handle: PluginRecoveryInputHandle,
    guard: () => void
  ): Promise<ProjectRecoveryContext | undefined> {
    const current = this.read(handle)
    await this.assertCurrent(handle, guard)
    return this.native.prepareProviderInputs(current.snapshot, () => {
      current.source.guard()
      guard()
    })
  }
  async readOnlyRoots(
    handle: PluginRecoveryInputHandle,
    guard: () => void = () => {}
  ): Promise<readonly string[]> {
    const provider = await this.prepareProviderInputs(handle, guard)
    return provider
      ? [provider.directory, ...(provider.knowledgeRoot ? [provider.knowledgeRoot] : [])]
      : []
  }
  /** Bound branches validate their own native inputs; later source edits confer no authority. */
  assertTargetCurrent(projectId: string): void {
    if (this.closed) throw Error("PLUGIN_STAGE_RECOVERY_INPUTS_REFERENCE_INVALID")
    this.native.assertBranchCurrent(projectId)
  }
  targetReadOnlyRoots(projectId: string): readonly string[] {
    this.assertTargetCurrent(projectId)
    return this.native.branchReadOnlyRoots(projectId)
  }
  async targetInputs(projectId: string, input: { guard(): void }) {
    if (this.closed) throw Error("PLUGIN_STAGE_RECOVERY_INPUTS_REFERENCE_INVALID")
    return this.native.targetInputs(projectId, () => {
      if (this.closed) throw Error("PLUGIN_STAGE_RECOVERY_INPUTS_REFERENCE_INVALID")
      input.guard()
    })
  }
}
