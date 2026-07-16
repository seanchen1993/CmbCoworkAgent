import { existsSync } from "fs"
import { join } from "path"
import { readPluginManifest } from "../plugins/manifest"
import { getPlugins } from "../storage"
import type { PluginManifest, PluginMetadata } from "../types"

export interface BrowserPluginRuntime {
  pluginId: string
  pluginName: string
  pluginRoot: string
  clientPath: string
}

export function isBrowserPluginManifest(manifest: PluginManifest): boolean {
  const name = manifest.name.trim().toLowerCase()
  const description = (manifest.description ?? "").toLowerCase()
  const keywords = (manifest.keywords ?? []).map((keyword) => keyword.toLowerCase())

  return (
    name === "browser" ||
    name === "openai-bundled/browser" ||
    keywords.includes("browser") ||
    keywords.includes("browser-use") ||
    description.includes("@browser") ||
    description.includes("browser-use")
  )
}

export function resolveBrowserPluginRuntime(
  plugin: Pick<PluginMetadata, "id" | "name" | "path">,
  manifest: PluginManifest
): BrowserPluginRuntime | null {
  if (!isBrowserPluginManifest(manifest)) return null

  const clientPath = join(plugin.path, "scripts", "browser-client.mjs")
  const skillsPath = join(plugin.path, "skills")
  if (!existsSync(clientPath) || !existsSync(skillsPath)) return null

  return {
    pluginId: plugin.id,
    pluginName: plugin.name,
    pluginRoot: plugin.path,
    clientPath
  }
}

export function getEnabledBrowserPluginRuntime(): BrowserPluginRuntime | null {
  for (const plugin of getPlugins()) {
    if (!plugin.enabled) continue
    const manifestResult = readPluginManifest(plugin.path)
    if (!manifestResult) continue
    const runtime = resolveBrowserPluginRuntime(plugin, manifestResult.manifest)
    if (runtime) return runtime
  }
  return null
}
