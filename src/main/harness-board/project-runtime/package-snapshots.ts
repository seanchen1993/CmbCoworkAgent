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
  writeSync
} from "node:fs"
import { dirname, join, relative } from "node:path"
import {
  parseProjectRuntimeManifest,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import { hostDigest, hostStateError } from "./host-state-protocol"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeRelativePath
} from "./safe-files"

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

function describeTree(tree: PackageTree, root: string): HostPackageSnapshot {
  const file = tree.files.find((file) => file.path === "devclaw.project-runtime.json")
  if (!file) hostStateError("RUNTIME_DECLARATION_MISSING")
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.data))
  )
  return { digest: tree.digest, root, manifest }
}

/** Retained full-package copies, never an alternate install catalog or permission grant. */
export class HostPackageSnapshots {
  readonly root: string
  constructor(ownedRoot: string) {
    mkdirSync(ownedRoot, { recursive: true })
    this.root = runtimeDirectory(ownedRoot)
  }

  capture(installedRoot: string): HostPackageSnapshot {
    const source = runtimeDirectory(installedRoot)
    const inside = relative(source, this.root)
    if (inside === "" || (!inside.startsWith("..") && !inside.includes(":")))
      hostStateError("PACKAGE_SNAPSHOT_SCOPE")
    const before = readTree(source)
    describeTree(before, source)
    const destination = join(this.root, before.digest)
    if (existsSync(destination)) return this.read(before.digest)
    if (readdirSync(this.root).length >= HOST_PACKAGE_LIMITS.snapshots)
      hostStateError("SNAPSHOT_CAPACITY")
    const staging = join(this.root, `pending-${randomUUID()}`)
    mkdirSync(staging)
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
    if (readTree(source).digest !== before.digest || readTree(packageRoot).digest !== before.digest)
      hostStateError("PACKAGE_CHANGED")
    // No deletion or cleanup is performed: interrupted preparations remain visible for diagnosis.
    renameSync(staging, destination)
    return this.read(before.digest)
  }

  read(digest: string): HostPackageSnapshot {
    hostDigest(digest)
    runtimeDirectory(this.root)
    const directory = join(this.root, digest)
    runtimeDirectory(directory)
    if (readdirSync(directory).sort().join(",") !== "package") hostStateError("PACKAGE_CHANGED")
    const packageRoot = join(directory, "package")
    const tree = readTree(packageRoot)
    if (tree.digest !== digest) hostStateError("PACKAGE_CHANGED")
    return describeTree(tree, packageRoot)
  }
}
