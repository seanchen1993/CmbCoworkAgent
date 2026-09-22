import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, isAbsolute } from "node:path"
import { promisify } from "node:util"
import AdmZip from "adm-zip"

export const AUTOBIZ_KANBAN_SOURCE = "C:\\ai\\autobiz_kanban"
export const AUTOBIZ_KANBAN_COMMIT = "8db1ec937d6ed3d271cb9dc540310d6633c91e70"
const execute = promisify(execFile)

/** Imports only immutable Git objects, never Python files in the source working tree. */
export async function withPinnedAutobiz<T>(
  signal: AbortSignal | undefined,
  run: (source: string) => Promise<T>
): Promise<T> {
  const { stdout } = await execute("git", [
    "--no-replace-objects", "-C", AUTOBIZ_KANBAN_SOURCE,
    "archive", "--format=zip", AUTOBIZ_KANBAN_COMMIT
  ], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 10_000, windowsHide: true, signal })
  signal?.throwIfAborted()
  const root = await mkdtemp(join(tmpdir(), "cmb-autobiz-source-"))
  try {
    const entries = new AdmZip(stdout).getEntries()
    if (entries.length > 4096) throw Error("AUTOBIZ_SOURCE_LIMIT")
    let size = 0
    for (const entry of entries) {
      const path = resolve(root, entry.entryName)
      const child = relative(root, path)
      if (!child || isAbsolute(child) || child === ".." || child.startsWith("..\\") || child.startsWith("../"))
        throw Error("AUTOBIZ_SOURCE_PATH")
      if (entry.isDirectory) continue
      size += entry.header.size
      if (size > 64 * 1024 * 1024) throw Error("AUTOBIZ_SOURCE_LIMIT")
      signal?.throwIfAborted()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, entry.getData(), { flag: "wx" })
    }
    return await run(root)
  } finally {
    // root was allocated by mkdtemp under this exact parent; never clean a caller's path.
    if (dirname(root) === tmpdir() && root.startsWith(join(tmpdir(), "cmb-autobiz-source-")))
      await rm(root, { recursive: true, force: true })
  }
}
