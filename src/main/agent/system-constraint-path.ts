import fs from "node:fs/promises"
import path from "node:path"
import { knowledgeRootDirectory } from "../services/knowledge-base-state"

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

/** Resolve a successful read to its plugin sys or managed knowledge file identity. */
export async function resolveSystemConstraintPath(
  pluginRoot: string | undefined,
  filePath: string
): Promise<string | null> {
  const normalizedFilePath = filePath.trim()
  if (!normalizedFilePath) return null

  try {
    const lexicalFile = path.resolve(normalizedFilePath)
    const normalizedPluginRoot = pluginRoot?.trim()
    if (normalizedPluginRoot) {
      const lexicalSystemRoot = path.resolve(normalizedPluginRoot, "sys")
      if (strictDescendantPath(lexicalSystemRoot, lexicalFile)) {
        const [systemRoot, physicalFile] = await Promise.all([
          fs.realpath(lexicalSystemRoot),
          fs.realpath(lexicalFile)
        ])
        const relativePath = strictDescendantPath(systemRoot, physicalFile)
        return relativePath ? `sys/${relativePath.split(path.sep).join("/")}` : null
      }
    }

    // Skip ordinary reads before touching the filesystem.
    const knowledgeRoot = knowledgeRootDirectory()
    if (!strictDescendantPath(knowledgeRoot, lexicalFile)) return null

    const [physicalKnowledgeRoot, physicalFile] = await Promise.all([
      fs.realpath(knowledgeRoot),
      fs.realpath(lexicalFile)
    ])
    const relativePath = strictDescendantPath(physicalKnowledgeRoot, physicalFile)
    if (!relativePath) return null
    // A shell search can name a directory without identifying the files it read.
    if (!(await fs.stat(physicalFile)).isFile()) return null
    return `knowledge/${relativePath.split(path.sep).join("/")}`
  } catch {
    return null
  }
}
