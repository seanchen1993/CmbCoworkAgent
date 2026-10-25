import { createHash, randomUUID, type Hash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, lstat, realpath, rename, rm, writeFile, link } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Transform, Writable } from "node:stream"
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
  const temporary = join(dirname(destination), `.${randomUUID()}.part`)
  try {
    await streamBotFileCopy(root, source, temporary, signal, MAX_FILE_BYTES)
    signal?.throwIfAborted()
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function streamBotFileCopy(
  root: string,
  source: string,
  temporary: string,
  signal: AbortSignal | undefined,
  byteLimit: number,
  digest?: Hash
): Promise<number> {
  signal?.throwIfAborted()
  const file = await openStableFileHandle(root, source)
  try {
    if (file.size > byteLimit) throw new Error("单个文件不能超过 100 MiB")
    let bytes = 0
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        digest?.update(chunk)
        callback(bytes > byteLimit ? new Error("文件超过 100 MiB") : null, chunk)
      }
    })
    await pipeline(
      // Bound a continuously appended file to its initial size plus one byte;
      // the identity check below rejects growth instead of following it forever.
      file.handle.createReadStream({ autoClose: false, end: file.size }),
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
    return bytes
  } finally {
    await file.handle.close()
  }
}

/** A public attachment keeps its sent bytes; the editable workspace file stays separate. */
export async function snapshotBotDeliveryFile(
  workspace: string,
  source: string,
  signal: AbortSignal
): Promise<{ attachmentPath: string; size: number }> {
  signal.throwIfAborted()
  const directory = join(await realpath(workspace), ".bot-deliveries")
  const ensureDirectory = async (path: string) => {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("附件目录不能是符号链接")
  }
  await ensureDirectory(directory)
  const temporary = join(directory, `.${randomUUID()}.part`)
  try {
    const digest = createHash("sha256")
    // Delivery previously had no copy-size cap. Keep streaming and its existing
    // supported metadata range; the original import/export cap is unchanged.
    const size = await streamBotFileCopy(
      workspace,
      source,
      temporary,
      signal,
      Number.MAX_SAFE_INTEGER,
      digest
    )
    await ensureDirectory(directory)
    const hash = digest.digest("hex")
    const contentDirectory = join(directory, hash)
    await ensureDirectory(contentDirectory)
    const attachmentPath = join(contentDirectory, basename(source))
    signal.throwIfAborted()
    try {
      // An exclusive link publishes complete bytes without replacing the inode
      // of an identical attachment already open in the previewer.
      await link(temporary, attachmentPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const existing = await lstat(attachmentPath)
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        (await hashBotFile(workspace, attachmentPath, signal)) !== hash
      )
        throw new Error("已保存的附件发生变化，请重新交付")
    }
    await rm(temporary, { force: true })
    signal.throwIfAborted()
    return { attachmentPath, size }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/** Stable, streaming content comparison for a new public receipt, never all internal returns. */
export async function hashBotFile(
  root: string,
  source: string,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  const file = await openStableFileHandle(root, source)
  try {
    const digest = createHash("sha256")
    await pipeline(
      file.handle.createReadStream({ autoClose: false, end: file.size }),
      new Writable({
        write(chunk, _encoding, callback) {
          digest.update(chunk)
          callback()
        }
      }),
      { signal }
    )
    await file.assertPathIdentity()
    const after = await file.handle.stat({ bigint: true })
    if (
      after.size !== file.identity.size ||
      after.mtimeNs !== file.identity.modifiedNs ||
      after.ctimeNs !== file.identity.changedNs
    )
      throw new Error("文件在读取过程中发生变化，请重试")
    signal.throwIfAborted()
    return digest.digest("hex")
  } finally {
    await file.handle.close()
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
