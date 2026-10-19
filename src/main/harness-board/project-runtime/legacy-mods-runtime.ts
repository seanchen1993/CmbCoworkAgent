import { lstatSync, realpathSync } from "node:fs"
import type { PluginMetadata } from "../../types"
import type { ModControlStore } from "../../mods/control-store"
import type { LegacyProjectRuntimeBinding } from "../../../shared/project-runtime/legacy-operations"
import { compileFunctionPlugin } from "../../mods/v2/loader"
import { assertFunctionSourcesCurrent } from "../../mods/v2/source-adoption-fence"

export interface LegacyModsAdmission {
  identity: NonNullable<LegacyProjectRuntimeBinding["mods"]>
  /** Original authority/revocation only; metadata readers must not hash complete packages. */
  assertAuthorityCurrent(): void
  /** Fresh two-root source proof for real execution/IO/adoption/publication boundaries. */
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
      // Capture immutable metadata and real root identities before returning this admission.
      // No source bytes or long-lived content cache are used by routine authority readers.
      const expected = { id: plugin.id, name: plugin.name, version: plugin.version, path: plugin.path }
      const roots = [installed.root, pinned.root].map(path => {
        const stat = lstatSync(path, { bigint: true })
        return { path, device: stat.dev, inode: stat.ino }
      })
      const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path
      const assertAuthorityCurrent = () => {
        const current = deps.plugins().find((candidate) => candidate.id === expected.id)
        if (
          deps.workspaceKey(workspace) !== key ||
          !deps.isEnabled(key) ||
          !current?.enabled ||
          current.path !== expected.path || current.name !== expected.name ||
          current.version !== expected.version
        )
          throw Error("LEGACY_MODS_RUNTIME_CHANGED")
        deps.store.assertGrant(grant)
        try {
          for (const root of roots) {
            const stat = lstatSync(root.path, { bigint: true })
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== root.device ||
                stat.ino !== root.inode || pathKey(realpathSync(root.path)) !== pathKey(root.path))
              throw Error("LEGACY_MODS_RUNTIME_CHANGED")
          }
        } catch (cause) {
          // Missing/unreadable or replaced local roots are native source invalidation,
          // never a provider failure that can be repaired by replaying the business turn.
          throw Error("LEGACY_MODS_RUNTIME_CHANGED", { cause })
        }
      }
      const assertCurrent = () => {
        assertAuthorityCurrent()
        assertFunctionSourcesCurrent(installed)
        assertFunctionSourcesCurrent(pinned)
        assertAuthorityCurrent()
      }
      assertCurrent()
      return {
        identity: { modId, digest: installed.digest, grantEpoch: grant.epoch },
        assertAuthorityCurrent,
        assertCurrent
      }
    }
  }
}
