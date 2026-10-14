import { createHash } from "node:crypto"
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
import { isAbsolute, join, relative, sep } from "node:path"
import type { CompiledFunctionPlugin } from "./loader"

export interface FunctionSourceIdentity {
  device: bigint
  inode: bigint
}

export interface FunctionSourceProof {
  path: string
  size: number
  hash: string
  identity: FunctionSourceIdentity
}
interface Proof {
  files: readonly FunctionSourceProof[]
  missing: readonly string[]
  adoptable: boolean
  root: FunctionSourceIdentity
}
const proofs = new WeakMap<CompiledFunctionPlugin, Proof>()

export function sourceProof(
  path: string,
  bytes: Buffer,
  identity: FunctionSourceIdentity
): FunctionSourceProof {
  return {
    path,
    size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
    identity: { ...identity }
  }
}

export function bindFunctionSourceProofs(
  compiled: CompiledFunctionPlugin,
  files: readonly FunctionSourceProof[],
  missing: readonly string[],
  adoptable = true,
  root: FunctionSourceIdentity = { device: -1n, inode: -1n }
): void {
  const pathKey = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path)
  const absent = [...new Map(missing.map((path) => [pathKey(path), path])).values()]
  const complete = adoptable && files.length + absent.length <= 2048
  // Bound the final synchronous path work too; cold compilation keeps its existing limits.
  proofs.set(compiled, {
    files: complete ? files.map((file) => ({ ...file, identity: { ...file.identity } })) : [],
    missing: complete ? absent : [],
    adoptable: complete,
    root: { ...root }
  })
}

/** Used only at adoption: no await between the complete all-package fence and the CAS. */
export function assertFunctionSourcesCurrent(compiled: CompiledFunctionPlugin): void {
  const proof = proofs.get(compiled)
  if (!proof?.adoptable) throw Error("MODS_CONFIG_SOURCE_CHANGED")
  const fail = (): never => {
    throw Error("MODS_CONFIG_SOURCE_CHANGED")
  }
  const key = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path)
  const canonicalRoot = compiled.root
  if (key(realpathSync(canonicalRoot)) !== key(canonicalRoot)) fail()
  const directories = new Map<string, { path: string; identity: BigIntStats }>()
  const matches = (value: BigIntStats, identity: FunctionSourceIdentity) =>
    value.dev === identity.device && value.ino === identity.inode
  const directory = (path: string) => {
    const pathKey = key(path)
    if (directories.has(pathKey)) return
    const identity = lstatSync(path, { bigint: true })
    if (!identity.isDirectory() || identity.isSymbolicLink()) fail()
    directories.set(pathKey, { path, identity })
  }
  directory(canonicalRoot)
  if (!matches(directories.get(key(canonicalRoot))!.identity, proof.root)) fail()
  const pathFor = (input: string) => {
    if (!input || isAbsolute(input) || /[:\0]/.test(input)) fail()
    const parts = input.replace(/\\/g, "/").split("/")
    if (parts.some((part) => !part || part === ".." || part === "." || /[. ]$/.test(part))) fail()
    let path = canonicalRoot
    for (const part of parts.slice(0, -1)) {
      path = join(path, part)
      directory(path)
    }
    const file = join(path, parts.at(-1)!)
    const rel = relative(canonicalRoot, file)
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail()
    return file
  }
  const missing = (path: string) => {
    try {
      lstatSync(pathFor(path))
      fail()
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
      fail()
    }
  }
  for (const path of proof.missing) missing(path)
  for (const expected of proof.files) {
    const path = pathFor(expected.path)
    const leaf = lstatSync(path, { bigint: true })
    if (leaf.isSymbolicLink() || !leaf.isFile() || !matches(leaf, expected.identity)) fail()
    const flags =
      constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW) |
      (process.platform === "win32" ? 0 : constants.O_NONBLOCK)
    const fd = openSync(path, flags)
    try {
      const before = fstatSync(fd, { bigint: true })
      // Check the original authorized inode before reading, even if an ancestor was replaced.
      if (
        !before.isFile() ||
        !matches(before, expected.identity) ||
        before.size !== BigInt(expected.size)
      )
        fail()
      const bytes = Buffer.alloc(expected.size + 1)
      let length = 0
      while (length < bytes.length) {
        const received = readSync(fd, bytes, length, bytes.length - length, length)
        if (!received) break
        length += received
      }
      const after = fstatSync(fd, { bigint: true })
      const named = lstatSync(path, { bigint: true })
      if (
        length !== expected.size ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.dev !== after.dev ||
        named.ino !== after.ino ||
        createHash("sha256").update(bytes.subarray(0, length)).digest("hex") !== expected.hash
      )
        throw Error("MODS_CONFIG_SOURCE_CHANGED")
    } finally {
      closeSync(fd)
    }
  }
  for (const path of proof.missing) missing(path)
  for (const { path, identity } of directories.values()) {
    const current = lstatSync(path, { bigint: true })
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      fail()
  }
  if (key(realpathSync(canonicalRoot)) !== key(canonicalRoot)) fail()
}
