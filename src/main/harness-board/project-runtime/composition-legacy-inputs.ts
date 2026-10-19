import type { PluginMetadata } from "../../types"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import {
  captureProjectRuntimeInputAuthorityIdentity,
  prepareProjectRuntimeInputIdentity,
  projectRuntimeInputIdentity
} from "../project-action-runtime"
import { readRuntimeScopedFile, runtimeDigest } from "./safe-files"

/** Internal original-stage admission shares the same host input facts as other project entries. */
export async function captureLegacyCompositionInputs(
  plugin: Pick<PluginMetadata, "id" | "name" | "path" | "version">,
  digest: string,
  workspace: string
): Promise<{ fingerprint: string; assertCurrent(): void; assertAuthorityCurrent(): void } | undefined> {
  const context = readPackageExtensionContract(plugin.path)?.context
  if (!context) return undefined
  if (!context.provider?.entry) throw Error("COMPOSITION_CONTEXT_PROVIDER_REQUIRED")
  const file = readRuntimeScopedFile(plugin.path, "devclaw.project-runtime.json", 65_536)
  if (!file.bytes) throw Error("COMPOSITION_INPUT_SOURCE_REQUIRED")
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
  )
  if (manifest.mode !== "legacy" || manifest.plugin.id !== plugin.name ||
    manifest.plugin.version !== plugin.version)
    throw Error("COMPOSITION_INPUT_SOURCE_CHANGED")
  const project = {
    workspace,
    installedPluginId: plugin.id,
    packageId: manifest.plugin.id,
    pluginDigest: digest,
    manifest
  }
  await prepareProjectRuntimeInputIdentity(project, plugin.path)
  const identity = projectRuntimeInputIdentity(project, plugin.path)
  if (identity === undefined) throw Error("COMPOSITION_INPUT_IDENTITY_UNAVAILABLE")
  const readAuthority = captureProjectRuntimeInputAuthorityIdentity(project, plugin.path)
  if (!readAuthority) throw Error("COMPOSITION_INPUT_AUTHORITY_UNAVAILABLE")
  const authority = readAuthority()
  const assertAuthorityCurrent = () => {
    if (readAuthority() !== authority) throw Error("COMPOSITION_CONTEXT_INPUT_CHANGED")
  }
  const assertCurrent = () => {
    assertAuthorityCurrent()
    if (projectRuntimeInputIdentity(project, plugin.path) !== identity)
      throw Error("COMPOSITION_CONTEXT_INPUT_CHANGED")
  }
  assertCurrent()
  return { fingerprint: runtimeDigest(identity), assertCurrent, assertAuthorityCurrent }
}
