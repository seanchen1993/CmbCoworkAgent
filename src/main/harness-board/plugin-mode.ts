import { statSync } from "node:fs"
import { join } from "node:path"

export const HARNESS_BOARD_CONFIG_RELATIVE_PATH = join("board_core", "board_config.json")

export function isProjectModePluginRoot(pluginRoot: string): boolean {
  try {
    return statSync(join(pluginRoot, HARNESS_BOARD_CONFIG_RELATIVE_PATH)).isFile()
  } catch {
    return false
  }
}
