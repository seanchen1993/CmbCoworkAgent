import { randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { BotHostDescriptor } from "./transport-client"
import { BotDomainError } from "../../shared/bot-types"

type Identity = { dev: bigint; ino: bigint }
const lost = () =>
  new BotDomainError(
    "host_ownership_lost",
    "Bot 后台锁已丢失或位置发生变化，已停止执行，请重启后台"
  )
const sidecars = ["-journal", "-wal", "-shm"] as const
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino

/** A separate SQLite write lock is held for the process lifetime.
 * The OS releases it after a crash. A stale PID or torn JSON file is never lock authority.
 * This is deliberately separate from the domain DB, so normal transactions remain short.
 */
export class BotHostLock {
  private released = false
  private token: string | undefined
  private constructor(
    private readonly db: DatabaseSync | undefined,
    private readonly directory: string,
    private readonly path: string,
    private readonly identity: Identity,
    private readonly rootIdentity: Identity
  ) {}
  recoveryOwnershipIdentity(): {
    root: { dev: string; ino: string }
    lock: { dev: string; ino: string }
  } {
    this.assertCurrent()
    return {
      root: { dev: String(this.rootIdentity.dev), ino: String(this.rootIdentity.ino) },
      lock: { dev: String(this.identity.dev), ino: String(this.identity.ino) }
    }
  }

  private get descriptorPath(): string {
    return join(this.directory, "host.json")
  }

  /** A disposable child does not acquire a second OS lock. Pin the parent's
   * existing lock inode and recheck its descriptor separately before publication. */
  static observe(
    directory: string
  ): Pick<BotHostLock, "assertCurrent" | "checkCurrent" | "recoveryOwnershipIdentity"> {
    directory = realpathSync(directory)
    const root = lstatSync(directory, { bigint: true }),
      path = join(directory, "host-lock.sqlite"),
      identity = lstatSync(path, { bigint: true }),
      observer = new BotHostLock(undefined, directory, path, identity, root)
    observer.assertCurrent()
    return observer
  }

  static acquire(directory: string): BotHostLock | null {
    directory = realpathSync(directory)
    const rootIdentity = lstatSync(directory, { bigint: true })
    if (!rootIdentity.isDirectory()) throw lost()
    const path = join(directory, "host-lock.sqlite")
    try {
      const fd = openSync(path, "wx", 0o600)
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      if (process.platform !== "win32") {
        const parent = openSync(directory, "r")
        try {
          fsyncSync(parent)
        } finally {
          closeSync(parent)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const identity = lstatSync(path, { bigint: true })
    if (!identity.isFile() || identity.nlink !== 1n) throw lost()
    for (const suffix of sidecars) {
      try {
        const info = lstatSync(path + suffix)
        if (!info.isFile() || info.nlink !== 1) throw lost()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    const db = new DatabaseSync(path)
    try {
      db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE")
      const lock = new BotHostLock(db, directory, path, identity, rootIdentity)
      lock.assertCurrent()
      return lock
    } catch (error) {
      db.close()
      const code = (error as { errcode?: number }).errcode
      if (code === 5 || code === 6) return null // SQLITE_BUSY / SQLITE_LOCKED
      throw error
    }
  }

  /** Constant-size checks immediately before a synchronous owned mutation. */
  assertCurrent(): void {
    try {
      const root = lstatSync(this.directory, { bigint: true }),
        info = lstatSync(this.path, { bigint: true })
      if (
        this.released ||
        !root.isDirectory() ||
        !same(root, this.rootIdentity) ||
        realpathSync(this.directory) !== this.directory ||
        !info.isFile() ||
        info.nlink !== 1n ||
        !same(info, this.identity)
      )
        throw lost()
      for (const suffix of sidecars)
        try {
          const sidecar = lstatSync(this.path + suffix)
          if (!sidecar.isFile() || sidecar.nlink !== 1) throw lost()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
    } catch {
      throw lost()
    }
  }

  /** RPC admission uses asynchronous metadata reads, never synchronous scans. */
  async checkCurrent(): Promise<void> {
    try {
      const [root, info, canonical, sidecarInfo] = await Promise.all([
        lstat(this.directory, { bigint: true }),
        lstat(this.path, { bigint: true }),
        realpath(this.directory),
        Promise.all(
          sidecars.map((suffix) =>
            lstat(this.path + suffix, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null
              throw error
            })
          )
        )
      ])
      if (
        this.released ||
        !root.isDirectory() ||
        !same(root, this.rootIdentity) ||
        canonical !== this.directory ||
        !info.isFile() ||
        info.nlink !== 1n ||
        !same(info, this.identity) ||
        sidecarInfo.some((value) => value && (!value.isFile() || value.nlink !== 1n))
      )
        throw lost()
    } catch {
      throw lost()
    }
  }

  publish(descriptor: BotHostDescriptor): void {
    if (this.released) throw new Error("Bot Host lock has been released")
    this.assertCurrent()
    if (descriptor.pid !== process.pid || (this.token && this.token !== descriptor.token))
      throw new Error("Bot Host descriptor owner mismatch")
    this.token = descriptor.token
    const temporary = `${this.descriptorPath}.${randomUUID()}.tmp`
    let cleanupError: unknown
    try {
      const file = openSync(temporary, "wx", 0o600)
      try {
        writeFileSync(file, JSON.stringify(descriptor))
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      // A reader sees the previous complete document or the new complete document.
      this.assertCurrent()
      renameSync(temporary, this.descriptorPath)
    } finally {
      try {
        unlinkSync(temporary)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error
      }
    }
    if (cleanupError) throw cleanupError
  }

  release(): void {
    if (this.released) return
    let owned = true
    try {
      this.assertCurrent()
    } catch {
      owned = false
    }
    this.released = true
    try {
      if (owned && this.token) {
        const info = lstatSync(this.descriptorPath)
        if (!info.isFile() || info.nlink !== 1) return
        const current = JSON.parse(readFileSync(this.descriptorPath, "utf8")) as BotHostDescriptor
        if (current.token === this.token && current.pid === process.pid)
          unlinkSync(this.descriptorPath)
      }
    } catch {
      // Invalid descriptors are replaced atomically by the next lock owner.
    } finally {
      this.db?.close()
    }
  }
}
