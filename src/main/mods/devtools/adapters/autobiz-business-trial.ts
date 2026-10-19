import type { PluginMetadata } from "../../../types"
import type { ProjectRuntimeManifest } from "../../../../shared/project-runtime"
import { readRuntimeScopedFile } from "../../../harness-board/project-runtime/safe-files"
import { preflightLegacyCompositionSource } from "../../../harness-board/project-runtime/composition-legacy-preflight"

/** The reviewed legacy bridge owns the board protocol. It does not extend the Host contract. */
export async function prepareAutobizBusinessTrial(
  plugin: PluginMetadata,
  manifest: ProjectRuntimeManifest
): Promise<Record<string, unknown>> {
  if (manifest.mode !== "legacy" || manifest.stateOwner !== "plugin")
    throw Error("BUSINESS_TRIAL_ADAPTER_UNSUPPORTED")
  // Preflight verifies native capability legacyAdapter === autobiz-v1. A board file alone
  // is never admission to an unknown executable protocol.
  await preflightLegacyCompositionSource(plugin)
  const board = readRuntimeScopedFile(plugin.path, "board_core/board_config.json", 2 * 1024 * 1024)
  if (!board.bytes) throw Error("BUSINESS_TRIAL_BOARD_REQUIRED")
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(board.bytes))
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("BUSINESS_TRIAL_BOARD_INVALID")
  return value as Record<string, unknown>
}
