import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, open, opendir, realpath, utimes } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { openStableFileHandle } from "../services/stable-file-handle"
import { copyBackupFile, hashBackupFile, syncDirectory } from "./backup-io"
import { assertBackupIoCurrent, observedBackupIo } from "./backup-io-observer"

export const BOT_DIRECTORY_CHECKPOINT_FILES = 50_000
export const BOT_DIRECTORY_CHECKPOINT_BYTES = 20 * 1024 ** 3
const BOT_DIRECTORY_CHECKPOINT_METADATA_BYTES = 8 * 1024 ** 2
const portablePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) =>
    value
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          !/[\\<>:"|?*]/.test(part) &&
          [...part].every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
          ) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
const metadata = z.object({
  path: portablePath,
  mode: z.number().int().min(0).max(0o777),
  modifiedMs: z.number().finite().min(-8.64e15).max(8.64e15)
})
export const botDirectoryEntry = z.discriminatedUnion("kind", [
  metadata.extend({ kind: z.literal("directory") }).strict(),
  metadata
    .extend({
      kind: z.literal("file"),
      size: z.number().int().nonnegative().max(BOT_DIRECTORY_CHECKPOINT_BYTES),
      sha256: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict()
])
export const botDirectoryEntries = z.array(botDirectoryEntry).max(BOT_DIRECTORY_CHECKPOINT_FILES)
export type BotDirectoryEntry = z.infer<typeof botDirectoryEntry>
export interface BotDirectoryCheckpointOptions {
  maxEntries?: number
  maxBytes?: number
  /** Exclusions apply only to protocol-owned top-level metadata. They never
   * match nested ordinary files or silently exclude build/cache directories. */
  excludeRoot?: ReadonlySet<string>
  assertCurrent?: () => void
}
function limits(options: BotDirectoryCheckpointOptions) {
  const maxEntries = options.maxEntries ?? BOT_DIRECTORY_CHECKPOINT_FILES,
    maxBytes = options.maxBytes ?? BOT_DIRECTORY_CHECKPOINT_BYTES
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    maxEntries > BOT_DIRECTORY_CHECKPOINT_FILES ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > BOT_DIRECTORY_CHECKPOINT_BYTES
  )
    throw new Error("目录恢复预算无效")
  return { maxEntries, maxBytes }
}

const changed = () => new Error("工作文件在保存期间发生变化，请关闭外部编辑程序后重试")
const unsupported = () =>
  new Error("工作目录包含链接或特殊文件，未创建恢复点；请先将所需内容另存为普通文件")

function distinctTrees(source: string, destination: string): void {
  const contains = (a: string, b: string) => {
    const part = relative(resolve(a), resolve(b))
    return part === "" || (!part.startsWith("..") && !isAbsolute(part))
  }
  if (contains(source, destination) || contains(destination, source))
    throw new Error("恢复点与工作目录不能相互包含")
}

function validatedEntries(raw: unknown): BotDirectoryEntry[] {
  const entries = botDirectoryEntries.parse(raw),
    seen = new Map<string, BotDirectoryEntry>()
  let bytes = 0,
    metadataBytes = 0
  for (const entry of entries) {
    metadataBytes += Buffer.byteLength(JSON.stringify(entry))
    if (metadataBytes > BOT_DIRECTORY_CHECKPOINT_METADATA_BYTES)
      throw new Error("工作文件恢复清单超过 8 MiB 元数据上限")
    const key = process.platform === "win32" ? entry.path.toLowerCase() : entry.path
    if (seen.has(key)) throw new Error("工作文件恢复清单包含重复路径")
    seen.set(key, entry)
    if (entry.kind === "file") bytes += entry.size
  }
  if (bytes > BOT_DIRECTORY_CHECKPOINT_BYTES) throw new Error("工作文件恢复点超过 20 GiB 上限")
  for (const entry of entries) {
    const segments = entry.path.split("/")
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join("/"),
        key = process.platform === "win32" ? parent.toLowerCase() : parent
      if (seen.get(key)?.kind !== "directory") throw new Error("工作文件恢复清单缺少父目录")
    }
  }
  return entries
}

