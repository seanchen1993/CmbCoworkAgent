import { join } from "node:path"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import { readRuntimeScopedFile } from "./project-runtime/safe-files"
import { parseBusinessModCatalog } from "../plugins/business-mod-manifest"
import { describeBusinessModAssemblyRuntime } from "../plugins/business-mod-assembly-adapter"
import { isAutobizLegacyProjectRoot } from "../plugins/business-adapters/autobiz-package-admission"

export const HARNESS_BOARD_CONFIG_RELATIVE_PATH = join("board_core", "board_config.json")

/** Display-only old board entry; malformed packages never break the installed-plugin list. */
export function isLegacyProjectModePluginRoot(pluginRoot: string): boolean {
  try {
    return isAutobizLegacyProjectRoot(pluginRoot)
  } catch {
    return false
  }
}

/** Project Skill classification includes native Host stages, independently of the old UI entry. */
export function isProjectModePluginRoot(pluginRoot: string): boolean {
  try {
    const runtime = readRuntimeScopedFile(pluginRoot, "devclaw.project-runtime.json", 65_536)
    if (runtime.bytes) {
      const manifest = parseProjectRuntimeManifest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(runtime.bytes))
      )
      if (manifest.mode === "host") return true
    } else {
      const file = readRuntimeScopedFile(pluginRoot, BUSINESS_MOD_MANIFEST, 256 * 1024)
      if (file.bytes) {
        const catalog = parseBusinessModCatalog(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
        )
        if (catalog.kernel && describeBusinessModAssemblyRuntime(catalog.kernel).mode === "host")
          return true
      }
    }
    return isAutobizLegacyProjectRoot(pluginRoot)
  } catch {
    return false
  }
}
