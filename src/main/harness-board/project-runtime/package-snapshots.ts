import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises"
import {
  parseProjectRuntimeManifest,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import { hostDigest, hostStateError } from "./host-state-protocol"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeDirectoryIdentity,
  runtimeRelativePath
} from "./safe-files"
import { readRuntimeScopedFileAsync, runtimeDirectoryAsync } from "./safe-files-async"
import { withSnapshotRetention, withSnapshotPathRetention } from "./snapshot-retention"

export const HOST_PACKAGE_LIMITS = {
  files: 2048,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  directories: 512,
  depth: 16,
  snapshots: 64
}

interface PackageTree {
  digest: string
  directories: string[]
  files: Array<{ path: string; data: Buffer; executable: boolean }>
}

export interface HostPackageSnapshot {
  digest: string
  root: string
  manifest: ProjectRuntimeManifest
}

function forbidden(path: string): boolean {
  return path
    .split("/")
    .some(
      (part) =>
        /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/iu.test(
          part
        ) || /\.(?:pem|key|p12|pfx|kdbx)$/iu.test(part)
    )
}

function readTree(root: string): PackageTree {
  const canonical = runtimeDirectory(root)
  const directories: string[] = []
  const files: PackageTree["files"] = []
  const names = new Set<string>()
  let bytes = 0
  const expires = performance.now() + 5000
  const visit = (base: string, depth: number) => {
    if (depth > HOST_PACKAGE_LIMITS.depth || performance.now() >= expires)
      hostStateError("PACKAGE_LIMIT")
    const directory = base ? join(canonical, base) : canonical
    runtimeDirectory(directory)
    const before = lstatSync(directory, { bigint: true })
    const entries = readdirSync(directory).sort()
    for (const name of entries) {
      const path = base ? `${base}/${name}` : name
      runtimeRelativePath(path)
      if (forbidden(path)) hostStateError("PACKAGE_SENSITIVE_PATH")
      if (names.has(path.toLowerCase())) hostStateError("PACKAGE_PATH_COLLISION")
      names.add(path.toLowerCase())
      const stat = lstatSync(join(canonical, path))
      if (stat.isSymbolicLink()) hostStateError("PACKAGE_LINK")
      if (stat.isDirectory()) {
        if (directories.length >= HOST_PACKAGE_LIMITS.directories) hostStateError("PACKAGE_LIMIT")
        directories.push(path)
        visit(path, depth + 1)
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || files.length >= HOST_PACKAGE_LIMITS.files)
          hostStateError("PACKAGE_LIMIT")
        if (bytes + stat.size > HOST_PACKAGE_LIMITS.totalBytes) hostStateError("PACKAGE_LIMIT")
        const observed = readRuntimeScopedFile(canonical, path, HOST_PACKAGE_LIMITS.fileBytes)
        if (!observed.bytes) hostStateError("PACKAGE_CHANGED")
        bytes += observed.bytes.length
        if (bytes > HOST_PACKAGE_LIMITS.totalBytes) hostStateError("PACKAGE_LIMIT")
        files.push({
          path,
          data: observed.bytes,
          executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0
        })
      }
    }
    const after = lstatSync(directory, { bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(entries)
    )
      hostStateError("PACKAGE_CHANGED")
  }
  visit("", 0)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  directories.sort()
  return {
    directories,
    files,
    digest: runtimeDigest(
      JSON.stringify({
        version: 1,
        directories,
        files: files.map((file) => [file.path, runtimeDigest(file.data), file.executable])
      })
    )
  }
}

async function batch<T>(values: T[], work: (value: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < values.length; index += 8) {
    const results = await Promise.allSettled(values.slice(index, index + 8).map(work))
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }
}

/** Async intake uses the same digest and limits; it never holds the main loop during disk flushes. */
/** Existing bounded source reader for install-time protocol admission; no retention or authority. */
export function readPackageProtocolFiles(root: string): Array<{ path: string; bytes: Buffer }> {
  return readTree(root).files.map(file => ({ path: file.path, bytes: file.data }))
}

/** Same bounded source bytes, without synchronous per-file IO on the Electron main loop. */
export function readPackageProtocolFilesAsync(
  root: string,
  signal?: AbortSignal
): Promise<Array<{ path: string; bytes: Buffer }>> {
  return withSnapshotPathRetention([root], async () =>
    (await readTreeAsync(root, signal)).files.map(file => ({ path: file.path, bytes: file.data })))
}

/** Fresh bounded package identity for native readers; does not retain or approve a package. */
export function readPackageProtocolDigestAsync(root: string, signal?: AbortSignal): Promise<string> {
  return withSnapshotPathRetention([root], async () => (await readTreeAsync(root, signal)).digest)
}

