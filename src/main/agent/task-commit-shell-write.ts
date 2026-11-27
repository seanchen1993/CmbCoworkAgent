import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"

// Capture only writes whose target and complete output are specified by the command.
// Shell telemetry also observes concurrent editor writes and cannot authorize commits.
export async function prepareLiteralTaskShellWrite(
  command: string,
  cwd: string,
  roots: readonly string[],
  getShell: () => Promise<string>
): Promise<{ file: string; before: Buffer | null; after: Buffer } | null> {
  const match = /^echo ([A-Za-z0-9_]+) *> *"([A-Za-z0-9_ .:/-]+)"$/.exec(command)
  if (!match || match[0] !== command) return null
  const file = path.resolve(cwd, match[2])
  const inside = roots.some((root) => {
    const relative = path.relative(root, file)
    return (
      relative &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative)
    )
  })
  if (!inside) return null
  try {
    const parent = path.dirname(file)
    if (path.relative(parent, await realpath(parent))) return null
    const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (entry && (!entry.isFile() || entry.size > 8 * 1024 * 1024)) return null
    const shell = path
      .basename(await getShell())
      .toLowerCase()
      .replace(/\.exe$/, "")
    const word = match[1]
    let after: Buffer
    if (shell === "powershell" && process.platform === "win32") {
      after = Buffer.from("\uFEFF" + word + "\r\n", "utf16le")
    } else if (shell === "pwsh") {
      after = Buffer.from(word + (process.platform === "win32" ? "\r\n" : "\n"))
    } else if (["bash", "sh", "zsh"].includes(shell)) {
      after = Buffer.from(word + "\n")
    } else {
      return null
    }
    return { file, before: entry ? await readFile(file) : null, after }
  } catch {
    return null
  }
}
