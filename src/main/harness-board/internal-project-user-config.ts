import { isSameWorkspacePath } from "../../shared/workspace-path"
import { getPlugins } from "../storage"
import type { FunctionModsManager } from "../mods/v2/manager"
import {
  captureInternalHarnessProjectIdentityGuard,
  readInternalHarnessProject
} from "./internal-project-context"
import { captureLegacyCompositionInputs } from "./project-runtime/composition-legacy-inputs"
import { currentRuntimePluginSource } from "../plugins/runtime-source-scope"

/** Native consent is checked even for a provider without a directory-binding field. */
export async function admitInternalHarnessContextSource(
  manager: FunctionModsManager,
  workspaceKey: (workspace: string) => string,
  input: { projectId: string; sourceRoot: string; workspace: string }
): Promise<() => void> {
  const source = captureInternalConfigurationSource(input)
  const configuration = { workspace: workspaceKey(input.workspace), plugin: source.plugin,
    scope: { projectId: input.projectId, packageDigest: source.packageDigest } }
  await manager.prepareRuntimeSourceFacts(configuration)
  source.check()
  manager.assertRuntimeSourceReady(configuration)
  const inputs = await captureLegacyCompositionInputs(source.plugin, source.packageDigest, input.workspace)
  const guard = () => {
    source.check()
    const active = currentRuntimePluginSource()
    if (active && (active.projectId !== input.projectId || active.packageDigest !== source.packageDigest ||
        active.plugin.id !== source.plugin.id || active.plugin.path !== source.plugin.path ||
        !isSameWorkspacePath(active.workspace, input.workspace)))
      throw Error("COMPOSITION_INTERNAL_CONFIGURATION_CHANGED")
    manager.assertRuntimeSourceReady(configuration)
    inputs?.assertCurrent()
    source.check()
  }
  guard()
  return guard
}

function captureInternalConfigurationSource(input: { projectId: string; sourceRoot: string; workspace: string }) {
  const original = readInternalHarnessProject(input.projectId)
  const plugin = original?.context.plugin
  if (!plugin) throw Error("COMPOSITION_INTERNAL_SOURCE_REQUIRED")
  const identity = captureInternalHarnessProjectIdentityGuard(input.projectId)
  const check = () => {
    identity()
    const current = readInternalHarnessProject(input.projectId)
    const source = current?.context.plugin
    const workspace = current?.featureBinding.sessionWorkspace
    if (!source || source.id !== plugin.id || source.path !== input.sourceRoot ||
        source.path !== plugin.path || source.version !== plugin.version ||
        workspace?.source !== "directory" || !isSameWorkspacePath(workspace.path, input.workspace) ||
        // Creator candidates have no installed record. Their original private provider
        // validates the creator/source/workspace owner; no global install is fabricated.
        (current?.ownerKind !== "creator-business-trial" &&
          !getPlugins().some(item => item.id === source.id && item.enabled)))
      throw Error("COMPOSITION_INTERNAL_CONFIGURATION_CHANGED")
  }
  check()
  return { plugin, packageDigest: plugin.path.split(/[\\/]/).at(-2)!, check }
}

/** Original private unit ownership authorizes only a schema-validated configuration read. */
export async function readInternalHarnessDirectoryUserConfig(
  manager: FunctionModsManager,
  workspaceKey: (workspace: string) => string,
  input: { projectId: string; sourceRoot: string; workspace: string; key: string }
): Promise<string | undefined> {
  const { plugin, check, packageDigest } = captureInternalConfigurationSource(input)
  return manager.readRetainedDirectoryUserConfig(
    { workspace: workspaceKey(input.workspace), plugin,
      scope: { projectId: input.projectId, packageDigest } },
    input.key, check
  )
}
