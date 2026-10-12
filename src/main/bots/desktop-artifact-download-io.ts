import { createHash, type Hash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, open, realpath, link, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { BotDomainError } from "../../shared/bot-types"
import { BOT_FILE_CHUNK_BYTES } from "../../shared/bot-files"
import { openStableFileHandle, openStableWritableFileHandle } from "../services/stable-file-handle"
import { syncDirectory } from "./backup-io"
import type { DownloadIdentity, DownloadRecord } from "./desktop-artifact-download-ledger"

export const downloadIdentity = (info: BigIntStats): DownloadIdentity => ({
  device: String(info.dev),
  inode: String(info.ino),
  size: String(info.size),
  modified: String(info.mtimeNs),
  changed: String(info.ctimeNs)
})
export const sameDownloadInode = (info: BigIntStats, identity: DownloadIdentity) =>
  info.dev.toString() === identity.device && info.ino.toString() === identity.inode
export async function assertDownloadParent(
  target: NonNullable<DownloadRecord["target"]>
): Promise<void> {
  try {
    const info = await lstat(target.parent, { bigint: true })
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev.toString() !== target.parentDevice ||
      info.ino.toString() !== target.parentInode ||
      (await realpath(target.parent)) !== target.parent ||
      dirname(target.path) !== target.parent
    )
      throw new BotDomainError("download_destination_changed", "保存目录发生变化，请另存为新文件")
  } catch {
    throw new BotDomainError("download_destination_changed", "保存目录发生变化，请另存为新文件")
  }
}
export async function captureDownloadTarget(
  path: string
): Promise<NonNullable<DownloadRecord["target"]>> {
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    path.length > 4096 ||
    basename(path) === "." ||
    basename(path) === ".."
  )
    throw new BotDomainError("download_request_rejected", "保存位置无效")
  // OS choosers may return directory aliases (e.g. /var on macOS). Resolve
  // once at selection, then persist and recheck only the physical directory.
  // Retargeting the alias later must never redirect an admitted save.
  const parent = await realpath(dirname(resolve(path))),
    targetPath = join(parent, basename(path))
  const info = await lstat(parent, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new BotDomainError("download_destination_changed", "保存目录无效")
  try {
    await lstat(targetPath)
    throw new BotDomainError("download_destination_exists", "已有同名文件，请另存为新文件")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return {
    path: targetPath,
    parent,
    parentDevice: String(info.dev),
    parentInode: String(info.ino)
  }
}

export async function createDownloadStage(
  record: DownloadRecord
): Promise<NonNullable<DownloadRecord["stage"]>> {
  if (!record.target) throw new BotDomainError("download_request_rejected", "未选择保存位置")
  await assertDownloadParent(record.target)
  const path = join(record.target.parent, `.CMBDevClaw-save-${record.job.id}.part`)
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.sync()
    await syncDirectory(record.target.parent)
    return {
      path,
      identity: downloadIdentity(await handle.stat({ bigint: true }))
    }
  } finally {
    await handle.close()
  }
}

/** Re-hash prefix once on recovery; each new checkpoint uses hash.copy(), O(n) total. */
export async function openDownloadStage(
  record: DownloadRecord,
  signal: AbortSignal
): Promise<{
  handle: FileHandle
  hash: Hash
  assertIdentity(): Promise<void>
}> {
  if (!record.target || !record.stage)
    throw new BotDomainError("download_part_changed", "临时文件缺失，请另存为新文件")
  await assertDownloadParent(record.target)
  const input = await openStableWritableFileHandle(record.target.parent, record.stage.path)
  try {
    const current = await input.handle.stat({ bigint: true })
    if (
      !sameDownloadInode(current, record.stage.identity) ||
      current.size < BigInt(record.job.bytes) ||
      current.size > BigInt(record.job.bytes + BOT_FILE_CHUNK_BYTES)
    )
      throw new BotDomainError("download_part_changed", "临时文件发生变化，请另存为新文件")
    const hash = createHash("sha256"),
      bytes = Buffer.allocUnsafe(BOT_FILE_CHUNK_BYTES)
    for (let position = 0; position < record.job.bytes; ) {
      signal.throwIfAborted()
      const { bytesRead } = await input.handle.read(
        bytes,
        0,
        Math.min(bytes.length, record.job.bytes - position),
        position
      )
      if (!bytesRead)
        throw new BotDomainError("download_part_changed", "临时文件被截断，请另存为新文件")
      hash.update(bytes.subarray(0, bytesRead))
      position += bytesRead
    }
    if (hash.copy().digest("hex") !== record.prefixHash)
      throw new BotDomainError("download_part_changed", "临时文件校验失败，请另存为新文件")
    await input.assertPathIdentity()
    await assertDownloadParent(record.target)
    signal.throwIfAborted()
    if (current.size > BigInt(record.job.bytes)) {
      await input.handle.truncate(record.job.bytes)
      await input.handle.sync()
    }
    return {
      handle: input.handle,
      hash,
      assertIdentity: async () => {
        await input.assertPathIdentity()
        await assertDownloadParent(record.target!)
      }
    }
  } catch (error) {
    await input.handle.close()
    throw error
  }
}