/** The owner holds the Host lifetime lock and supplies the pinned source root.
 * Reuse the backup byte-copy path; do not archive or follow links to other roots. */
async function snapshotBotDirectory(
  source: string,
  destination: string | undefined,
  assertCurrent: () => void,
  options: BotDirectoryCheckpointOptions = {}
): Promise<BotDirectoryEntry[]> {
  if (destination) distinctTrees(source, destination)
  assertCurrent()
  const root = await realpath(source)
  if (root !== resolve(source)) throw unsupported()
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory()) throw unsupported()
  const { maxEntries, maxBytes } = limits(options)
  const entries: BotDirectoryEntry[] = []
  let bytes = 0,
    metadataBytes = 0
  const append = (entry: BotDirectoryEntry) => {
    metadataBytes += Buffer.byteLength(JSON.stringify(entry))
    if (metadataBytes > BOT_DIRECTORY_CHECKPOINT_METADATA_BYTES)
      throw new Error("工作文件恢复清单超过 8 MiB 元数据上限")
    entries.push(entry)
  }
  if (destination) await mkdir(destination, { mode: 0o700 })
  const visit = async (relative: string): Promise<void> => {
    assertBackupIoCurrent()
    assertCurrent()
    if (entries.length >= maxEntries) throw new Error("工作文件恢复点超过 50000 个条目")
    portablePath.parse(relative)
    const path = join(root, relative),
      info = await lstat(path)
    if (
      info.isSymbolicLink() ||
      info.dev !== rootInfo.dev ||
      (!info.isDirectory() && !info.isFile()) ||
      (info.isFile() && info.nlink !== 1)
    )
      throw unsupported()
    if (info.isDirectory()) {
      append({
        kind: "directory",
        path: relative,
        mode: info.mode & 0o777,
        modifiedMs: info.mtimeMs
      })
      if (destination) await mkdir(join(destination, relative), { mode: 0o700 })
      const directory = await opendir(path)
      for await (const child of directory) await visit(`${relative}/${child.name}`)
      if (destination) await syncDirectory(join(destination, relative))
    } else {
      if (bytes + info.size > maxBytes) throw new Error("工作文件恢复点超过 20 GiB 上限")
      const copied = destination
        ? await copyBackupFile(root, relative, destination, undefined, maxBytes - bytes)
        : await hashBackupFile(root, relative)
      append({ ...copied, kind: "file", mode: info.mode & 0o777, modifiedMs: info.mtimeMs })
      bytes += copied.size
    }
    const after = await lstat(path)
    if (after.dev !== info.dev || after.ino !== info.ino || after.ctimeMs !== info.ctimeMs)
      throw changed()
    observedBackupIo()
  }
  const directory = await opendir(root)
  for await (const child of directory)
    if (!options.excludeRoot?.has(child.name)) await visit(child.name)
  // Check the whole source again so a change to an earlier file, or an extra
  // file created during traversal, cannot be silently omitted from the snapshot.
  await verifyBotDirectory(root, entries, true, options)
  assertCurrent()
  if (destination) await syncDirectory(destination)
  return entries
}

export const captureBotDirectory = (
  source: string,
  destination: string,
  assertCurrent: () => void,
  options: BotDirectoryCheckpointOptions = {}
) => snapshotBotDirectory(source, destination, assertCurrent, options)

/** Seal a freshly generated independent recovery tree without making a second
 * database/worktree-sized copy solely to compute its manifest. */
export const inspectBotDirectory = (
  source: string,
  assertCurrent: () => void,
  options: BotDirectoryCheckpointOptions = {}
) => snapshotBotDirectory(source, undefined, assertCurrent, options)

/** Verify complete topology and bytes, including empty directories. No repaired
 * or partial tree is reported as a successful restore. */
