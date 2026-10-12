import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import type { BotHostLock } from "./host-lock"

type Authority = Pick<BotHostLock, "assertCurrent" | "recoveryOwnershipIdentity">
type Inode = Pick<BigIntStats, "dev" | "ino">
const same = (a: Inode, b: Inode) => a.dev === b.dev && a.ino === b.ino
const markerName = "owner.private.json"
const socketName = "rpc.sock"
const decimalIdentity = z
  .object({
    dev: z.string().regex(/^\d{1,30}$/),
    ino: z.string().regex(/^\d{1,30}$/)
  })
  .strict()
const markerSchema = z
  .object({
    version: z.literal(1),
    directoryHash: z.string().regex(/^[a-f0-9]{64}$/),
    authority: z.object({ root: decimalIdentity, lock: decimalIdentity }).strict(),
    namespace: decimalIdentity
  })
  .strict()
const unavailable = () =>
  new BotDomainError("host_socket_unavailable", "Bot 后台通信目录不可用，请检查临时目录和权限")
const unowned = () =>
  new BotDomainError(
    "host_socket_ownership_unknown",
    "Bot 后台通信目录归属无法确认，已保留原目录，请查看后台诊断"
  )
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const requiredInfo = (path: string): BigIntStats => {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    throw missing(error) ? unowned() : error
  }
}

export interface BotHostSocket {
  readonly path: string
  /** The POSIX namespace needs this extra fence before Node unlinks its socket. */
  assertCurrent(): void
  /** Normal shutdown/startup failure remove only this exact owned socket. */
  close(): void
}

/** Node truncates POSIX sockaddr_un paths. Count UTF-8 bytes, not JS characters. */
export function botHostSocketPath(
  temporaryDirectory: string,
  identity: string,
  platform: NodeJS.Platform
): string | null {
  if (!/^[a-f0-9]{24}$/.test(identity) || temporaryDirectory.includes("\0")) throw unavailable()
  if (platform === "win32") return `\\\\.\\pipe\\cmb-bot-${identity}`
  const path = join(temporaryDirectory, `cmb-bot-${identity}.sock`)
  return Buffer.byteLength(path) <= (platform === "linux" ? 107 : 103) ? path : null
}

/** Called under the existing physical Host lifetime lock. A fixed namespace is
 * reused after SIGKILL, so repeated crashes retain at most one marker/socket.
 * The small marked directory is intentionally retained after normal shutdown.
 * Missing/torn markers or a replaced data directory/lock are not ownership proof. */
