import fs from "node:fs"
import path from "node:path"
import AdmZip from "adm-zip"

/** Package the complete artifact tree, including transitive template dependencies. */
export function createDesignArtifactZip(
  rootDir: string,
  entryPath: string,
  htmlOverride?: string
): Buffer {
  const zip = new AdmZip()
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".draft-") || entry.name.startsWith(".source-")) continue
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
