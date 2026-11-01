import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { HarnessNativeFeatureBinding } from "../../shared/harness-board-types"
import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type { HostProjectService } from "../harness-board/project-runtime/host-service"
import { getPlugins } from "../storage"
import { derivationContentIdentity, snapshotDerivationSource } from "../plugins/derivation-source"
import { capturePackageMetadataGuard } from "../harness-board/project-runtime/package-snapshots"
import { projectRuntimeFunctionSource } from "../harness-board/project-runtime-function-source"
import { projectRuntimeDependencies } from "../harness-board/project-runtime-dependencies"
import { registerNativeProjectSourceHandlers } from "./native-project-source"

/** Configuration identity exists before execution. It is never a manufactured Host state. */
export function registerNativeHarnessSourceHandlers(ipc: IpcMain, deps: {
  trusted(event: IpcMainInvokeEvent): unknown
  platform(): HostProjectService
  retainedRoot(project: HostProjectState): string
  readBinding(hostRunId: string): HarnessNativeFeatureBinding | undefined
  assertBinding(binding: HarnessNativeFeatureBinding): void
}) {
  registerNativeProjectSourceHandlers(ipc, "harness-native-feature", async (event, ownerKey) => {
    const owner = deps.trusted(event)
    if (typeof ownerKey !== "string" || !ownerKey || ownerKey.length > 256)
      throw Error("PROJECT_INVALID_INPUT")
    const binding = deps.readBinding(ownerKey)
    if (!binding || binding.hostRunId !== ownerKey) throw Error("HARNESS_NATIVE_FEATURE_MISSING")
    const originalBinding = JSON.stringify(binding)
    const api = deps.platform()
    const existing = api.get(ownerKey)
    const originalRun = JSON.stringify(existing)
    const installed = getPlugins().find(plugin => plugin.id === binding.installedPluginId)
    const installedIdentity = JSON.stringify(installed && [installed.id, installed.path,
      installed.name, installed.version, installed.enabled])
    const authorityGuard = () => {
      if (deps.trusted(event) !== owner ||
        JSON.stringify(deps.readBinding(ownerKey)) !== originalBinding ||
        JSON.stringify(api.get(ownerKey)) !== originalRun)
        throw Error("PROJECT_INPUT_CHANGED")
      deps.assertBinding(binding)
      const current = getPlugins().find(plugin => plugin.id === binding.installedPluginId)
      if (!current?.enabled || JSON.stringify([current.id, current.path, current.name,
        current.version, current.enabled]) !== installedIdentity)
        throw Error("PROJECT_PLUGIN_UNAVAILABLE")
      if (api.operations(ownerKey, 100).some(operation =>
        ["started", "cancel_requested", "unknown"].includes(operation.status)))
        throw Error("PROJECT_OPERATION_UNSETTLED")
    }
    authorityGuard()
    if (existing && (existing.installedPluginId !== binding.installedPluginId ||
      existing.workspace !== binding.workspace || existing.pluginDigest !== binding.packageDigest))
      throw Error("HARNESS_NATIVE_RUN_IDENTITY_CHANGED")
    const pending = existing ? undefined : await api.reviewImportTarget(binding.installedPluginId)
    authorityGuard()
    const root = existing ? deps.retainedRoot(existing) : pending!.snapshot.root
    const packageDigest = existing?.pluginDigest ?? pending!.snapshot.digest
    const sourceGuard = capturePackageMetadataGuard(root)
    const originalSource = await snapshotDerivationSource(root)
    authorityGuard()
    sourceGuard()
    pending?.assertCurrent()
    if (derivationContentIdentity(originalSource.files) !== binding.expectedPlugin.digest ||
      (existing?.packageId ?? pending!.snapshot.manifest.plugin.id) !== binding.expectedPlugin.name ||
      (existing?.packageVersion ?? pending!.snapshot.manifest.plugin.version) !== binding.expectedPlugin.version)
      throw Error("PROJECT_PACKAGE_IDENTITY_MISMATCH")
    const guard = () => { authorityGuard(); sourceGuard(); pending?.assertCurrent(); authorityGuard() }
    const source = projectRuntimeFunctionSource({ projectId: ownerKey,
      workspace: binding.workspace, pluginDigest: packageDigest,
      installedPluginId: binding.installedPluginId, packageId: binding.expectedPlugin.name }, root)
    const dependencies = projectRuntimeDependencies({ root, workspace: source.input.workspace,
      manager: source.manager, plugins: getPlugins, assertCurrent: guard })
    // Version zero is a pending configuration scope; real execution versions start at one.
    return { project: { projectId: ownerKey, version: existing?.version ?? 0, pluginDigest: packageDigest },
      root, guard, authorityGuard, ...source, dependencies }
  })
}
