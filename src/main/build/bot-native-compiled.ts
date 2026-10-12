import { createHash } from "node:crypto"
import { lstat, opendir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
  botNativeDistributionPin,
  type BotNativeDistributionPin
} from "../bots/native-shell-release"
import { openStableFileHandle } from "../services/stable-file-handle"
import { locateStableAsarMember, readStableAsarHeader } from "../services/stable-asar-reader"
import { MAIN_GENERATED_SCRIPTS } from "./main-generated-scripts"
import type { Plugin } from "vite"

export const BOT_NATIVE_COMPILED_SEAL = "bot-native-build.json"
const sealLimit = 256 * 1024
const memberLimit = 64 * 1024 * 1024
const totalLimit = 512 * 1024 * 1024
const memberName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}\.(?:js|cjs|mjs)$/
function validMemberName(name: string): boolean {
  return memberName.test(name) || MAIN_GENERATED_SCRIPTS.some((generated) => generated === name)
}
const sealSchema = z
  .object({
    format: z.literal(1),
    buildId: z.string().regex(/^[a-f0-9]{24}$/),
    nativeDistribution: botNativeDistributionPin.nullable(),
    members: z
      .array(
        z
          .object({
            name: z.string().refine(validMemberName),
            bytes: z.number().int().nonnegative().max(memberLimit),
            sha256: z.string().regex(/^[a-f0-9]{64}$/)
          })
          .strict()
      )
      .min(2)
      .max(1024)
  })
  .strict()
  .superRefine((value, context) => {
    const names = new Set(value.members.map((member) => member.name))
    if (
      names.size !== value.members.length ||
      !names.has("index.js") ||
      !names.has("bot-host.js") ||
      value.members.reduce((total, member) => total + member.bytes, 0) > totalLimit
    )
      context.addIssue({
        code: "custom",
        message: "Invalid compiled Main/Host member inventory"
      })
  })

/** Generated only from the same verified pin/build identity and actual final
 * Rollup chunks and emitted script assets used by Main/Host. Packaging must
 * never create or repair it. */
export function botNativeCompiledSealPlugin(
  pin: BotNativeDistributionPin | null,
  buildId: string
): Plugin {
  return {
    name: "seal-bot-native-compiled-distribution",
    generateBundle(_options, bundle) {
      const members = Object.values(bundle)
        .filter((output) => /\.(?:js|cjs|mjs)$/.test(output.fileName))
        .map((output) => {
          const code = output.type === "chunk" ? output.code : output.source
          return {
            name: output.fileName,
            bytes: typeof code === "string" ? Buffer.byteLength(code) : code.byteLength,
            sha256: createHash("sha256").update(code).digest("hex")
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
      const seal = JSON.stringify(
        sealSchema.parse({
          format: 1,
          buildId,
          nativeDistribution: pin,
          members
        })
      )
      if (Buffer.byteLength(seal) > sealLimit)
        throw new Error("Compiled native seal exceeds its limit")
      this.emitFile({
        type: "asset",
        fileName: BOT_NATIVE_COMPILED_SEAL,
        source: seal
      })
    }
  }
}

type Member = { name: string; bytes: number; sha256: string }
type PhysicalIdentity = {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}
async function physicalMember(
  root: string,
  name: string,
  maximum: number,
  observed: Map<string, PhysicalIdentity>
): Promise<{
  bytes: number
  hash: string
  contents?: Buffer
}> {
  const path = join(root, name)
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maximum) ||
    (await realpath(path)) !== path
  )
    throw new Error("Compiled application member is not a bounded physical file")
  const file = await openStableFileHandle(root, path)
  try {
    if (
      file.identity.device !== before.dev ||
      file.identity.inode !== before.ino ||
      file.identity.size !== before.size
    )
      throw new Error("Compiled application member changed")
    const contents = name === BOT_NATIVE_COMPILED_SEAL ? Buffer.alloc(file.size) : undefined
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, file.size)))
    const hash = createHash("sha256")
    let bytes = 0
    while (bytes < file.size) {
      const part = await file.handle.read(
        buffer,
        0,
        Math.min(buffer.length, file.size - bytes),
        bytes
      )
      if (!part.bytesRead) throw new Error("Compiled application member was truncated")
      hash.update(buffer.subarray(0, part.bytesRead))
      contents?.set(buffer.subarray(0, part.bytesRead), bytes)
      bytes += part.bytesRead
    }
    await file.assertPathIdentity()
    const final = await file.handle.stat({ bigint: true })
    if (
      final.size !== before.size ||
      final.mtimeNs !== before.mtimeNs ||
      final.ctimeNs !== before.ctimeNs
    )
      throw new Error("Compiled application member changed during verification")
    // Preserve the first observation, including when the seal is read again.
    // Later reads must never reset the identity of an already verified member.
    if (!observed.has(path))
      observed.set(path, {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeNs: before.mtimeNs,
        ctimeNs: before.ctimeNs
      })
    return {
      bytes,
      hash: hash.digest("hex"),
      ...(contents ? { contents } : {})
    }
  } finally {
    await file.handle.close()
  }
}

