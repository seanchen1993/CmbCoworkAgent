import { dirname } from "node:path"
import type { PluginMetadata } from "../../types"
import { currentRuntimePluginSource } from "../../plugins/runtime-source-scope"
import { readPluginManifest } from "../../plugins/manifest"
import { HostPackageSnapshots, RetainedPackageSnapshots } from "./package-snapshots"
import { runtimeDirectory } from "./safe-files"

/** Internal main-to-worker protocol only. Renderer IPC never accepts a source directory. */
export interface CatalogRuntimeSource {
  mode?: "legacy" | "capabilities"
  projectId: string
  installedPluginId: string
  root: string
  packageDigest: string
}
export function captureCatalogRuntimeSource(
  projectIds: readonly string[]
): CatalogRuntimeSource | undefined {
  const source = currentRuntimePluginSource()
  if (!source || (source.mode !== "legacy" && !(source.mode === "capabilities" && source.preserveParentContext))) return undefined
  if (projectIds.length !== 1 || projectIds[0] !== source.projectId)
    throw Error("LEGACY_CATALOG_SCOPE_CHANGED")
  return {
    mode: source.mode === "capabilities" ? "capabilities" : "legacy",
    projectId: source.projectId,
    installedPluginId: source.plugin.id,
    root: source.plugin.path,
    packageDigest: source.packageDigest
  }
}
/** Worker-side verification, before a board config/script template can be read. */
export function fixedCatalogPlugin(
  projectId: string,
  installed: PluginMetadata | null,
  source?: CatalogRuntimeSource
): PluginMetadata | null {
  if (!source) return installed
  if (
    projectId !== source.projectId ||
    !installed ||
    installed.id !== source.installedPluginId ||
    !installed.enabled
  )
    throw Error("LEGACY_CATALOG_BINDING_CHANGED")
  const ownedRoot = runtimeDirectory(dirname(dirname(source.root)))
  if (source.mode === "capabilities") {
    const snapshot = new RetainedPackageSnapshots(ownedRoot).read(source.packageDigest)
    const metadata = readPluginManifest(snapshot.root)?.manifest
    if (snapshot.root !== source.root || !metadata || metadata.name !== installed.name || metadata.version !== installed.version)
      throw Error("CAPABILITY_CATALOG_SOURCE_CHANGED")
    return { ...installed, path: snapshot.root }
  }
  const snapshot = new HostPackageSnapshots(ownedRoot).read(source.packageDigest)
  if (snapshot.root !== source.root || snapshot.manifest.mode !== "legacy")
    throw Error("LEGACY_CATALOG_SOURCE_CHANGED")
  const metadata = readPluginManifest(snapshot.root)?.manifest
  if (
    !metadata ||
    metadata.name !== snapshot.manifest.plugin.id ||
    metadata.version !== snapshot.manifest.plugin.version ||
    metadata.name !== installed.name
  )
    throw Error("LEGACY_CATALOG_SOURCE_CHANGED")
  return { ...installed, path: snapshot.root, name: metadata.name, version: metadata.version! }
}
