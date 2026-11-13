import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { listPackage, statFile, uncache } from "@electron/asar"

export interface PackagedArtifactIntegrity {
  passed: boolean
  unpackedFiles: number
  verifiedFiles: number
  comparedFiles: number
  missing: string[]
  invalid: string[]
  archiveSha256: string
  executableSha256: string
}

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

function inside(root: string, file: string): boolean {
  const tail = relative(root, file)
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
}

async function regularFile(file: string): Promise<boolean> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
    throw error
  })
  return !!info?.isFile() && !info.isSymbolicLink()
}

async function inventory(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw Error("PACKAGED_ARTIFACT_LINK_INVALID")
      if (entry.isDirectory()) pending.push(file)
      else if (entry.isFile()) files.set(relative(root, file).split(sep).join("/"), file)
      else throw Error("PACKAGED_ARTIFACT_ENTRY_INVALID")
    }
  }
  return files
}

/** Verify the actual downloaded artifact, including hidden unpacked files declared by ASAR. */
export async function verifyPackagedArtifactIntegrity(
  packageDirectory: string,
  expectedPackageDirectory?: string
): Promise<PackagedArtifactIntegrity> {
  const root = await realpath(resolve(packageDirectory))
  const archive = join(root, "resources", "app.asar")
  const executable = join(root, "CMBDevClaw.exe")
  for (const file of [archive, executable]) {
    if (!(await regularFile(file)) || !inside(root, await realpath(file)))
      throw Error("PACKAGED_ARTIFACT_ENTRY_INVALID")
  }
  const result: PackagedArtifactIntegrity = {
    passed: true,
    unpackedFiles: 0,
    verifiedFiles: 0,
    comparedFiles: 0,
    missing: [],
    invalid: [],
    archiveSha256: await digest(archive),
    executableSha256: await digest(executable)
  }
  const unpackedRoot = `${archive}.unpacked`
  // A previous validation in this process must not lend another archive its cached header.
  uncache(archive)
  try {
    for (const entry of listPackage(archive, { isPack: false })) {
      const name = entry.replaceAll("\\", "/").replace(/^\//, "")
      if (
        !name ||
        name.split("/").some((part) => !part || part === "." || part === "..") ||
        name.includes(":") ||
        name.includes("\0")
      )
        throw Error("PACKAGED_ARTIFACT_PATH_INVALID")
      const info = statFile(archive, normalize(name), false)
      if (!("size" in info) || !info.unpacked) continue
      result.unpackedFiles++
      const file = join(unpackedRoot, name)
      if (!(await regularFile(file))) {
        result.missing.push(`resources/app.asar.unpacked/${name}`)
        continue
      }
      if (!inside(root, await realpath(file)) || !inside(unpackedRoot, await realpath(file))) {
        result.invalid.push(`resources/app.asar.unpacked/${name}`)
        continue
      }
      const metadata = await lstat(file)
      if (
        metadata.size !== info.size ||
        info.integrity?.algorithm !== "SHA256" ||
        !/^[a-f0-9]{64}$/i.test(info.integrity.hash) ||
        (await digest(file)) !== info.integrity.hash.toLowerCase()
      ) {
        result.invalid.push(`resources/app.asar.unpacked/${name}`)
        continue
      }
      result.verifiedFiles++
    }
  } finally {
    uncache(archive)
  }
  if (expectedPackageDirectory) {
    const expected = await inventory(await realpath(resolve(expectedPackageDirectory)))
    const downloaded = await inventory(root)
    const missing = new Set(result.missing)
    const invalid = new Set(result.invalid)
    for (const [name, original] of expected) {
      const received = downloaded.get(name)
      if (!received) {
        missing.add(name)
        continue
      }
      downloaded.delete(name)
      const [originalInfo, receivedInfo] = await Promise.all([lstat(original), lstat(received)])
      if (
        originalInfo.size !== receivedInfo.size ||
        (await digest(original)) !== (await digest(received))
      )
        invalid.add(name)
      result.comparedFiles++
    }
    for (const name of downloaded.keys()) invalid.add(`unexpected:${name}`)
    result.missing = [...missing]
    result.invalid = [...invalid]
  }
  result.passed = result.missing.length === 0 && result.invalid.length === 0
  return result
}