export async function hashDownloadFile(
  path: string,
  target: NonNullable<DownloadRecord["target"]>,
  identity: DownloadIdentity,
  size: number,
  signal: AbortSignal,
  allowKnownPublishedLink = false
): Promise<string> {
  await assertDownloadParent(target)
  const input = await openStableFileHandle(target.parent, path)
  try {
    const initial = await input.handle.stat({ bigint: true })
    if (
      !sameDownloadInode(initial, identity) ||
      !initial.isFile() ||
      initial.size !== BigInt(size) ||
      initial.nlink !== (allowKnownPublishedLink ? 2n : 1n)
    )
      throw new BotDomainError("download_part_changed", "保存文件身份发生变化，请核对后另存")
    const hash = createHash("sha256"),
      bytes = Buffer.allocUnsafe(BOT_FILE_CHUNK_BYTES)
    for (let position = 0; position < size; ) {
      signal.throwIfAborted()
      const { bytesRead } = await input.handle.read(
        bytes,
        0,
        Math.min(bytes.length, size - position),
        position
      )
      if (!bytesRead) throw new BotDomainError("download_part_changed", "保存文件被截断")
      hash.update(bytes.subarray(0, bytesRead))
      position += bytesRead
    }
    const final = await input.handle.stat({ bigint: true })
    if (
      initial.mtimeNs !== final.mtimeNs ||
      initial.ctimeNs !== final.ctimeNs ||
      initial.size !== final.size
    )
      throw new BotDomainError("download_part_changed", "保存文件在校验期间发生变化")
    await input.assertPathIdentity()
    await assertDownloadParent(target)
    return hash.digest("hex")
  } finally {
    await input.handle.close()
  }
}

/** Atomically create an absent destination. Existing targets are never overwritten. */
export async function publishDownload(
  record: DownloadRecord,
  signal: AbortSignal
): Promise<DownloadIdentity> {
  if (!record.intent || !record.stage || !record.target)
    throw new BotDomainError("download_publish_unknown", "保存发布记录不完整，请核对")
  await assertDownloadParent(record.target)
  const stage = await lstat(record.stage.path, { bigint: true })
  if (
    !stage.isFile() ||
    stage.isSymbolicLink() ||
    stage.nlink !== 1n ||
    !sameDownloadInode(stage, record.intent.identity) ||
    stage.size !== BigInt(record.job.total)
  )
    throw new BotDomainError("download_part_changed", "临时文件发生变化，请另存为新文件")
  await assertDownloadParent(record.target)
  signal.throwIfAborted()
  try {
    await link(record.stage.path, record.target.path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST")
      throw new BotDomainError("download_destination_exists", "已有同名文件，请另存为新文件")
    if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code ?? ""))
      throw new BotDomainError(
        "download_publish_unavailable",
        "该文件系统不支持安全发布，请换用本地保存目录"
      )
    throw error
  }
  await syncDirectory(record.target.parent)
  await assertDownloadParent(record.target)
  const target = await lstat(record.target.path, { bigint: true })
  if (
    !target.isFile() ||
    target.isSymbolicLink() ||
    !sameDownloadInode(target, record.intent.identity)
  )
    throw new BotDomainError("download_publish_unknown", "保存目标在发布期间发生变化，请核对")
  return downloadIdentity(target)
}

/** Remove only the exact owned stage; never the published target or a replaced path. */
export async function cleanupDownloadStage(record: DownloadRecord): Promise<boolean> {
  if (!record.stage || !record.target) return true
  await assertDownloadParent(record.target)
  try {
    const info = await lstat(record.stage.path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || !sameDownloadInode(info, record.stage.identity))
      return false
    if (
      info.nlink !== 1n &&
      !(record.published && info.nlink === 2n && sameDownloadInode(info, record.published))
    )
      return false
    await unlink(record.stage.path)
    await syncDirectory(record.target.parent)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
}
