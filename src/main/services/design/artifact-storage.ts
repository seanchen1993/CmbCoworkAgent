import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

/** Stage all files before replacing anything. Put the HTML last as the commit point. */
export function writeDesignFilesAtomically(
  files: Array<{ filePath: string; content: string }>
): void {
  const staged: Array<{ filePath: string; temporary: string; previous?: Buffer }> = []
  const installed: typeof staged = []
  const replace = (filePath: string, content: string | Buffer) => {
    const temporary = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}-${randomUUID()}.tmp`
    )
    try {
      fs.writeFileSync(temporary, content, { flag: "wx" })
      fs.renameSync(temporary, filePath)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.filePath), { recursive: true })
      const entry = {
        filePath: file.filePath,
        temporary: path.join(
          path.dirname(file.filePath),
          `.${path.basename(file.filePath)}-${randomUUID()}.tmp`
        ),
        previous: fs.existsSync(file.filePath) ? fs.readFileSync(file.filePath) : undefined
      }
      staged.push(entry)
      fs.writeFileSync(entry.temporary, file.content, { flag: "wx" })
    }
    for (const entry of staged) {
      fs.renameSync(entry.temporary, entry.filePath)
      installed.push(entry)
    }
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const entry of installed.reverse()) {
      try {
        if (entry.previous === undefined) fs.rmSync(entry.filePath, { force: true })
        else replace(entry.filePath, entry.previous)
      } catch (rollback) {
        rollbackErrors.push(`${entry.filePath}: ${String(rollback)}`)
      }
    }
    if (rollbackErrors.length)
      throw new Error(`${String(error)}；恢复旧文件失败：${rollbackErrors.join("；")}`)
    throw error
  } finally {
    for (const entry of staged) fs.rmSync(entry.temporary, { force: true })
  }
}
