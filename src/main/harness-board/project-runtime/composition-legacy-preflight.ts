import type { PluginMetadata } from "../../types"
import { readRuntimeScopedFileAsync } from "./safe-files-async"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { readNativeCapabilityCatalog } from "../../plugins/capability-catalog"

/** Read-only entry validation. A declaration never grants tools, model access, or success. */
export async function preflightLegacyCompositionSource(
  plugin: PluginMetadata,
  entry = "devclaw.project-runtime.json",
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  if (!plugin.enabled || entry !== "devclaw.project-runtime.json")
    throw Error("COMPOSITION_LEGACY_ENTRY_UNSUPPORTED")
  const manifestFile = await readRuntimeScopedFileAsync(plugin.path, entry, 256 * 1024)
  if (!manifestFile.bytes) throw Error("COMPOSITION_LEGACY_DECLARATION_REQUIRED")
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes))
  )
  if (manifest.mode !== "legacy") throw Error("COMPOSITION_LEGACY_MODE_REQUIRED")
  if (process.platform !== "win32") throw Error("COMPOSITION_LEGACY_PLATFORM_UNSUPPORTED")
  const board = await readRuntimeScopedFileAsync(
    plugin.path,
    "board_core/board_config.json",
    256 * 1024
  )
  if (!board.bytes) throw Error("COMPOSITION_LEGACY_BOARD_REQUIRED")
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(board.bytes))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("COMPOSITION_LEGACY_BOARD_INVALID")
  const commands = (parsed as { inspectCommands?: Record<string, unknown> }).inspectCommands?.[
    process.platform
  ]
  if (!commands || typeof commands !== "object" || Array.isArray(commands))
    throw Error("COMPOSITION_LEGACY_COMMANDS_REQUIRED")
  for (const key of [
    "create_project",
    "create_feature",
    "project_status",
    "feature_status",
    "session_context_inject"
  ]) {
    const command = (commands as Record<string, unknown>)[key]
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.length > 16000 ||
      command.includes("\0")
    )
      throw Error(`COMPOSITION_LEGACY_COMMAND_REQUIRED:${key}`)
  }
  const catalog = await readNativeCapabilityCatalog(plugin, "project", signal)
  if (catalog.status !== "declared" || catalog.legacyAdapter !== "autobiz-v1")
    throw Error("COMPOSITION_LEGACY_PROTOCOL_UNSUPPORTED")
  signal?.throwIfAborted()
}