async function readTreeAsync(root: string, signal?: AbortSignal): Promise<PackageTree> {
  const canonical = await runtimeDirectoryAsync(root)
  const directories: string[] = []
  const files: PackageTree["files"] = []
  const names = new Set<string>()
  let bytes = 0
  let fileCount = 0
  const expires = performance.now() + 5000
  const visit = async (base: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    if (depth > HOST_PACKAGE_LIMITS.depth || performance.now() >= expires)
      hostStateError("PACKAGE_LIMIT")
    const directory = await runtimeDirectoryAsync(base ? join(canonical, base) : canonical)
    const before = await lstat(directory, { bigint: true })
    const entries = (await readdir(directory)).sort()
    const children: string[] = []
    await batch(entries, async (name) => {
      signal?.throwIfAborted()
      const path = base ? `${base}/${name}` : name
      runtimeRelativePath(path)
      if (forbidden(path)) hostStateError("PACKAGE_SENSITIVE_PATH")
      if (names.has(path.toLowerCase())) hostStateError("PACKAGE_PATH_COLLISION")
      names.add(path.toLowerCase())
      const stat = await lstat(join(canonical, path))
      if (stat.isSymbolicLink()) hostStateError("PACKAGE_LINK")
      if (stat.isDirectory()) {
        if (directories.length >= HOST_PACKAGE_LIMITS.directories) hostStateError("PACKAGE_LIMIT")
        directories.push(path)
        children.push(path)
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || ++fileCount > HOST_PACKAGE_LIMITS.files)
          hostStateError("PACKAGE_LIMIT")
        bytes += stat.size
        if (bytes > HOST_PACKAGE_LIMITS.totalBytes) hostStateError("PACKAGE_LIMIT")
        const file = await readRuntimeScopedFileAsync(
          canonical,
          path,
          HOST_PACKAGE_LIMITS.fileBytes,
          signal
        )
        if (!file.bytes || file.bytes.length !== stat.size) hostStateError("PACKAGE_CHANGED")
        files.push({
          path,
          data: file.bytes,
          executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0
        })
      }
    })
    // One directory at a time bounds file concurrency across the whole tree.
    for (const child of children) await visit(child, depth + 1)
    signal?.throwIfAborted()
    const after = await lstat(directory, { bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(entries)
    )
      hostStateError("PACKAGE_CHANGED")
  }
  await visit("", 0)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  directories.sort()
  return {
    directories,
    files,
    digest: runtimeDigest(
      JSON.stringify({
        version: 1,
        directories,
        files: files.map((file) => [file.path, runtimeDigest(file.data), file.executable])
      })
    )
  }
}

function describeTree(tree: PackageTree, root: string): HostPackageSnapshot {
  const file = tree.files.find((file) => file.path === "devclaw.project-runtime.json")
  if (!file) hostStateError("RUNTIME_DECLARATION_MISSING")
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.data))
  )
  return { digest: tree.digest, root, manifest }
}

/** Original metadata fence, scoped to one actual tree read; it never admits content or grants IO. */
export function capturePackageMetadataGuard(packageRoot: string): () => void {
  const signature = (path: string): string => {
    const stat = lstatSync(path, { bigint: true })
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)))
      hostStateError("PACKAGE_CHANGED")
    return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
  }
  const observed: Array<[string, string]> = []
  const visit = (path: string, depth: number): void => {
    if (depth > HOST_PACKAGE_LIMITS.depth ||
      observed.length > HOST_PACKAGE_LIMITS.files + HOST_PACKAGE_LIMITS.directories)
      hostStateError("PACKAGE_LIMIT")
    observed.push([path, signature(path)])
    if (lstatSync(path).isDirectory())
      for (const name of readdirSync(path)) visit(join(path, name), depth + 1)
  }
  runtimeDirectory(packageRoot)
  visit(packageRoot, 0)
  return () => {
    runtimeDirectory(packageRoot)
    for (const [path, expected] of observed)
      if (signature(path) !== expected) hostStateError("PACKAGE_CHANGED")
  }
}

/** Retained full-package copies, never an alternate install catalog or permission grant. */
export class RetainedPackageSnapshots<
  T extends { digest: string; root: string } = { digest: string; root: string }
