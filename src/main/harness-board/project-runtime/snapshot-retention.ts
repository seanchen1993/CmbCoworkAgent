import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { runtimeDirectory, runtimeDirectoryIdentity } from "./safe-files"

const digestPattern = /^[a-f0-9]{64}$/
const owner = randomUUID()
interface ScopedLease {
  refs: number
  lease: SnapshotLease
  identity: string
}
const scopes = new AsyncLocalStorage<ReadonlyMap<string, ScopedLease>>()
const sharedPathLeases = new Map<string, { refs: number; lease: SnapshotLease; keep: boolean }>()
const passiveLeases = new Set<SnapshotLease>()
const ownedReaders = new Map<string, () => void>()
let observedBoot: string | undefined
let probingBoot: Promise<void> | undefined

/** Native OS identity, never a renderer timestamp, process age, or lease timeout. */
function bootIdentity(): string {
  return observedBoot ?? ""
}

function closeOwnedGate(root: string, identity: string, path: string, fd: number): void {
  try {
    const held = fstatSync(fd, { bigint: true })
    const current = lstatSync(path, { bigint: true })
    if (
      runtimeDirectoryIdentity(root) === identity &&
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === held.dev &&
      current.ino === held.ino
    )
      unlinkSync(path)
  } catch {
    /* A replaced gate belongs to somebody else; keep its protection. */
  } finally {
    closeSync(fd)
  }
}

/** Call from explicit maintenance/background initialization, never the normal capture hot path. */
export async function prepareSnapshotMaintenance(roots: readonly string[] = []): Promise<void> {
  probingBoot ??= (async () => {
    try {
      if (process.platform === "linux") {
        observedBoot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
        return
      }
      const executable =
        process.platform === "win32"
          ? join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe"
            )
          : "/usr/sbin/sysctl"
      const args =
        process.platform === "win32"
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"
            ]
          : ["-n", "kern.boottime"]
      observedBoot = (
        await new Promise<string>((resolve, reject) => {
          execFile(
            executable,
            args,
            { encoding: "utf8", timeout: 5000, windowsHide: true },
            (error, stdout) => (error ? reject(error) : resolve(stdout))
          )
        })
      )
        .trim()
        .slice(0, 256)
    } catch {
      observedBoot = ""
    }
  })()
  await probingBoot
  if (!bootIdentity()) probingBoot = undefined
  if (!bootIdentity()) return
  for (const stamp of ownedReaders.values()) stamp()
  for (const root of roots) {
    if (!existsSync(root)) continue
    const identity = runtimeDirectoryIdentity(root)
    const directory = metadata(root),
      lock = join(directory, "maintenance.lock")
    // A per-native-boot recovery gate serializes recovery, including between separate processes.
    // Its own prior-boot abandoned names never block a later boot.
    const recovery = join(
      directory,
      `recovery-${createHash("sha256").update(bootIdentity()).digest("hex")}.lock`
    )
    let recovering: number | undefined
    let fd: number | undefined
    try {
      recovering = openSync(recovery, "wx", 0o600)
      const removePriorBoot = (path: string, reader: boolean) => {
        if (ownedReaders.has(path)) return
        try {
          const before = lstatSync(path, { bigint: true })
          if (
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1n ||
            before.size > 65536n
          )
            return
          const value = JSON.parse(readFileSync(path, "utf8"))
          if (
            value.version !== 1 ||
            !Number.isSafeInteger(value.pid) ||
            value.pid <= 0 ||
            typeof value.owner !== "string" ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.owner) ||
            typeof value.boot !== "string" ||
            !value.boot ||
            value.boot.length > 256 ||
            Object.keys(value).some(
              (key) =>
                !(
                  reader
                    ? ["version", "pid", "owner", "boot", "reason", "digests"]
                    : ["version", "pid", "owner", "boot"]
                ).includes(key)
            ) ||
            (reader && (typeof value.reason !== "string" || value.reason.length > 160)) ||
            value.boot === bootIdentity()
          )
            return
          if (
            reader &&
            value.digests !== null &&
            (!Array.isArray(value.digests) ||
              value.digests.some(
                (digest: unknown) => typeof digest !== "string" || !digestPattern.test(digest)
              ))
          )
            return
          const current = lstatSync(path, { bigint: true })
          if (
            runtimeDirectoryIdentity(root) === identity &&
            current.dev === before.dev &&
            current.ino === before.ino
          )
            unlinkSync(path)
        } catch {
          /* Unknown/changed records are protection, never expiry candidates. */
        }
      }
      removePriorBoot(lock, false)
      fd = openSync(lock, "wx", 0o600)
      writeFileSync(
        fd,
        JSON.stringify({ version: 1, pid: process.pid, owner, boot: bootIdentity() })
      )
      fsyncSync(fd)
      for (const name of readdirSync(join(directory, "readers")))
        if (/^[a-f0-9-]{36}\.json$/.test(name))
          removePriorBoot(join(directory, "readers", name), true)
      const path = join(directory, "protocol-v1.json"),
        stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024)
        continue
      const protocol = JSON.parse(readFileSync(path, "utf8"))
      if (
        protocol.version !== 1 ||
        protocol.rootIdentity !== runtimeDirectoryIdentity(root) ||
        protocol.boot !== "" ||
        !Array.isArray(protocol.legacy) ||
        protocol.legacy.length > 64 ||
        protocol.legacy.some(
          (digest: unknown) => typeof digest !== "string" || !digestPattern.test(digest)
        )
      )
        continue
      const pending = join(directory, `protocol-${randomUUID()}.tmp`)
      writeFileSync(pending, JSON.stringify({ ...protocol, boot: bootIdentity() }), {
        flag: "wx",
        mode: 0o600
      })
      renameSync(pending, path)
    } catch {
      /* Preserve an unknown/racing protocol and protect its baseline. */
    } finally {
      if (fd !== undefined) closeOwnedGate(root, identity, lock, fd)
      if (recovering !== undefined) closeOwnedGate(root, identity, recovery, recovering)
    }
  }
}
process.once("exit", () => {
  // Passive JS capabilities die with this process. Physical IO/process leases must survive it.
  for (const lease of passiveLeases) {
    try {
      lease.release()
    } catch {
      /* Keep uncertainty. */
    }
  }
})

