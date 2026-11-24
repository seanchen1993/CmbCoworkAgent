import fs from "node:fs"
import path from "node:path"
import AdmZip from "adm-zip"
import { writeZipFromDirectoryStreaming } from "./streaming-zip"

function isTransientArtifactName(name: string): boolean {
  return (
    name.startsWith(".draft-") ||
    name.startsWith(".source-") ||
    name.startsWith(".direct-") ||
    name.startsWith(".patch-") ||
    name.includes(".projection-")
  )
}

/** Package the complete artifact tree, including transitive template dependencies. */
export function createDesignArtifactZip(
  rootDir: string,
  entryPath: string,
  htmlOverride?: string
): Buffer {
  const zip = new AdmZip()
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (isTransientArtifactName(entry.name)) continue
      const full = path.join(directory, entry.name)
      const relative = path.relative(rootDir, full).replace(/\\/g, "/")
      if (entry.isSymbolicLink()) throw new Error(`导出资源不可为符号链接：${relative}`)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile())
        zip.addFile(
          relative,
          htmlOverride !== undefined && path.resolve(full) === path.resolve(entryPath)
            ? Buffer.from(htmlOverride)
            : fs.readFileSync(full)
        )
    }
  }
  visit(rootDir)
  return zip.toBuffer()
}

export async function writeDesignArtifactZipToFile(
  rootDir: string,
  entryPath: string,
  outputPath: string,
  htmlOverride?: string
): Promise<{ fileCount: number; totalBytes: number }> {
  const relativeEntry = path.relative(path.resolve(rootDir), path.resolve(entryPath)).replace(/\\/g, "/")
  return writeZipFromDirectoryStreaming(rootDir, outputPath, {
    excludeEntry: (name) => isTransientArtifactName(name),
    entryOverride:
      htmlOverride !== undefined
        ? { relativePath: relativeEntry, content: htmlOverride }
        : undefined
  })
}
