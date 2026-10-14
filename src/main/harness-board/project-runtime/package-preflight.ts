import { validatePluginManifest } from "../../plugins/manifest"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime/types"
import { hostStateError } from "./host-state-protocol"
import { readRuntimeScopedFile, runtimeRelativePath } from "./safe-files"
import { assertHostRuntimeSupported } from "./host-validators"
import { readProjectActionLock } from "./action-input"

/** Mirrors shared Mods discovery, including implicit native and hooks.modules declarations. */
export function packageUsesSharedMods(
  root: string,
  metadata: { mods?: unknown; hooks?: string }
): boolean {
  if (
    metadata.mods !== undefined ||
    readRuntimeScopedFile(root, "mods/manifest.json", 32768).present
  )
    return true
  const hooks = readRuntimeScopedFile(
    root,
    runtimeRelativePath(metadata.hooks ?? "hooks/hooks.json"),
    32768
  )
  if (!hooks.bytes) return false
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(hooks.bytes))
  } catch {
    hostStateError("PLUGIN_HOOKS_INVALID")
  }
  return !!value && typeof value === "object" && Object.hasOwn(value, "modules")
}

/** Bounded, read-only preflight; also used by the catalog to expose an explicit diagnostic. */
export function assertHostPackageSupported(root: string, runtime: ProjectRuntimeManifest) {
  assertHostRuntimeSupported(runtime)
  readProjectActionLock(root, runtime)
  let raw: Record<string, unknown> | undefined
  for (const path of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"]) {
    const file = readRuntimeScopedFile(root, path, 256 * 1024)
    if (!file.bytes) continue
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
    } catch {
      hostStateError("PLUGIN_MANIFEST_INVALID")
    }
    break
  }
  const metadata = validatePluginManifest(raw)
  if (
    !metadata ||
    metadata.name !== runtime.plugin.id ||
    metadata.version !== runtime.plugin.version
  )
    hostStateError("PACKAGE_IDENTITY_MISMATCH")
  if (raw?.mods !== undefined || packageUsesSharedMods(root, metadata))
    hostStateError("PINNED_MODS_UNSUPPORTED")
  if (raw?.mcpServers !== undefined || readRuntimeScopedFile(root, ".mcp.json").present)
    hostStateError("PINNED_MCP_UNSUPPORTED")
  if (metadata.hooks) runtimeRelativePath(metadata.hooks)
  for (const stage of runtime.stages)
    if (!readRuntimeScopedFile(root, stage.skill!, 256 * 1024).present)
      hostStateError("SKILL_MISSING")
  return metadata
}
