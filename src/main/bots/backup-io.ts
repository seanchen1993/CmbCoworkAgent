import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { assertBackupIoCurrent, observedBackupIo } from "./backup-io-observer"

export async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== resolve(path))
    throw new Error("备份目录不能是符号链接")
  await syncDirectory(dirname(path))
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not support fsync on directory handles. File flushes and the
  // durable recovery journal still protect process crashes on that platform.
  if (process.platform === "win32") return
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function readPrivateJson(root: string, name: string, max = 32 * 1024 * 1024) {
  const file = await openStableFileHandle(root, join(root, name))
  try {
    const bytes = await readStableFileHandleBounded(file, max)
    return {
      value: JSON.parse(bytes.toString()) as unknown,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
  } finally {
    await file.handle.close()
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const pending = `${path}.pending`
  // An EEXIST failure does not grant ownership of another writer's pending file.
  const handle = await open(pending, "wx", 0o600)
  let ownsPending = true,
    failed = false
  try {
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(pending, path)
    ownsPending = false
    // Once renamed, keep the committed target even if this durability check fails.
    await syncDirectory(dirname(path))
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (ownsPending)
      await unlink(pending).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && !failed) throw error
      })
  }
}

type BackupFileIntegrityReason =
  | "non-regular"
  | "hard-link"
  | "identity"
  | "metadata"
  | "size"
  | "digest"

function backupFileStat(info: BigIntStats) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    nlink: String(info.nlink),
    size: String(info.size),
    mode: String(info.mode),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs)
  }
}

/** Diagnostic-only cause: no file contents, full hash, credentials or absolute path.
 * Built only after an existing guard fails; it does not change admission or retry. */
function backupFileIntegrityFailure(
  relative: string,
  reason: BackupFileIntegrityReason,
  details: Record<string, unknown>
): Error {
  return new Error(`恢复文件校验失败：${relative}`, {
    cause: { code: "bot_backup_file_integrity", reason, ...details }
  })
}

/** Hash prepared private bytes without creating a second database-sized copy.
 * Unlike a preview, restore verification rejects links and changed metadata. */
export async function hashBackupFile(
  root: string,
  relative: string,
  expected?: { size: number; sha256: string }
): Promise<{ path: string; size: number; sha256: string }> {
  const path = join(root, relative),
    info = await lstat(path, { bigint: true })
  if (!info.isFile() || info.nlink !== 1n || (await realpath(path)) !== resolve(path))
    throw backupFileIntegrityFailure(
      relative,
      !info.isFile() ? "non-regular" : info.nlink !== 1n ? "hard-link" : "identity",
      { phase: "initial", initial: backupFileStat(info) }
    )
  const input = await openStableFileHandle(root, path)
  try {
    if (
      input.identity.device !== info.dev ||
      input.identity.inode !== info.ino ||
      input.size > 20 * 1024 ** 3 ||
      (expected && input.size !== expected.size)
    )
      throw backupFileIntegrityFailure(
        relative,
        input.identity.device !== info.dev || input.identity.inode !== info.ino
          ? "identity"
          : "size",
        {
          phase: "opened",
          initial: backupFileStat(info),
          opened: {
            dev: String(input.identity.device),
            ino: String(input.identity.inode),
            size: input.size
          },
          expectedSize: expected?.size
        }
      )
    const hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, input.size)))
    let size = 0
    for (;;) {
      assertBackupIoCurrent()
      const { bytesRead } = await input.handle.read(buffer, 0, buffer.length, size)
      if (!bytesRead) break
      size += bytesRead
      if (size > input.size)
        throw backupFileIntegrityFailure(relative, "size", {
          phase: "read",
          initial: backupFileStat(info),
          openedSize: input.size,
          readSize: size
        })
      hash.update(buffer.subarray(0, bytesRead))
      observedBackupIo(bytesRead)
    }
    await input.assertPathIdentity()
    const final = await input.handle.stat({ bigint: true }),
      current = await lstat(path, { bigint: true }),
      sha256 = hash.digest("hex")
    if (
      final.nlink !== 1n ||
      current.nlink !== 1n ||
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      final.ctimeNs !== info.ctimeNs ||
      final.mtimeNs !== info.mtimeNs ||
      size !== input.size ||
      (expected && sha256 !== expected.sha256)
    ) {
      const checks = {
        hardLink: final.nlink !== 1n || current.nlink !== 1n,
        identity: current.dev !== info.dev || current.ino !== info.ino,
        ctimeChanged: final.ctimeNs !== info.ctimeNs,
        mtimeChanged: final.mtimeNs !== info.mtimeNs,
        sizeMismatch: size !== input.size,
        digestMismatch: expected !== undefined && sha256 !== expected.sha256
      }
      const reason = checks.hardLink
        ? "hard-link"
        : checks.identity
          ? "identity"
          : checks.ctimeChanged || checks.mtimeChanged
            ? "metadata"
            : checks.sizeMismatch
              ? "size"
              : "digest"
      throw backupFileIntegrityFailure(relative, reason, {
        phase: "final",
        checks,
        initial: backupFileStat(info),
        final: backupFileStat(final),
        current: backupFileStat(current),
        openedSize: input.size,
        readSize: size,
        expectedSize: expected?.size
      })
    }
    return { path: relative, size, sha256 }
  } finally {
    await input.handle.close()
  }
}

/** Copy through Cmb's stable handle, hash every byte, and flush before publication. */
export async function copyBackupFile(
  sourceRoot: string,
  relative: string,
  destinationRoot: string,
  expected?: { size: number; sha256: string },
  max = 20 * 1024 ** 3
): Promise<{ path: string; size: number; sha256: string }> {
  const input = await openStableFileHandle(sourceRoot, join(sourceRoot, relative))
  const destination = join(destinationRoot, relative)
  let created = false
  try {
    if (input.size > max || (expected && input.size !== expected.size))
      throw new Error(`备份文件大小不匹配：${relative}`)
    await privateDirectory(dirname(destination))
    const output = await open(destination, "wx", 0o600)
    created = true
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, input.size)))
    let size = 0
    try {
      for (;;) {
        assertBackupIoCurrent()
        const { bytesRead } = await input.handle.read(buffer, 0, buffer.length, size)
        if (!bytesRead) break
        size += bytesRead
        if (size > max || (expected && size > expected.size)) throw new Error("备份文件过大")
        const part = buffer.subarray(0, bytesRead)
        hash.update(part)
        await output.writeFile(part)
        observedBackupIo(bytesRead)
      }
      await input.assertPathIdentity()
      const sha256 = hash.digest("hex")
      if (
        size !== input.size ||
        (expected && (size !== expected.size || sha256 !== expected.sha256))
      )
        throw new Error(`备份文件校验失败：${relative}`)
      await output.sync()
      await syncDirectory(dirname(destination))
      return { path: relative, size, sha256 }
    } finally {
      await output.close()
    }
  } catch (error) {
    if (created) await unlink(destination).catch(() => {})
    throw error
  } finally {
    await input.handle.close()
  }
}