export async function verifyBotDirectory(
  root: string,
  raw: unknown,
  metadata = false,
  options: BotDirectoryCheckpointOptions = {}
): Promise<void> {
  const entries = validatedEntries(raw),
    expected = new Map(entries.map((entry) => [entry.path, entry]))
  if ((await realpath(root)) !== resolve(root) || !(await lstat(root)).isDirectory())
    throw unsupported()
  const rootInfo = await lstat(root)
  const { maxEntries, maxBytes } = limits(options)
  if (
    entries.length > maxEntries ||
    entries.reduce((n, entry) => n + (entry.kind === "file" ? entry.size : 0), 0) > maxBytes
  )
    throw changed()
  let visited = 0
  const visit = async (relative: string): Promise<void> => {
    assertBackupIoCurrent()
    options.assertCurrent?.()
    if (++visited > maxEntries) throw changed()
    const entry = expected.get(relative),
      path = join(root, relative),
      info = await lstat(path)
    if (!entry || info.isSymbolicLink() || info.dev !== rootInfo.dev) throw changed()
    if (metadata && ((info.mode & 0o777) !== entry.mode || info.mtimeMs !== entry.modifiedMs))
      throw changed()
    if (entry.kind === "directory") {
      if (!info.isDirectory()) throw changed()
      const directory = await opendir(path)
      for await (const child of directory) await visit(`${relative}/${child.name}`)
    } else {
      if (!info.isFile() || info.nlink !== 1 || info.size !== entry.size) throw changed()
      const opened = await openStableFileHandle(root, path)
      try {
        const initial = await opened.handle.stat({ bigint: true })
        if (initial.nlink !== 1n || opened.size !== entry.size) throw changed()
        const hash = createHash("sha256"),
          buffer = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, entry.size)))
        let offset = 0
        for (;;) {
          assertBackupIoCurrent()
          options.assertCurrent?.()
          const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, offset)
          if (!bytesRead) break
          offset += bytesRead
          if (offset > entry.size) throw changed()
          hash.update(buffer.subarray(0, bytesRead))
          observedBackupIo(bytesRead)
        }
        await opened.assertPathIdentity()
        const final = await opened.handle.stat({ bigint: true })
        if (
          initial.ctimeNs !== final.ctimeNs ||
          final.nlink !== 1n ||
          offset !== entry.size ||
          hash.digest("hex") !== entry.sha256
        )
          throw changed()
      } finally {
        await opened.handle.close()
      }
    }
    expected.delete(relative)
    observedBackupIo()
  }
  const directory = await opendir(root)
  for await (const child of directory)
    if (!options.excludeRoot?.has(child.name)) await visit(child.name)
  if (expected.size) throw changed()
}

export async function restoreBotDirectory(
  source: string,
  destination: string,
  raw: unknown,
  options: BotDirectoryCheckpointOptions = {}
): Promise<void> {
  distinctTrees(source, destination)
  const entries = validatedEntries(raw)
  await verifyBotDirectory(source, entries, false, options)
  await mkdir(destination, { mode: 0o700 })
  const directories = entries
    .filter((entry) => entry.kind === "directory")
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length)
  for (const entry of directories) {
    assertBackupIoCurrent()
    options.assertCurrent?.()
    await mkdir(join(destination, entry.path), { mode: 0o700 })
    observedBackupIo()
  }
  for (const entry of entries) {
    options.assertCurrent?.()
    if (entry.kind !== "file") continue
    await copyBackupFile(source, entry.path, destination, entry)
    const path = join(destination, entry.path)
    await utimes(path, entry.modifiedMs / 1000, entry.modifiedMs / 1000)
    // chmod preserves the Windows read-only flag as well as POSIX execute bits.
    await chmod(path, entry.mode)
    const file = await open(path, "r")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    observedBackupIo()
  }
  for (const entry of directories.reverse()) {
    assertBackupIoCurrent()
    options.assertCurrent?.()
    const path = join(destination, entry.path)
    await utimes(path, entry.modifiedMs / 1000, entry.modifiedMs / 1000)
    await chmod(path, entry.mode)
    await syncDirectory(path)
    observedBackupIo()
  }
  await verifyBotDirectory(destination, entries, false, options)
  await syncDirectory(destination)
  await syncDirectory(dirname(destination))
}
