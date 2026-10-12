import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs"
import { join, resolve } from "node:path"
import { boundedLogArguments, joinLogArguments } from "../log-format"

export const BOT_HOST_LOG_BYTES = 5 * 1024 * 1024
const BACKUPS = 2
const levels = ["log", "info", "warn", "error", "debug"] as const
type Level = (typeof levels)[number]
type ConsoleSink = Pick<Console, Level>

function stat(path: string) {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Owned by the Host lifetime-lock holder, with no inherited file descriptor.
 * Every write reopens the current name so rotation also works on Windows. Reuses
 * Cmb's console redaction/projection; logs are diagnostics, not action receipts. */
export class BotHostLog {
  private readonly root: string
  private readonly identity: { dev: bigint; ino: bigint }
  private omitted = 0
  constructor(
    private readonly directory: string,
    private readonly maxBytes = BOT_HOST_LOG_BYTES
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > BOT_HOST_LOG_BYTES)
      throw new Error("Invalid Host log capacity")
    this.root = realpathSync(directory)
    const info = lstatSync(this.root, { bigint: true })
    if (!info.isDirectory()) throw new Error("Host log root must be a directory")
    this.identity = { dev: info.dev, ino: info.ino }
  }

  private assertRoot(): void {
    const info = lstatSync(this.root, { bigint: true })
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== this.identity.dev ||
      info.ino !== this.identity.ino ||
      realpathSync(this.directory) !== this.root
    )
      throw new Error("Host log directory changed")
  }

  private file(index = 0): string {
    return join(this.root, index ? `host.log.${index}` : "host.log")
  }
  private assertFile(path: string) {
    const info = stat(path)
    if (
      info &&
      (!info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1n ||
        realpathSync(path) !== resolve(path))
    )
      throw new Error("Host log cannot use linked or special files")
    return info
  }

  private rotate(): void {
    this.assertRoot()
    for (let index = 0; index <= BACKUPS; index++) this.assertFile(this.file(index))
    for (let index = BACKUPS; index >= 1; index--) {
      const from = this.file(index - 1),
        to = this.file(index)
      if (!this.assertFile(from)) continue
      if (this.assertFile(to)) unlinkSync(to)
      renameSync(from, to)
    }
  }

  /** A full or locked disk must not fail the Bot task. Failed diagnostics are
   * counted and reported on the next successful append; never grow an overflow queue. */
  append(level: Level, args: unknown[]): void {
    try {
      this.appendSafe(level, boundedLogArguments(args))
    } catch {
      this.omitted = Math.min(Number.MAX_SAFE_INTEGER, this.omitted + 1)
    }
  }

  private appendSafe(level: Level, args: unknown[]): void {
    this.assertRoot()
    const prefix = `[${new Date().toISOString()}] [${level}] [pid:${process.pid}] `
    const omission = this.omitted ? `[${this.omitted} earlier log entries unavailable] ` : ""
    const message = omission + joinLogArguments(args)
    // Keep UTF-8 intact and leave room for a clear truncation marker. The shared
    // formatter already bounds redaction work, recursion, field scans and text.
    const maxMessageBytes = this.maxBytes - Buffer.byteLength(prefix) - 32
    let text = message
    if (Buffer.byteLength(text) > maxMessageBytes) {
      let bytes = 0
      const characters: string[] = []
      for (const character of text) {
        const size = Buffer.byteLength(character)
        if (bytes + size > maxMessageBytes) break
        characters.push(character)
        bytes += size
      }
      text = characters.join("") + "…[log truncated]"
    }
    const line = Buffer.from(prefix + text + "\n"),
      path = this.file()
    const existing = this.assertFile(path)
    if (existing && Number(existing.size) + line.length > this.maxBytes) this.rotate()
    this.assertRoot()
    this.assertFile(path)
    const file = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    try {
      const info = fstatSync(file, { bigint: true }),
        current = this.assertFile(path)
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        !current ||
        info.dev !== current.dev ||
        info.ino !== current.ino ||
        Number(info.size) + line.length > this.maxBytes
      )
        throw new Error("Host log identity or capacity changed")
      fchmodSync(file, 0o600)
      let offset = 0
      while (offset < line.length) {
        const written = writeSync(file, line, offset, line.length - offset)
        if (!written) throw new Error("Host log write made no progress")
        offset += written
      }
      this.omitted = 0
    } finally {
      closeSync(file)
    }
  }

  install(target: ConsoleSink = console): () => void {
    const restore: (() => void)[] = []
    for (const level of levels) {
      const original = target[level]
      const wrapper = (...args: unknown[]): void => {
        try {
          const values = boundedLogArguments(args)
          try {
            this.appendSafe(level, values)
          } catch {
            this.omitted = Math.min(Number.MAX_SAFE_INTEGER, this.omitted + 1)
          }
          // stdout remains available to headless process supervisors. The
          // desktop launches with ignored stdio; the Host owns its log files.
          try {
            original.apply(target, values)
          } catch {
            /* A closed pipe must not stop work. */
          }
        } catch {
          this.omitted = Math.min(Number.MAX_SAFE_INTEGER, this.omitted + 1)
        }
      }
      target[level] = wrapper
      restore.push(() => {
        if (target[level] === wrapper) target[level] = original
      })
    }
    return () => {
      for (const undo of restore) undo()
    }
  }
}