export interface SnapshotLease {
  readonly empty?: boolean
  release(): void
  /** SDK shutdown cannot prove a spawned process tree exited; retain its disk fence until a new boot. */
  keepUntilNextBoot?(): void
}
export interface SnapshotReferenceAudit {
  complete: boolean
  digests: ReadonlySet<string>
  blockers: readonly string[]
}
export interface SnapshotCollection {
  root: string
  publishedBefore: number
  publishedAfter: number
  removed: string[]
  candidates: string[]
  protected: string[]
  blockers: string[]
}

function metadata(root: string): string {
  const directory = join(runtimeDirectory(root), ".snapshot-retention")
  mkdirSync(directory, { recursive: true })
  runtimeDirectory(directory)
  const readers = join(directory, "readers")
  mkdirSync(readers, { recursive: true })
  runtimeDirectory(readers)
  const marker = join(directory, "protocol-v1.json")
  if (!existsSync(marker)) {
    let fd: number | undefined
    try {
      fd = openSync(marker, "wx", 0o600)
      // Old workers/MCP processes predate this protocol and have no lease files. Protect every
      // package they could already hold, until a native boot boundary proves those readers died.
      const legacy = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && digestPattern.test(entry.name))
        .map((entry) => entry.name)
      writeFileSync(
        fd,
        JSON.stringify({
          version: 1,
          rootIdentity: runtimeDirectoryIdentity(root),
          boot: bootIdentity(),
          legacy
        })
      )
      fsyncSync(fd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  return directory
}

/** Files deliberately survive a crash: an unconfirmed external reader never expires by age/PID. */
export function acquireSnapshotLease(
  ownedRoot: string,
  digests?: readonly string[],
  reason = "snapshot-operation",
  passive = false
): SnapshotLease {
  const root = runtimeDirectory(ownedRoot)
  if (digests?.some((digest) => !digestPattern.test(digest)))
    throw Error("SNAPSHOT_LEASE_DIGEST_INVALID")
  const rootIdentity = runtimeDirectoryIdentity(root)
  const directory = metadata(root)
  const lock = join(directory, "maintenance.lock")
  if (existsSync(lock)) throw Error("SNAPSHOT_MAINTENANCE_BUSY")
  const path = join(directory, "readers", `${randomUUID()}.json`)
  const record = {
    version: 1,
    pid: process.pid,
    owner,
    boot: bootIdentity(),
    reason: reason.slice(0, 160),
    digests: digests ? [...new Set(digests)] : null
  }
  const fd = openSync(path, "wx", 0o600)
  try {
    writeFileSync(fd, JSON.stringify(record))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const identity = lstatSync(path, { bigint: true })
  let released = false
  let keep = false
  const release = () => {
    if (released) return
    released = true
    if (keep) return
    ownedReaders.delete(path)
    try {
      if (runtimeDirectoryIdentity(root) !== rootIdentity) return
      const current = lstatSync(path, { bigint: true })
      if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino)
        unlinkSync(path)
    } catch {
      /* Changed ownership/unconfirmed removal must retain its lease, not mask IO errors. */
    }
  }
  // The collector creates its lock before reading leases. A racing late reader must stop before IO.
  if (existsSync(lock) || runtimeDirectoryIdentity(root) !== rootIdentity) {
    release()
    throw Error("SNAPSHOT_MAINTENANCE_BUSY")
  }
  const lease = {
    release: () => {
      passiveLeases.delete(lease)
      release()
    },
    keepUntilNextBoot: () => {
      keep = true
      passiveLeases.delete(lease)
    }
  }
  ownedReaders.set(path, () => {
    if (record.boot || !bootIdentity()) return
    let fd: number | undefined
    try {
      if (runtimeDirectoryIdentity(root) !== rootIdentity) return
      fd = openSync(path, "r+")
      const current = fstatSync(fd, { bigint: true })
      if (
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        readFileSync(fd, "utf8") !== JSON.stringify(record)
      )
        return
      record.boot = bootIdentity()
      // The fd is the proved original inode; a path replacement cannot redirect this write.
      const bytes = Buffer.from(JSON.stringify(record))
      let offset = 0
      while (offset < bytes.length)
        offset += writeSync(fd, bytes, offset, bytes.length - offset, offset)
      fsyncSync(fd)
    } catch {
      /* Unknown historical leases are never stamped as current ownership. */
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  })
  if (passive) passiveLeases.add(lease)
  return lease
}

function finish<T>(work: () => T, release: () => void): T {
  try {
    const result = work()
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function")
      return Promise.resolve(result).finally(release) as T
    release()
    return result
  } catch (error) {
    release()
    throw error
  }
}

/** Cover the complete capture -> durable commit window, including physical async settlement. */
export function withSnapshotRetention<T>(roots: readonly string[], work: () => T): T {
  const inherited = scopes.getStore() ?? new Map<string, ScopedLease>()
  const held = new Map(inherited)
  const leases: ScopedLease[] = []
  const release = () => {
    for (const state of leases.splice(0).reverse()) {
      if (--state.refs === 0) state.lease.release()
    }
  }
  try {
    for (const input of [...new Set(roots.map((root) => resolve(root)))].sort()) {
      mkdirSync(input, { recursive: true })
      const root = runtimeDirectory(input)
      const identity = runtimeDirectoryIdentity(root)
      let state = held.get(root)
      if (!state || state.refs === 0 || state.identity !== identity)
        state = { refs: 0, lease: acquireSnapshotLease(root), identity }
      state.refs++
      leases.push(state)
      held.set(root, state)
    }
  } catch (error) {
    release()
    throw error
  }
  return finish(() => scopes.run(held, work), release)
}

/** Recognize only an admitted content-addressed package path; installed mutable plugins are ignored. */
export function acquireSnapshotPathLeases(
  paths: readonly string[],
  reason: string,
  passive = false
): SnapshotLease {
  const roots = new Map<string, Set<string>>()
  for (const path of paths) {
    if (basename(path) !== "package" || !digestPattern.test(basename(dirname(path)))) continue
    const root = dirname(dirname(path)),
      digest = basename(dirname(path))
    const entries = roots.get(root) ?? new Set<string>()
    entries.add(digest)
    roots.set(root, entries)
  }
  const leases: SnapshotLease[] = []
  try {
    for (const [root, digests] of roots)
      for (const digest of [...digests].sort()) {
        const values = [digest]
        const key = JSON.stringify([runtimeDirectoryIdentity(root), digest, passive])
        let shared = sharedPathLeases.get(key)
        if (!shared) {
          shared = {
            refs: 0,
            lease: acquireSnapshotLease(root, values, reason, passive),
            keep: false
          }
          sharedPathLeases.set(key, shared)
        }
        shared.refs++
        let released = false
        const state = shared
        leases.push({
          release: () => {
            if (released) return
            released = true
            if (--state.refs === 0) {
              if (!state.keep) sharedPathLeases.delete(key)
              state.lease.release()
            }
          },
          keepUntilNextBoot: () => {
            state.keep = true
            state.lease.keepUntilNextBoot?.()
          }
        })
      }
  } catch (error) {
    for (const lease of leases.reverse()) lease.release()
    throw error
  }
  return {
    empty: leases.length === 0,
    keepUntilNextBoot: () => {
      for (const lease of leases) lease.keepUntilNextBoot?.()
    },
    release: () => {
      for (const lease of leases.splice(0).reverse()) lease.release()
    }
  }
}

export function withSnapshotPathRetention<T>(paths: readonly string[], work: () => T): T {
  const lease = acquireSnapshotPathLeases(paths, "runtime-execution")
  if (lease.empty) return work()
  return finish(work, () => lease.release())
}

function safeTree(path: string, budget = { entries: 0 }): void {
  if (++budget.entries > 4096) throw Error("SNAPSHOT_SWEEP_TREE_LIMIT")
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
    throw Error("SNAPSHOT_SWEEP_UNSAFE_ENTRY")
  if (stat.isDirectory()) for (const name of readdirSync(path)) safeTree(join(path, name), budget)
}

function publishedDigests(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && digestPattern.test(entry.name))
    .map((entry) => entry.name)
}

function reviewSnapshotGarbage(
  root: string,
  audit: () => SnapshotReferenceAudit
): SnapshotCollection {
  const before = publishedDigests(root),
    directory = join(root, ".snapshot-retention")
  const result: SnapshotCollection = {
    root,
    publishedBefore: before.length,
    publishedAfter: before.length,
    removed: [],
    candidates: [],
    protected: [],
    blockers: []
  }
  let references: SnapshotReferenceAudit
  try {
    references = audit()
  } catch {
    references = {
      complete: false,
      digests: new Set(),
      blockers: ["SNAPSHOT_REFERENCE_AUDIT_FAILED"]
    }
  }
  result.blockers.push(...references.blockers)
  if (!references.complete) result.blockers.push("SNAPSHOT_REFERENCE_AUDIT_INCOMPLETE")
  const protectedDigests = new Set(references.digests)
  try {
    runtimeDirectory(directory)
    runtimeDirectory(join(directory, "readers"))
    const path = join(directory, "protocol-v1.json"),
      stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024)
      throw Error("unsafe marker")
    const protocol = JSON.parse(readFileSync(path, "utf8"))
    if (
      protocol.version !== 1 ||
      protocol.rootIdentity !== runtimeDirectoryIdentity(root) ||
      typeof protocol.boot !== "string" ||
      !Array.isArray(protocol.legacy) ||
      protocol.legacy.length > 64 ||
      protocol.legacy.some(
        (digest: unknown) => typeof digest !== "string" || !digestPattern.test(digest)
      )
    )
      throw Error("unknown marker")
    if (!protocol.boot || !bootIdentity() || protocol.boot === bootIdentity())
      for (const digest of protocol.legacy) protectedDigests.add(digest)
    for (const entry of readdirSync(join(directory, "readers"), { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) {
        result.blockers.push("SNAPSHOT_READER_UNKNOWN")
        continue
      }
      try {
        const path = join(directory, "readers", entry.name),
          stat = lstatSync(path)
        if (stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024)
          throw Error("unsafe lease")
        const value = JSON.parse(readFileSync(path, "utf8"))
        if (
          value.version !== 1 ||
          !Number.isSafeInteger(value.pid) ||
          typeof value.owner !== "string" ||
          (value.digests !== null &&
            (!Array.isArray(value.digests) ||
              value.digests.some(
                (digest: unknown) => typeof digest !== "string" || !digestPattern.test(digest)
              )))
        )
          throw Error("unknown lease")
        if (value.digests === null) result.blockers.push("SNAPSHOT_READER_ACTIVE_OR_UNCONFIRMED")
        else for (const digest of value.digests) protectedDigests.add(digest)
      } catch {
        result.blockers.push("SNAPSHOT_READER_UNKNOWN")
      }
    }
  } catch {
    result.blockers.push("SNAPSHOT_READER_MIGRATION_UNCONFIRMED")
  }
  if (readdirSync(root).some((name) => name.startsWith("pending-")))
    result.blockers.push("SNAPSHOT_PREPARATION_UNCONFIRMED")
  result.protected = before.filter(
    (digest) => result.blockers.length || protectedDigests.has(digest)
  )
  result.candidates = before.filter((digest) => !result.protected.includes(digest))
  return result
}

/** Advisory read only: does not initialize protocol files, acquire a lock, or remove anything. */
export function inspectSnapshotGarbage(
  root: string,
  audit: () => SnapshotReferenceAudit
): SnapshotCollection {
  const canonical = runtimeDirectory(root)
  const result = reviewSnapshotGarbage(canonical, audit)
  if (existsSync(join(canonical, ".snapshot-retention", "maintenance.lock"))) {
    result.blockers.push("SNAPSHOT_MAINTENANCE_BUSY")
    result.protected.push(...result.candidates)
    result.candidates = []
  }
  return result
}

/** Explicit maintenance only. Audit and rename run synchronously behind the cross-process gate. */
export function collectSnapshotGarbage(
  ownedRoot: string,
  audit: () => SnapshotReferenceAudit,
  expectedDigests?: readonly string[]
): SnapshotCollection {
  if (
    expectedDigests &&
    (expectedDigests.length > 64 || expectedDigests.some((digest) => !digestPattern.test(digest)))
  )
    throw Error("SNAPSHOT_COLLECTION_ARGUMENTS")
  const root = runtimeDirectory(ownedRoot),
    identity = runtimeDirectoryIdentity(root)
  const directory = metadata(root),
    lock = join(directory, "maintenance.lock")
  let fd: number
  try {
    fd = openSync(lock, "wx", 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const result = reviewSnapshotGarbage(root, audit)
    result.blockers.push("SNAPSHOT_MAINTENANCE_BUSY")
    result.protected.push(...result.candidates)
    result.candidates = []
    return result
  }
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, owner, boot: bootIdentity() }))
    fsyncSync(fd)
    const result = reviewSnapshotGarbage(root, audit)
    if (result.blockers.length) return result
    for (const digest of result.candidates) {
      if (expectedDigests && !expectedDigests.includes(digest)) continue
      if (runtimeDirectoryIdentity(root) !== identity) throw Error("SNAPSHOT_ROOT_CHANGED")
      const source = join(root, digest),
        sourceStat = lstatSync(runtimeDirectory(source), { bigint: true })
      safeTree(source)
      const trash = join(directory, `garbage-${digest}-${randomUUID()}`)
      renameSync(source, trash)
      const trashStat = lstatSync(runtimeDirectory(trash), { bigint: true })
      if (trashStat.dev !== sourceStat.dev || trashStat.ino !== sourceStat.ino)
        throw Error("SNAPSHOT_ROOT_CHANGED")
      safeTree(trash)
      rmSync(trash, { recursive: true })
      result.removed.push(digest)
    }
    result.publishedAfter = publishedDigests(root).length
    return result
  } finally {
    closeOwnedGate(root, identity, lock, fd)
  }
}
