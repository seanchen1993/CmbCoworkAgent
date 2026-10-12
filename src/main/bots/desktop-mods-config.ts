import { join } from "node:path"
import { existsSync } from "node:fs"
import { getModsGlobalEnabled, getPlugins } from "../storage"
import { readPluginManifest } from "../plugins/manifest"
import { readManagedModDeployment } from "../mods/policy-core"
import type { BotModsConfig } from "./mods-config"

/** Only installed plugin paths come from the desktop settings, never a model or renderer. */
export function desktopBotModsConfig(): BotModsConfig {
  return {
    enabled: getModsGlobalEnabled(),
    policy: readManagedModDeployment(join(__dirname, "../resources/mods-policy.json")),
    plugins: getPlugins()
      .filter((plugin) => {
        const manifest = readPluginManifest(plugin.path)?.manifest
        return Boolean(
          manifest?.mods || existsSync(join(plugin.path, manifest?.hooks ?? "hooks/hooks.json"))
        )
      })
      .map(({ id, name, path, enabled }) => ({ id, name, path, enabled: enabled === true }))
  }
}
