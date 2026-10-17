import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, lstat, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { openStableFileHandle } from "../services/stable-file-handle"
import { MAX_ATTACHMENT_FILE_BYTES } from "../../shared/file-attachment"

const MAX_FILE_BYTES = 100 * 1024 * 1024

/**
 * Persist renderer-provided drag data without ever accepting a renderer path.
 * The composer has already bounded files to the parser's 5 MiB limit; repeat
 * that bound at the IPC boundary before materialising an ArrayBuffer on disk.
 */
export async function copyBotFileBytes(destination: string, bytes: ArrayBuffer): Promise<void> {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES)
    throw new Error("拖入文件无效或超过 5 MiB")
  const temporary = join(dirname(destination), `.${randomUUID()}.part`)
  try {
    await writeFile(temporary, new Uint8Array(bytes), { flag: "wx", mode: 0o600 })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/** Stream an authorized, stable inode. No whole-file buffer; partial outputs are never published. */
export async function copyBotFile(
  root: string,
  source: string,
  destination: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const file = await openStableFileHandle(root, source)
  const temporary = join(dirname(destination), `.${randomUUID()}.part`)
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error("单个文件不能超过 100 MiB")
    let bytes = 0
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > MAX_FILE_BYTES ? new Error("文件超过 100 MiB") : null, chunk)
      }
    })
    await pipeline(
      file.handle.createReadStream({ autoClose: false }),
      limit,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal }
    )
    await file.assertPathIdentity()
    const after = await file.handle.stat({ bigint: true })
    if (
      after.size !== file.identity.size ||
      after.mtimeNs !== file.identity.modifiedNs ||
      after.ctimeNs !== file.identity.changedNs
    )
      throw new Error("文件在复制过程中发生变化，请重试")
    signal?.throwIfAborted()
    await rename(temporary, destination)
  } finally {
    await file.handle.close()
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function botImportDestination(
  workspace: string,
  sourceName: string
): Promise<{ path: string; id: string }> {
  const directory = join(await realpath(workspace), "shared")
  await mkdir(directory, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("资料目录不能是符号链接")
  let name =
    basename(sourceName)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(-150) || "file"
  // A per-import directory keeps duplicate uploads distinct while preserving the
  // actual basename used by native browser uploads on Mac and Windows.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  const importId = randomUUID()
  const targetDirectory = join(directory, importId)
  await mkdir(targetDirectory)
  const id = `shared/${importId}/${name}`
  return { path: join(targetDirectory, name), id }
}
