import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, opendir, realpath } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import {
  openStableFileHandle,
  readStableFileHandleBounded,
  StableBoundedReadError
} from "../../services/stable-file-handle"

/** Reject incomplete overlays instead of accepting a fingerprint of only their safe subset. */
export async function fingerprintAutobizWorkflow(
  workspace: string,
  signal?: AbortSignal
): Promise<string> {
  const check = () => signal?.throwIfAborted()
  check()
  const root = resolve(workspace)
  if (relative(root, await realpath(root)) !== "") throw Error("AUTOBIZ_WORKFLOW_LINK")
  const parent = join(root, ".autobizdevops")
  const overlay = join(parent, "workflow.d")
  const files: string[] = []
  const directories = new Map<string, BigIntStats>()
  let entries = 0
  const stat = async (path: string) => {
    check()
    const item = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    check()
    if (item?.isSymbolicLink()) throw Error("AUTOBIZ_WORKFLOW_LINK")
    return item
  }
  const visit = async (path: string, depth: number): Promise<void> => {
    check()
    if (++entries > 2048 || depth > 24) throw Error("AUTOBIZ_WORKFLOW_LIMIT")
    const before = await stat(path)
    if (!before) throw Error("AUTOBIZ_WORKFLOW_CHANGED")
    if (relative(path, await realpath(path)) !== "") throw Error("AUTOBIZ_WORKFLOW_LINK")
    if (before.isFile()) {
      if (files.length >= 512) throw Error("AUTOBIZ_WORKFLOW_LIMIT")
      files.push(path)
      return
    }
    if (!before.isDirectory()) throw Error("AUTOBIZ_WORKFLOW_FILE_TYPE")
    directories.set(path, before)
    const directory = await opendir(path)
    for await (const entry of directory) await visit(join(path, entry.name), depth + 1)
    const after = await stat(path)
    if (
      !after ||
      !after.isDirectory() ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw Error("AUTOBIZ_WORKFLOW_CHANGED")
  }
  const parentStat = await stat(parent)
  if (parentStat) {
    if (!parentStat.isDirectory()) throw Error("AUTOBIZ_WORKFLOW_FILE_TYPE")
    if (await stat(overlay)) await visit(overlay, 0)
  }
  files.sort((left, right) => left.localeCompare(right))
  const digest = createHash("sha256")
  let bytes = 0
  for (const path of files) {
    check()
    // Stable reads cap allocation before I/O and reject a changed inode or content.
    const opened = await openStableFileHandle(root, path)
    try {
      if (relative(path, opened.filePath) !== "") throw Error("AUTOBIZ_WORKFLOW_LINK")
      const data = await readStableFileHandleBounded(opened, 8 * 1024 * 1024 - bytes)
      check()
      const current = await stat(path)
      if (
        !current ||
        current.ino !== opened.identity.inode ||
        current.dev !== opened.identity.device
      )
        throw Error("AUTOBIZ_WORKFLOW_CHANGED")
      if (relative(path, await realpath(path)) !== "") throw Error("AUTOBIZ_WORKFLOW_LINK")
      bytes += data.byteLength
      digest.update(relative(overlay, path).replaceAll("\\", "/"))
      digest.update("\0")
      digest.update(data)
      digest.update("\0")
    } catch (error) {
      if (error instanceof StableBoundedReadError)
        throw Error(
          error.failure === "changed" ? "AUTOBIZ_WORKFLOW_CHANGED" : "AUTOBIZ_WORKFLOW_LIMIT"
        )
      throw error
    } finally {
      await opened.handle.close()
    }
  }
  // Recheck directory membership after reading files: adding/removing an overlay
  // during those reads must not produce a fingerprint of an incomplete tree.
  for (const [path, before] of directories) {
    const after = await stat(path)
    if (after && relative(path, await realpath(path)) !== "") throw Error("AUTOBIZ_WORKFLOW_LINK")
    if (
      !after ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw Error("AUTOBIZ_WORKFLOW_CHANGED")
  }
  if (!directories.has(overlay) && (await stat(overlay))) throw Error("AUTOBIZ_WORKFLOW_CHANGED")
  check()
  return digest.digest("hex")
}
