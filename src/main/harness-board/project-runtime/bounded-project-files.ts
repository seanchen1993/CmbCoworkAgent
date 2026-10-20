import type { Stats } from "node:fs"
import { lstat, opendir } from "node:fs/promises"
import { join } from "node:path"
import { HOST_PACKAGE_LIMITS } from "./package-snapshots"
import { runtimeDigest, runtimeRelativePath } from "./safe-files"
import { readRuntimeScopedFileAsync, runtimeDirectoryIdentityAsync } from "./safe-files-async"

/** Main-only byte inventories. Never grants execution or sends file contents over IPC. */
export interface ProjectFileHash {
  path: string
  digest: string
  bytes: number
  executable: boolean
  binary: boolean
}
export interface ProjectFileInventory {
  files: ProjectFileHash[]
  directories: string[]
  totalBytes: number
  fingerprint: string
  buffers: Map<string, Buffer>
}
export interface ExpectedProjectFiles {
  files: ReadonlyArray<{ path: string; digest: string; bytes: number; executable: boolean }>
  directories: readonly string[]
  totalBytes: number
}
export const PROJECT_FILE_OBSERVATION_LIMITS = { ...HOST_PACKAGE_LIMITS, milliseconds: 5000 }

export function isSensitiveProjectFilePath(path: string): boolean {
  return path
    .split("/")
    .some(
      (part) =>
        /^(?:\.git|\.svn|\.hg|\.env(?:\..*)?|\.envrc|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|auth\.json|settings\.local\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(
          part
        ) || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(part)
    )
}
function fail(code: string): never {
  throw Error(`PROJECT_FILE_OBSERVATION_${code}`)
}
function identity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink, stat.mode].join(
    ":"
  )
}
function binary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return false
  } catch {
    return true
  }
}

/** Every content read uses the existing scoped stable reader. Directory identity, listing and
 * file identities are rechecked after all reads. Any uncertainty discards the whole inventory.
 * This is an observation at a point in time, not a filesystem lock or an OS sandbox.
 */
export async function readBoundedProjectFiles(
  root: string,
  options: {
    guard(): void
    signal?: AbortSignal
    expected?: ExpectedProjectFiles
    collect?: boolean
  }
): Promise<ProjectFileInventory> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(PROJECT_FILE_OBSERVATION_LIMITS.milliseconds),
    ...(options.signal ? [options.signal] : [])
  ])
  const current = () => {
    signal.throwIfAborted()
    options.guard()
  }
  current()
  const rootIdentity = await runtimeDirectoryIdentityAsync(root)
  const files: Array<{ path: string; identity: string; bytes: number; executable: boolean }> = []
  const directories: Array<{ path: string; identity: string; names: string[] }> = []
  let entryCount = 0,
    total = 0
  const namesAt = async (relative: string, count: boolean) => {
    current()
    const directory = relative ? join(root, relative) : root
    const names: string[] = []
    const seen = new Set<string>()
    const opened = await opendir(directory)
    for await (const entry of opened) {
      current()
      if (
        count &&
        ++entryCount >
          PROJECT_FILE_OBSERVATION_LIMITS.files + PROJECT_FILE_OBSERVATION_LIMITS.directories
      )
        fail("LIMIT")
      if (
        names.length >=
        PROJECT_FILE_OBSERVATION_LIMITS.files + PROJECT_FILE_OBSERVATION_LIMITS.directories
      )
        fail("LIMIT")
      const path = relative ? `${relative}/${entry.name}` : entry.name
      runtimeRelativePath(path)
      if (isSensitiveProjectFilePath(path)) fail("SENSITIVE_PATH")
      const key = entry.name.toLowerCase()
      if (seen.has(key)) fail("PATH_COLLISION")
      seen.add(key)
      names.push(entry.name)
    }
    current()
    return names.sort((left, right) => left.localeCompare(right, "en"))
  }
  const visit = async (relative: string, depth: number) => {
    current()
    if (depth > PROJECT_FILE_OBSERVATION_LIMITS.depth) fail("LIMIT")
    const directory = relative ? join(root, relative) : root
    const observed = await runtimeDirectoryIdentityAsync(directory)
    const names = await namesAt(relative, true)
    directories.push({ path: relative, identity: observed, names })
    if (directories.length - 1 > PROJECT_FILE_OBSERVATION_LIMITS.directories) fail("LIMIT")
    for (const name of names) {
      current()
      const path = relative ? `${relative}/${name}` : name
      const stat = await lstat(join(root, path))
      current()
      if (stat.isSymbolicLink()) fail("UNSAFE_FILE")
      if (stat.isDirectory()) await visit(path, depth + 1)
      else {
        if (!stat.isFile() || stat.nlink !== 1) fail("UNSAFE_FILE")
        if (
          files.length >= PROJECT_FILE_OBSERVATION_LIMITS.files ||
          stat.size > PROJECT_FILE_OBSERVATION_LIMITS.fileBytes ||
          total + stat.size > PROJECT_FILE_OBSERVATION_LIMITS.totalBytes
        )
          fail("LIMIT")
        total += stat.size
        files.push({
          path,
          identity: identity(stat),
          bytes: stat.size,
          executable: Boolean(stat.mode & 0o111)
        })
      }
    }
  }
  await visit("", 0)
  current()
  const expected = options.expected
  const directoryPaths = directories
    .map((item) => item.path)
    .filter(Boolean)
    .sort()
  if (
    expected &&
    (expected.totalBytes !== total ||
      expected.files.length !== files.length ||
      JSON.stringify([...expected.directories].sort()) !== JSON.stringify(directoryPaths))
  )
    fail("FILES_CHANGED")
  const expectedFiles = new Map(expected?.files.map((file) => [file.path, file]))
  const result: ProjectFileHash[] = []
  const buffers = new Map<string, Buffer>()
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    current()
    const observed = await readRuntimeScopedFileAsync(
      root,
      file.path,
      PROJECT_FILE_OBSERVATION_LIMITS.fileBytes,
      signal
    )
    current()
    if (!observed.bytes || observed.bytes.length !== file.bytes) fail("FILES_CHANGED")
    const hash = runtimeDigest(observed.bytes)
    const prior = expectedFiles.get(file.path)
    if (
      expected &&
      (!prior ||
        prior.digest !== hash ||
        prior.bytes !== file.bytes ||
        prior.executable !== file.executable)
    )
      fail("FILES_CHANGED")
    result.push({
      path: file.path,
      digest: hash,
      bytes: file.bytes,
      executable: file.executable,
      binary: binary(observed.bytes)
    })
    if (options.collect) buffers.set(file.path, observed.bytes)
  }
  for (const directory of directories) {
    current()
    if (
      (await runtimeDirectoryIdentityAsync(directory.path ? join(root, directory.path) : root)) !==
        directory.identity ||
      JSON.stringify(await namesAt(directory.path, false)) !== JSON.stringify(directory.names)
    )
      fail("DIRECTORY_CHANGED")
  }
  for (const file of files) {
    current()
    if (identity(await lstat(join(root, file.path))) !== file.identity) fail("FILES_CHANGED")
  }
  current()
  if ((await runtimeDirectoryIdentityAsync(root)) !== rootIdentity) fail("DIRECTORY_CHANGED")
  current()
  // Compare content hashes across roots. ScopedFileObservation.fingerprint includes root identity.
  return {
    files: result,
    directories: directoryPaths,
    totalBytes: total,
    buffers,
    fingerprint: runtimeDigest(JSON.stringify([directoryPaths, result]))
  }
}