> {
  readonly root: string
  private readonly rootIdentity: string
  constructor(
    ownedRoot: string,
    private readonly describe: (tree: PackageTree, root: string) => T = ((tree, root) => ({
      digest: tree.digest,
      root
    })) as (tree: PackageTree, root: string) => T
  ) {
    mkdirSync(ownedRoot, { recursive: true })
    this.root = runtimeDirectory(ownedRoot)
    this.rootIdentity = runtimeDirectoryIdentity(this.root)
  }

  private assertCapacity(): void {
    const published = readdirSync(runtimeDirectory(this.root), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)
    )
    if (published.length >= HOST_PACKAGE_LIMITS.snapshots) hostStateError("SNAPSHOT_CAPACITY")
  }

  private ownsStaging(staging: string, identity: string): boolean {
    if (
      dirname(staging) !== this.root ||
      !/^pending-[a-f0-9-]{36}$/.test(relative(this.root, staging))
    )
      return false
    try {
      return (
        runtimeDirectoryIdentity(this.root) === this.rootIdentity &&
        runtimeDirectoryIdentity(staging) === identity
      )
    } catch {
      return false
    }
  }

  private discardStaging(staging: string, identity: string): void {
    try {
      if (this.ownsStaging(staging, identity)) rmSync(staging, { recursive: true, force: true })
    } catch {
      // Preserve the intake failure; an unremovable preparation never consumes published capacity.
    }
  }

  private async discardStagingAsync(staging: string, identity: string): Promise<void> {
    try {
      if (this.ownsStaging(staging, identity)) await rm(staging, { recursive: true, force: true })
    } catch {
      // Do not replace the original cancellation or copy error with a cleanup error.
    }
  }

  private publish(staging: string, identity: string, digest: string): boolean {
    if (!this.ownsStaging(staging, identity)) hostStateError("PACKAGE_CHANGED")
    const destination = join(this.root, digest)
    if (existsSync(destination)) return false
    // Only the small directory count and rename are synchronous. Keeping them adjacent prevents
    // concurrent intakes in this process from publishing beyond the retained snapshot limit.
    this.assertCapacity()
    try {
      renameSync(staging, destination)
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") ||
        !existsSync(destination)
      )
        throw error
      return false
    }
    return true
  }

  capture(installedRoot: string): T {
    return withSnapshotRetention([this.root], () => this.captureUnleased(installedRoot))
  }

  private captureUnleased(installedRoot: string): T {
    const source = runtimeDirectory(installedRoot)
    const inside = relative(source, this.root)
    if (inside === "" || (!inside.startsWith("..") && !inside.includes(":")))
      hostStateError("PACKAGE_SNAPSHOT_SCOPE")
    const before = readTree(source)
    this.describe(before, source)
    const destination = join(this.root, before.digest)
    if (existsSync(destination)) return this.read(before.digest)
    this.assertCapacity()
    const staging = join(this.root, `pending-${randomUUID()}`)
    mkdirSync(staging)
    const identity = runtimeDirectoryIdentity(staging)
    let published = false
    try {
      const packageRoot = join(staging, "package")
      mkdirSync(packageRoot)
      for (const directory of before.directories)
        mkdirSync(join(packageRoot, directory), { recursive: true })
      for (const file of before.files) {
        const path = join(packageRoot, file.path)
        mkdirSync(dirname(path), { recursive: true })
        const fd = openSync(path, "wx", file.executable ? 0o700 : 0o600)
        try {
          let offset = 0
          while (offset < file.data.length)
            offset += writeSync(fd, file.data, offset, file.data.length - offset)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        if (file.executable) chmodSync(path, 0o700)
      }
      if (
        readTree(source).digest !== before.digest ||
        readTree(packageRoot).digest !== before.digest
      )
        hostStateError("PACKAGE_CHANGED")
      published = this.publish(staging, identity, before.digest)
      return this.read(before.digest)
    } finally {
      if (!published) this.discardStaging(staging, identity)
    }
  }

  captureAsync(installedRoot: string, signal?: AbortSignal): Promise<T> {
    return withSnapshotRetention([this.root], () => this.captureAsyncUnleased(installedRoot, signal))
  }

  private async captureAsyncUnleased(installedRoot: string, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const source = await runtimeDirectoryAsync(installedRoot)
    await runtimeDirectoryAsync(this.root)
    const inside = relative(source, this.root)
    if (inside === "" || (!inside.startsWith("..") && !inside.includes(":")))
      hostStateError("PACKAGE_SNAPSHOT_SCOPE")
    const before = await readTreeAsync(source, signal)
    this.describe(before, source)
    const destination = join(this.root, before.digest)
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (existing) return this.readAsync(before.digest, signal)
    this.assertCapacity()
    const staging = join(this.root, `pending-${randomUUID()}`)
    await mkdir(staging)
    const identity = runtimeDirectoryIdentity(staging)
    let published = false
    try {
      signal?.throwIfAborted()
      const packageRoot = join(staging, "package")
      await mkdir(packageRoot)
      for (const directory of before.directories) {
        signal?.throwIfAborted()
        await mkdir(join(packageRoot, directory), { recursive: true })
      }
      await batch(before.files, async (file) => {
        signal?.throwIfAborted()
        const path = join(packageRoot, file.path)
        const fd = await open(path, "wx", file.executable ? 0o700 : 0o600)
        try {
          await fd.writeFile(file.data)
          await fd.sync()
        } finally {
          await fd.close()
        }
        if (file.executable) await chmod(path, 0o700)
        signal?.throwIfAborted()
      })
      if ((await readTreeAsync(source, signal)).digest !== before.digest)
        hostStateError("PACKAGE_CHANGED")
      const retained = await readTreeAsync(packageRoot, signal)
      if (retained.digest !== before.digest) hostStateError("PACKAGE_CHANGED")
      await runtimeDirectoryAsync(this.root)
      signal?.throwIfAborted()
      published = this.publish(staging, identity, before.digest)
      return published
        ? this.describe(retained, await runtimeDirectoryAsync(join(destination, "package")))
        : await this.readAsync(before.digest, signal)
    } finally {
      if (!published) await this.discardStagingAsync(staging, identity)
    }
  }

  readAsync(digest: string, signal?: AbortSignal): Promise<T> {
    hostDigest(digest)
    return withSnapshotPathRetention([join(this.root, digest, "package")], () =>
      this.readAsyncUnleased(digest, signal))
  }

  private async readAsyncUnleased(digest: string, signal?: AbortSignal): Promise<T> {
    hostDigest(digest)
    await runtimeDirectoryAsync(this.root)
    const directory = await runtimeDirectoryAsync(join(this.root, digest))
    if ((await readdir(directory)).sort().join(",") !== "package") hostStateError("PACKAGE_CHANGED")
    const packageRoot = join(directory, "package")
    const tree = await readTreeAsync(packageRoot, signal)
    if (tree.digest !== digest) hostStateError("PACKAGE_CHANGED")
    return this.describe(tree, packageRoot)
  }

  /** Full content admission followed by cheap, fail-closed metadata checks at execution boundaries. */
  captureGuard(digest: string): () => void {
    hostDigest(digest)
    const paths = [join(this.root, digest, "package")]
    return withSnapshotPathRetention(paths, () => {
      const guard = this.captureMetadataGuard(digest)
      this.read(digest)
      guard()
      return () => withSnapshotPathRetention(paths, guard)
    })
  }

  async captureGuardAsync(digest: string, signal?: AbortSignal): Promise<() => void> {
    hostDigest(digest)
    const paths = [join(this.root, digest, "package")]
    return withSnapshotPathRetention(paths, async () => {
      const guard = this.captureMetadataGuard(digest)
      await this.readAsync(digest, signal)
      guard()
      return () => withSnapshotPathRetention(paths, guard)
    })
  }

  private captureMetadataGuard(digest: string): () => void {
    hostDigest(digest)
    const packageRoot = join(this.root, digest, "package")
    const guard = capturePackageMetadataGuard(packageRoot)
    // Callers hash after metadata capture, then recheck the baseline to reject concurrent writers.
    const assertCurrent = () => {
      runtimeDirectory(packageRoot)
      if (readdirSync(join(this.root, digest)).sort().join(",") !== "package")
        hostStateError("PACKAGE_CHANGED")
      guard()
    }
    return assertCurrent
  }

  read(digest: string): T {
    hostDigest(digest)
    // Known-digest reads share only the existing physical path lease. Validation still runs
    // on every call; intake/publication retain their original whole-root transaction lease.
    return withSnapshotPathRetention([join(this.root, digest, "package")], () =>
      this.readUnleased(digest))
  }

  private readUnleased(digest: string): T {
    hostDigest(digest)
    runtimeDirectory(this.root)
    const directory = join(this.root, digest)
    runtimeDirectory(directory)
    if (readdirSync(directory).sort().join(",") !== "package") hostStateError("PACKAGE_CHANGED")
    const packageRoot = join(directory, "package")
    const tree = readTree(packageRoot)
    if (tree.digest !== digest) hostStateError("PACKAGE_CHANGED")
    return this.describe(tree, packageRoot)
  }
}

/** Original host flows still require their validated runtime declaration. */
export class HostPackageSnapshots extends RetainedPackageSnapshots<HostPackageSnapshot> {
  constructor(ownedRoot: string) {
    super(ownedRoot, describeTree)
  }
}
