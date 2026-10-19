import { createHash } from "node:crypto"
import * as fs from "node:fs"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { hostStateError } from "./host-state-protocol"

const builtinFs = process.getBuiltinModule?.("node:fs")
const observedMethods = [
  "lstatSync",
  "statSync",
  "realpathSync",
  "openSync",
  "readSync",
  "fstatSync",
  "closeSync",
  "readdirSync"
] as const
const originalMethods = observedMethods.map((key) => builtinFs?.[key])
const originalNativeRealpath = builtinFs?.realpathSync.native
function canCombineRootObservation(): boolean {
  return Boolean(
    builtinFs &&
    observedMethods.every(
      (key, index) =>
        fs[key] === originalMethods[index] && builtinFs[key] === originalMethods[index]
    ) &&
    fs.realpathSync.native === originalNativeRealpath &&
    builtinFs.realpathSync.native === originalNativeRealpath
  )
}

export function runtimeDigest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function runtimeRelativePath(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    value.includes("\\") ||
    value.includes(":") ||
    // eslint-disable-next-line no-control-regex -- Portable package paths cannot hide controls.
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    isAbsolute(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[<>"|?*]|[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part)
      )
  )
    hostStateError("FILE_PATH_INVALID")
  return value
}

export function runtimeDirectory(root: string): string {
  if (!isAbsolute(root)) hostStateError("DIRECTORY_INVALID")
  const path = resolve(root)
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
    hostStateError("DIRECTORY_INVALID")
  return path
}

export function runtimeDirectoryIdentity(root: string): string {
  const directory = runtimeDirectory(root)
  const stat = lstatSync(directory, { bigint: true })
  return `${directory}:${stat.dev}:${stat.ino}`
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(":")
}

export interface ScopedFileObservation {
  path: string
  present: boolean
  fingerprint: string
  bytes?: Buffer
}

/** Synchronous bounded reads are also used immediately before the database commit. */
export function readRuntimeScopedFile(
  root: string,
  relative: string,
  maxBytes = 4 * 1024 * 1024
): ScopedFileObservation {
  return observeRuntimeScopedFile(root, relative, maxBytes, false)
}

/** Safe presence only: identical scope/link/identity checks, without interpreting resource bytes. */
export function probeRuntimeScopedFile(root: string, relative: string): ScopedFileObservation {
  return observeRuntimeScopedFile(root, relative, 0, true)
}

function observeRuntimeScopedFile(
  root: string,
  relative: string,
  maxBytes: number,
  presenceOnly: boolean
): ScopedFileObservation {
  const parents: Array<{ path: string; identity: string }> = []
  let directory: string
  let scopeIdentity: string
  if (canCombineRootObservation()) {
    if (!isAbsolute(root)) hostStateError("DIRECTORY_INVALID")
    directory = resolve(root)
    const observed = lstatSync(directory, { bigint: true })
    if (
      !observed.isDirectory() ||
      observed.isSymbolicLink() ||
      realpathSync(directory) !== directory
    )
      hostStateError("DIRECTORY_INVALID")
    const identity = `${observed.dev}:${observed.ino}`
    scopeIdentity = `${directory}:${identity}`
    // One synchronous root observation serves the original directory/identity/parent checks.
    // checkParents() still freshly rechecks this exact original inode after every read/absence.
    parents.push({ path: directory, identity })
  } else {
    // Keep the original observable sequence for FS wrappers and injected race regressions.
    directory = runtimeDirectory(root)
    scopeIdentity = runtimeDirectoryIdentity(directory)
  }
  runtimeRelativePath(relative)
  let parent = directory
  const parts = relative.split("/")
  const remember = (path: string) => {
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
      hostStateError("FILE_SCOPE_CHANGED")
    parents.push({ path, identity: `${stat.dev}:${stat.ino}` })
  }
  if (!parents.length) remember(parent)
  let missingParent = false
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part)
    try {
      remember(parent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      missingParent = true
      break
    }
  }
  const checkParents = () => {
    for (const observed of parents) {
      const stat = lstatSync(observed.path, { bigint: true })
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        realpathSync(observed.path) !== observed.path ||
        `${stat.dev}:${stat.ino}` !== observed.identity
      )
        hostStateError("FILE_SCOPE_CHANGED")
    }
  }
  const absent = (): ScopedFileObservation => {
    checkParents()
    return {
      path: relative,
      present: false,
      fingerprint: runtimeDigest(JSON.stringify([scopeIdentity, relative, "missing"]))
    }
  }
  if (missingParent) return absent()
  const path = join(directory, ...parts)
  let before: BigIntStats
  try {
    before = lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent()
    throw error
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    realpathSync(path) !== path
  )
    hostStateError("FILE_UNSAFE")
  if (!presenceOnly && before.size > BigInt(maxBytes)) hostStateError("FILE_LIMIT")
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const initial = fstatSync(fd, { bigint: true })
    if (!initial.isFile() || identity(initial) !== identity(before)) hostStateError("FILE_CHANGED")
    const bytes = Buffer.alloc(presenceOnly ? 0 : Number(initial.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) hostStateError("FILE_CHANGED")
      offset += count
    }
    const named = lstatSync(path, { bigint: true })
    if (
      identity(fstatSync(fd, { bigint: true })) !== identity(initial) ||
      identity(named) !== identity(initial) ||
      named.isSymbolicLink() ||
      realpathSync(path) !== path
    )
      hostStateError("FILE_CHANGED")
    checkParents()
    if (presenceOnly)
      return {
        path: relative,
        present: true,
        fingerprint: runtimeDigest(JSON.stringify([scopeIdentity, relative, identity(initial)]))
      }
    return {
      path: relative,
      present: true,
      bytes,
      fingerprint: runtimeDigest(JSON.stringify([scopeIdentity, relative, runtimeDigest(bytes)]))
    }
  } finally {
    closeSync(fd)
  }
}
