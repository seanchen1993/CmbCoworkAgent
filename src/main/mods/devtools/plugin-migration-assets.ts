import { lstat, readdir } from "node:fs/promises"
import { join, relative as relativePath } from "node:path"
import { createHash } from "node:crypto"
import type { PluginMetadata } from "../../types"
import { normalizePluginRelativePath } from "../../plugins/manifest"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"

function allowed(path: string): boolean {
  return (
    /^(skills|commands|scripts|hooks)\//.test(path) &&
    /\.(?:md|ts|tsx|js|jsx|py)$/.test(path) &&
    !path
      .split("/")
      .some(
        (part) =>
          part.startsWith(".") || /(?:credential|secret|token|api[-_]?key|password)/i.test(part)
      )
  )
}
function selected(plugins: PluginMetadata[], id: string): PluginMetadata {
  const plugin = plugins.find((item) => item.id === id)
  if (!plugin) throw Error("DEVELOPMENT_PLUGIN_MISSING")
  return { ...plugin }
}

/** Inspect names only. Configuration, environment, binary assets and symlinks are excluded. */
export async function listMigrationAssets(plugins: PluginMetadata[], id: string) {
  const plugin = selected(plugins, id)
  const files: string[] = []
  let visited = 0
  let truncated = false
  const scan = async (relative: string, depth: number) => {
    if (depth > 4 || visited >= 256) {
      truncated = true
      return
    }
    const directory = join(plugin.path, relative)
    const stat = await lstat(directory).catch(() => undefined)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 256) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules")
        continue
      const path = `${relative}/${entry.name}`
      if (entry.isDirectory()) await scan(path, depth + 1)
      else if (entry.isFile() && allowed(path)) files.push(path)
    }
  }
  for (const root of ["skills", "commands", "scripts", "hooks"]) await scan(root, 0)
  return {
    pluginId: plugin.id,
    files: files.sort(),
    truncated,
    excluded: ["credentials", "configuration", "symlinks", "binary-assets"]
  }
}

/** File content is untrusted migration input, never executable instructions to this service. */
export async function readMigrationAsset(plugins: PluginMetadata[], id: string, path: string) {
  const plugin = selected(plugins, id)
  const relative = normalizePluginRelativePath(path)
  if (!relative || relative !== path || !allowed(relative)) throw Error("DEVELOPMENT_ASSET_PATH")
  const opened = await openStableFileHandle(plugin.path, join(plugin.path, relative))
  try {
    // The stable handle proves containment; also reject aliases into excluded paths in this package.
    if (
      relativePath(opened.rootPath, opened.filePath).split("\\").join("/") !== relative ||
      (await opened.handle.stat()).nlink !== 1
    )
      throw Error("DEVELOPMENT_ASSET_PATH")
    const bytes = await readStableFileHandleBounded(opened, 65536)
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return {
      pluginId: id,
      path: relative,
      digest: createHash("sha256").update(bytes).digest("hex"),
      text,
      untrustedSource: true,
      originalPreserved: true
    }
  } finally {
    await opened.handle.close()
  }
}