export function prepareBotHostSocket(
  directory: string,
  identity: string,
  lock: Authority,
  options: {
    platform?: NodeJS.Platform
    privateBase?: string
  } = {}
): BotHostSocket {
  lock.assertCurrent()
  const platform = options.platform ?? process.platform
  const pipe = botHostSocketPath("", identity, "win32")!
  if (platform === "win32")
    return {
      path: pipe,
      assertCurrent() {
        lock.assertCurrent()
      },
      close() {
        // Node owns named-pipe closure; there is no filesystem socket to remove.
      }
    }
  const uid = process.getuid?.()
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw unavailable()
  const canonical = realpathSync(directory)
  const authority = lock.recoveryOwnershipIdentity()
  const directoryHash = createHash("sha256").update(canonical).digest("hex")
  const key = createHash("sha256")
    .update(JSON.stringify({ directoryHash, authority }))
    .digest("hex")
    .slice(0, 24)
  // /tmp's OS alias is canonicalized once. The private child itself may never be a symlink.
  const base = realpathSync(options.privateBase ?? "/tmp")
  const namespace = join(base, `cmb-bot-${uid}-${key}`)
  const path = join(namespace, socketName)
  if (Buffer.byteLength(path) > (platform === "linux" ? 107 : 103)) throw unavailable()
  const marker = join(namespace, markerName)
  let created = false
  try {
    mkdirSync(namespace, { mode: 0o700 })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const root = requiredInfo(namespace)
  const privateDirectory = (info: BigIntStats) =>
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    info.uid === BigInt(uid) &&
    (info.mode & 0o7777n) === 0o700n
  const checkRoot = () => {
    lock.assertCurrent()
    const current = requiredInfo(namespace)
    if (
      !privateDirectory(current) ||
      !same(root, current) ||
      realpathSync(namespace) !== namespace ||
      realpathSync(directory) !== canonical
    )
      throw unowned()
    if (JSON.stringify(lock.recoveryOwnershipIdentity()) !== JSON.stringify(authority))
      throw unowned()
  }
  const entries = () => {
    const handle = opendirSync(namespace)
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync())
        if (![markerName, socketName].includes(entry.name)) throw unowned()
    } finally {
      handle.closeSync()
    }
  }
  let markerIdentity: BigIntStats | undefined
  try {
    checkRoot()
    if (created) {
      const fd = openSync(
        marker,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      try {
        markerIdentity = fstatSync(fd, { bigint: true })
        const value = markerSchema.parse({
          version: 1,
          directoryHash,
          authority,
          namespace: { dev: String(root.dev), ino: String(root.ino) }
        })
        writeFileSync(fd, JSON.stringify(value))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const parent = openSync(namespace, "r")
      try {
        fsyncSync(parent)
      } finally {
        closeSync(parent)
      }
    }
    checkRoot()
    const info = requiredInfo(marker)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      info.uid !== BigInt(uid) ||
      (info.mode & 0o7777n) !== 0o600n ||
      info.size > 1024n
    )
      throw unowned()
    const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
    let value: z.infer<typeof markerSchema>
    try {
      if (!same(info, fstatSync(fd, { bigint: true }))) throw unowned()
      const bytes = Buffer.alloc(1025)
      const count = readSync(fd, bytes, 0, bytes.length, 0)
      if (count > 1024) throw unowned()
      value = markerSchema.parse(JSON.parse(bytes.subarray(0, count).toString("utf8")))
    } catch {
      throw unowned()
    } finally {
      closeSync(fd)
    }
    markerIdentity = info
    if (
      value.directoryHash !== directoryHash ||
      JSON.stringify(value.authority) !== JSON.stringify(authority) ||
      value.namespace.dev !== String(root.dev) ||
      value.namespace.ino !== String(root.ino)
    )
      throw unowned()
    const assertCurrent = () => {
      checkRoot()
      const current = requiredInfo(marker)
      if (
        !current.isFile() ||
        current.nlink !== 1n ||
        current.uid !== BigInt(uid) ||
        (current.mode & 0o7777n) !== 0o600n ||
        !same(info, current) ||
        current.size !== info.size ||
        current.mtimeNs !== info.mtimeNs
      )
        throw unowned()
      entries()
      try {
        const socket = lstatSync(path, { bigint: true })
        if (
          !socket.isSocket() ||
          socket.isSymbolicLink() ||
          socket.uid !== BigInt(uid) ||
          socket.nlink !== 1n
        )
          throw unowned()
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    const clearSocket = () => {
      assertCurrent()
      try {
        unlinkSync(path)
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    // The same physical SQLite lifetime lock excludes a live prior Host. A stale
    // socket is reclaimed only after exact namespace/marker ownership is proven.
    clearSocket()
    let closed = false
    return {
      path,
      assertCurrent,
      close() {
        if (closed) return
        clearSocket()
        closed = true
      }
    }
  } catch (error) {
    // A normal construction error can clean only nodes this call actually made.
    // SIGKILL during first provisioning can leave one unmarked directory; the
    // next owner refuses it rather than guessing that an empty foreign root is ours.
    if (created)
      try {
        checkRoot()
        entries()
        if (markerIdentity) {
          const current = lstatSync(marker, { bigint: true })
          if (!current.isFile() || !same(current, markerIdentity) || current.nlink !== 1n)
            throw unowned()
          unlinkSync(marker)
        }
        rmdirSync(namespace)
      } catch {
        /* Preserve ambiguous nodes and the original failure. */
      }
    throw missing(error) ? unowned() : error
  }
}
