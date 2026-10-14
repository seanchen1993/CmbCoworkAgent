import type { PluginMetadata } from "../../types"
import type { ModControlStore } from "../../mods/control-store"
import type { LegacyProjectRuntimeBinding } from "../../../shared/project-runtime/legacy-operations"
import { compileFunctionPlugin } from "../../mods/v2/loader"
import { assertFunctionSourcesCurrent } from "../../mods/v2/source-adoption-fence"

export interface LegacyModsAdmission {
  identity: NonNullable<LegacyProjectRuntimeBinding["mods"]>
  assertCurrent(): void
}
interface LegacyModsRuntime {
  capture(
    plugin: PluginMetadata,
    snapshotRoot: string,
    workspace: string
  ): Promise<LegacyModsAdmission>
}
let runtime: LegacyModsRuntime | undefined
export function registerLegacyModsRuntime(value: LegacyModsRuntime): () => void {
  if (runtime) throw Error("LEGACY_MODS_RUNTIME_ALREADY_REGISTERED")
  runtime = value
  return () => {
    if (runtime === value) runtime = undefined
  }
}
export async function captureLegacyMods(
  plugin: PluginMetadata,
  snapshotRoot: string,
  workspace: string
): Promise<LegacyModsAdmission> {
  if (!runtime) throw Error("LEGACY_MODS_RUNTIME_UNAVAILABLE")
  return runtime.capture(plugin, snapshotRoot, workspace)
}

/** Uses the original shared runtime and its existing grant; never creates or widens a grant. */
export function createLegacyModsRuntime(deps: {
  store: Pick<ModControlStore, "getGrant" | "assertGrant">
  isEnabled(workspace: string): boolean
  workspaceKey(workspace: string): string
  plugins(): readonly PluginMetadata[]
}): LegacyModsRuntime {
  return {
    async capture(plugin, snapshotRoot, workspace) {
      const key = deps.workspaceKey(workspace)
      const [installed, pinned] = await Promise.all([
        compileFunctionPlugin(plugin.path, { captureSources: true }),
        compileFunctionPlugin(snapshotRoot, { captureSources: true })
      ])
      // Compiled digests intentionally retain generated source-location comments and therefore
      // differ across roots. Preserve the live runtime's actual digest for its existing grant;
      // prove snapshot equivalence by every compiler-read source byte and ordered entry instead.
      const sources = (value: typeof installed) =>
        JSON.stringify({
          entries: value.authoringEntries,
          files: Object.entries(value.authoringSources ?? {}).sort(([a], [b]) => a.localeCompare(b))
        })
      if (
        installed.name !== pinned.name ||
        !installed.authoringSources ||
        !pinned.authoringSources ||
        sources(installed) !== sources(pinned)
      )
        throw Error("LEGACY_MODS_DIGEST_CHANGED")
      const modId = `function:${installed.name}`
      const grant = deps.store.getGrant(key, modId)
      if (!grant?.enabled || grant.digest !== installed.digest)
        throw Error("LEGACY_MODS_GRANT_REQUIRED")
      const assertCurrent = () => {
        const current = deps.plugins().find((candidate) => candidate.id === plugin.id)
        if (
          deps.workspaceKey(workspace) !== key ||
          !deps.isEnabled(key) ||
          !current?.enabled ||
          current.path !== plugin.path
        )
          throw Error("LEGACY_MODS_RUNTIME_CHANGED")
        deps.store.assertGrant(grant)
        assertFunctionSourcesCurrent(installed)
        assertFunctionSourcesCurrent(pinned)
      }
      assertCurrent()
      return {
        identity: { modId, digest: installed.digest, grantEpoch: grant.epoch },
        assertCurrent
      }
    }
  }
}
