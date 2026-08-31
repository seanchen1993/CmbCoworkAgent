import fs from "node:fs/promises"
import path from "node:path"

function strictDescendantPath(root: string, target: string): string | null {
  const relativePath = path.relative(root, target)
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null
  }
  return relativePath
}

/**
 * Resolve a successfully-read file to its plugin-maintained system-constraint
 * identity. Only the physical target under `<pluginRoot>/sys/**` is accepted;
 * resolving both sides prevents `..` and symlinked-parent escapes.
 */
export async function resolvePluginSystemConstraintPath(
  pluginRoot: string,
  filePath: string
): Promise<string | null> {
  const normalizedPluginRoot = pluginRoot.trim()
  const normalizedFilePath = filePath.trim()
  if (!normalizedPluginRoot || !normalizedFilePath) return null

  try {
    const lexicalSystemRoot = path.resolve(normalizedPluginRoot, "sys")
    const lexicalFile = path.resolve(normalizedFilePath)
    // Ordinary workspace reads never touch `<plugin>/sys`, so reject them
    // without filesystem I/O. Candidate constraint paths still go through the
    // physical realpath check below to prevent symlink escapes.
    if (!strictDescendantPath(lexicalSystemRoot, lexicalFile)) return null

    const [systemRoot, physicalFile] = await Promise.all([
      fs.realpath(lexicalSystemRoot),
      fs.realpath(lexicalFile)
    ])
    const relativePath = strictDescendantPath(systemRoot, physicalFile)
    if (!relativePath) return null
    return `sys/${relativePath.split(path.sep).join("/")}`
  } catch {
    return null
  }
}
