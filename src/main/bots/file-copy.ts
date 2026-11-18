import { createHash, randomUUID, type Hash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, lstat, realpath, rename, rm, writeFile, link } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import { Transform, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { openStableFileHandle } from "../services/stable-file-handle"
import { MAX_ATTACHMENT_FILE_BYTES } from "../../shared/file-attachment"

export const MAX_BOT_IMPORT_FILE_BYTES = 100 * 1024 * 1024

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
export function copyBotFile(
  root: string,
  source: string,
  destination: string,
  signal?: AbortSignal,
  maxBytes = MAX_BOT_IMPORT_FILE_BYTES
): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BOT_IMPORT_FILE_BYTES)
    throw new Error("文件导入大小限制无效")
  return copyStableBotFile(root, source, destination, signal, maxBytes)
}

/** Formal delivery copies and user-selected exports share supported sizes; other imports stay capped. */
export function exportBotFile(
  root: string,
  source: string,
  destination: string,
  signal?: AbortSignal,
  receipt?: { digest: string; size: number; beforeCommit(): void }
): Promise<void> {
  return copyStableBotFile(root, source, destination, signal, receipt?.size ?? Number.MAX_SAFE_INTEGER, receipt)
}

async function copyStableBotFile(
  root: string,
  source: string,
  destination: string,
  signal: AbortSignal | undefined,
  byteLimit: number,
  receipt?: { digest: string; size: number; beforeCommit(): void }
): Promise<void> {
  const temporary = join(dirname(destination), `.${randomUUID()}.part`)
  try {
    const digest = receipt ? createHash("sha256") : undefined
    const size = await streamBotFileCopy(root, source, temporary, signal, byteLimit, digest)
    if (receipt && (size !== receipt.size || digest?.digest("hex") !== receipt.digest))
      throw new Error("原交付附件的字节已变化。")
    signal?.throwIfAborted()
    receipt?.beforeCommit()
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
    if (file.size > byteLimit) throw new Error(`单个文件不能超过 ${byteLimit / 1024 / 1024} MiB`)
    let bytes = 0
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        digest?.update(chunk)
        callback(bytes > byteLimit ? new Error(`文件超过 ${byteLimit / 1024 / 1024} MiB`) : null, chunk)
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

async function ensureBotDeliveryDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error("附件目录不能是符号链接")
}

async function linkBotDeliverySnapshot(
  workspace: string,
  source: string,
  attachmentPath: string,
  digest: string,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  try {
    // Publish complete bytes without replacing a version already in use.
    await link(source, attachmentPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = await lstat(attachmentPath)
    if (!existing.isFile() || existing.isSymbolicLink() ||
        (await hashBotFile(workspace, attachmentPath, signal)) !== digest)
      throw new Error("已保存的附件发生变化，请重新交付")
  }
  signal.throwIfAborted()
  // On a case-insensitive filesystem the existing version can have another spelling.
  return realpath(attachmentPath)
}

/** Promote a snapshot made in this attachment operation's private staging directory. */
export async function publishStagedBotDeliveryFile(
  workspace: string, staging: string, source: string, signal: AbortSignal
): Promise<string> {
  const [directory, digest, name, ...tail] = relative(staging, source).split(sep)
  if (directory !== ".bot-deliveries" || !/^[a-f0-9]{64}$/.test(digest) || !name || tail.length)
    throw new Error("待保留的附件版本无效")
  const destination = join(await realpath(workspace), directory)
  await ensureBotDeliveryDirectory(destination)
  const contentDirectory = join(destination, digest)
  await ensureBotDeliveryDirectory(contentDirectory)
  return linkBotDeliverySnapshot(workspace, source, join(contentDirectory, name), digest, signal)
}

/** A public attachment keeps its sent bytes; the editable workspace file stays separate. */
export async function snapshotBotDeliveryFile(
  workspace: string,
  source: string,
  signal: AbortSignal,
  sourceWorkspace = workspace,
  byteLimit = Number.MAX_SAFE_INTEGER,
  expected?: { digest: string; size: number }
): Promise<{ attachmentPath: string; size: number }> {
  signal.throwIfAborted()
  const directory = join(await realpath(workspace), ".bot-deliveries")
  await ensureBotDeliveryDirectory(directory)
  if (expected) {
    if (!/^[a-f0-9]{64}$/.test(expected.digest) || expected.size > byteLimit)
      throw new Error("原附件版本无效或超出大小限制")
    const retained = join(directory, expected.digest, basename(source))
    const existing = await lstat(retained).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return undefined
    })
    if (existing) {
      await ensureBotDeliveryDirectory(dirname(retained))
      if (!existing.isFile() || existing.size !== expected.size ||
          await hashBotFile(workspace, retained, signal) !== expected.digest)
        throw new Error("已保存的附件发生变化，请重新交付")
      signal.throwIfAborted()
      return { attachmentPath: await realpath(retained), size: expected.size }
    }
  }
  const temporary = join(directory, `.${randomUUID()}.part`)
  try {
    const digest = createHash("sha256")
    // Delivery previously had no copy-size cap. Keep streaming and its existing
    // supported metadata range; imports and internal copies keep their own cap.
    const size = await streamBotFileCopy(
      sourceWorkspace,
      source,
      temporary,
      signal,
      byteLimit,
      digest
    )
    await ensureBotDeliveryDirectory(directory)
    const hash = digest.digest("hex")
    if (expected && (hash !== expected.digest || size !== expected.size))
      throw new Error("所选附件的保存版本不可用或已变化，请重新选择附件")
    const contentDirectory = join(directory, hash)
    await ensureBotDeliveryDirectory(contentDirectory)
    const attachmentPath = join(contentDirectory, basename(source))
    return { attachmentPath: await linkBotDeliverySnapshot(workspace, temporary, attachmentPath, hash, signal), size }
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
  sourceName: string,
  receiptKey?: string
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
  // Verified peer versions keep their identity through tool rebuilds/resumes.
  // Ordinary user uploads remain separate, even when their names/bytes match.
  const importId = receiptKey
    ? `peer-${createHash("sha256").update(receiptKey).digest("hex")}`
    : randomUUID()
  const targetDirectory = join(directory, importId)
  await mkdir(targetDirectory, { recursive: Boolean(receiptKey) })
  if ((await lstat(targetDirectory)).isSymbolicLink())
    throw new Error("资料目录不能是符号链接")
  const id = `shared/${importId}/${name}`
  return { path: join(targetDirectory, name), id }
}