/** Inspect actual installer bytes without loading product JS or parsing its
 * source. ASAR metadata uses the existing Pickle/Filesystem implementation;
 * all reads stay on one pinned handle with bounded header and stream buffers. */
export async function verifyPackagedBotNativeCompiled(
  resourcesDirectory: string,
  expected: BotNativeDistributionPin | null
): Promise<void> {
  const resources = await realpath(resourcesDirectory)
  const observed = new Map<string, PhysicalIdentity>()
  const archive = join(resources, "app.asar")
  let archivePresent = true
  try {
    await lstat(archive)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    archivePresent = false
  }
  if (!archivePresent) {
    const main = join(resources, "app", "out", "main")
    if ((await realpath(main)) !== main || !(await lstat(main)).isDirectory())
      throw new Error("Compiled application directory is not physical")
    const raw = await physicalMember(main, BOT_NATIVE_COMPILED_SEAL, sealLimit, observed)
    if (!raw.contents) throw new Error("Compiled native seal is missing")
    const seal = sealSchema.parse(JSON.parse(raw.contents.toString("utf8")))
    assertPin(seal.nativeDistribution, expected)
    await assertPhysicalMembers(main, seal.members)
    for (const member of seal.members)
      assertMember(await physicalMember(main, member.name, memberLimit, observed), member)
    // Re-read the small seal; it must not be replaced while other code hashes run.
    if (
      (await physicalMember(main, BOT_NATIVE_COMPILED_SEAL, sealLimit, observed)).hash !== raw.hash
    )
      throw new Error("Compiled native seal changed during verification")
    await assertObservedPhysical(observed)
    return
  }
  const before = await lstat(archive, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (await realpath(archive)) !== archive
  )
    throw new Error("Application archive is not a physical file")
  const opened = await openStableFileHandle(resources, archive)
  try {
    if (
      opened.identity.device !== before.dev ||
      opened.identity.inode !== before.ino ||
      opened.identity.size !== before.size
    )
      throw new Error("Application archive changed")
    const header = await readStableAsarHeader(opened),
      { filesystem } = header
    for (const directory of ["out", "out/main"]) {
      if (!("files" in filesystem.getFile(join(...directory.split("/")), false)))
        throw new Error("Compiled archive directory cannot be a link")
    }
    const main = filesystem.getFile(join("out", "main"), false)
    if (!("files" in main)) throw new Error("Compiled archive directory is missing")
    const read = async (name: string, maximum: number, contentsRequired = false) => {
      const info = locateStableAsarMember(opened, header, join("out", "main", name), maximum)
      if ("unpackedPath" in info) {
        const value = await physicalMember(
          join(`${archive}.unpacked`, "out/main"),
          name,
          maximum,
          observed
        )
        if (value.bytes !== info.size) throw new Error("Unpacked compiled member size differs")
        return value
      }
      const start = info.offset
      const hash = createHash("sha256"),
        contents = contentsRequired ? Buffer.alloc(info.size) : undefined
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, info.size)))
      let bytes = 0
      while (bytes < info.size) {
        const part = await opened.handle.read(
          buffer,
          0,
          Math.min(buffer.length, info.size - bytes),
          start + bytes
        )
        if (!part.bytesRead) throw new Error("Compiled archive member was truncated")
        hash.update(buffer.subarray(0, part.bytesRead))
        contents?.set(buffer.subarray(0, part.bytesRead), bytes)
        bytes += part.bytesRead
      }
      return {
        bytes,
        hash: hash.digest("hex"),
        ...(contents ? { contents } : {})
      }
    }
    const raw = await read(BOT_NATIVE_COMPILED_SEAL, sealLimit, true)
    if (!raw.contents) throw new Error("Compiled native seal is missing")
    const seal = sealSchema.parse(JSON.parse(raw.contents.toString("utf8")))
    assertPin(seal.nativeDistribution, expected)
    const names = Object.keys(main.files)
    for (const [name, entry] of Object.entries(main.files)) {
      if (name === "generated") {
        if (!("files" in entry)) throw new Error("Compiled generated directory cannot be a link")
        for (const [child, info] of Object.entries(entry.files)) {
          if ("files" in info)
            throw new Error("Compiled Main/Host contains an unexpected directory")
          names.push(`generated/${child}`)
        }
      } else if ("files" in entry)
        throw new Error("Compiled Main/Host contains an unexpected directory")
    }
    assertNames(names, seal.members)
    for (const member of seal.members) assertMember(await read(member.name, memberLimit), member)
    await assertObservedPhysical(observed)
    await opened.assertPathIdentity()
    const final = await opened.handle.stat({ bigint: true })
    if (
      final.size !== before.size ||
      final.mtimeNs !== before.mtimeNs ||
      final.ctimeNs !== before.ctimeNs
    )
      throw new Error("Application archive changed during verification")
  } finally {
    await opened.handle.close()
  }
}
async function assertObservedPhysical(observed: Map<string, PhysicalIdentity>) {
  for (const [path, before] of observed) {
    const named = await lstat(path, { bigint: true })
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1n ||
      (await realpath(path)) !== path ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.size !== before.size ||
      named.mtimeNs !== before.mtimeNs ||
      named.ctimeNs !== before.ctimeNs
    )
      throw new Error("Compiled physical members changed during verification")
  }
}
function assertPin(
  actual: BotNativeDistributionPin | null,
  expected: BotNativeDistributionPin | null
) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Compiled Main/Host native pin differs from the release inputs")
}
function assertMember(actual: { bytes: number; hash: string }, expected: Member) {
  if (actual.bytes !== expected.bytes || actual.hash !== expected.sha256)
    throw new Error(`Compiled Main/Host member digest differs: ${expected.name}`)
}
function assertNames(names: string[], members: Member[]) {
  const code = names.filter((name) => /\.(?:js|cjs|mjs)$/.test(name))
  const expected = new Set(members.map((member) => member.name))
  if (code.length !== expected.size || code.some((name) => !expected.has(name)))
    throw new Error("Compiled Main/Host contains an unsealed code member")
}
async function assertPhysicalMembers(directory: string, members: Member[]) {
  const names: string[] = []
  const entries = await opendir(directory, { bufferSize: 16 })
  for await (const entry of entries) {
    if (entry.name === "generated") {
      const generated = join(directory, entry.name)
      if (!entry.isDirectory() || (await realpath(generated)) !== generated)
        throw new Error("Compiled generated directory is not physical")
      const scripts = await opendir(generated, { bufferSize: 16 })
      for await (const script of scripts) {
        if (script.isDirectory())
          throw new Error("Compiled Main/Host contains an unexpected directory")
        if (/\.(?:js|cjs|mjs)$/.test(script.name)) names.push(`generated/${script.name}`)
        if (names.length > 1024) throw new Error("Compiled Main/Host contains too many members")
      }
    } else if (entry.isDirectory())
      throw new Error("Compiled Main/Host contains an unexpected directory")
    if (/\.(?:js|cjs|mjs)$/.test(entry.name)) names.push(entry.name)
    if (names.length > 1024) throw new Error("Compiled Main/Host contains too many members")
  }
  assertNames(names, members)
}
