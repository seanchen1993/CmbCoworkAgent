/** One-off disk-constrained preview logistics. Never edits an existing package or creates NSIS.
 * Only compiled out/main/index.js and the optional original generated Job controller may differ.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream, type WriteStream } from "node:fs"
import { link, lstat, mkdir, readFile, readdir, statfs, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { finished } from "node:stream/promises"
import * as asar from "@electron/asar"
import asarFs from "@electron/asar/lib/wrapped-fs"
import { getCurrentFuseWire } from "@electron/fuses"
import { NtExecutable, NtExecutableResource } from "resedit"
import { runtimeRelativePath } from "../src/main/harness-board/project-runtime/safe-files"
import { assertFreshPackageOutput } from "./mods-package-stage"

const BASE_ASAR = "a07d444c3fa126f4cec4b9fe0e0f78fe3b1826770d7d154aebb1eb3680922b0a"
const MAIN = "out/main/index.js"
const ARCHIVE = "resources/app.asar"
const EXE = "CMBDevClaw.exe"
const UNPACKED = `${ARCHIVE}.unpacked/`
const CONTROLLER_SOURCE = "resources/bin/win32/background-job-controller.exe"
const CONTROLLER_DESTINATION = `resources/bin/win32/background-job-controller.exe`
const CONTROLLER_CS = "scripts/windows-background-job-controller.cs"
const CONTROLLER_GENERATOR = "scripts/build-windows-background-job-controller.mjs"
const CONTROLLER_RECEIPT = "output/windows-job-controller-build.json"
const hashBytes = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex")
const portable = (path: string): string => path.split(sep).join("/")

interface Leaf {
  path: string
  size: number
  sha256: string
}
interface Inventory {
  directories: string[]
  files: Leaf[]
}
interface ArchiveEntry {
  path: string
  directory: boolean
  unpacked: boolean
  size?: number
  sha256?: string
  executable?: boolean
}
interface Pins {
  asar: string
  executable: string
  header: string
  inventory: string
  main: string
}
interface ControllerPins {
  executable: string
  receipt: string
  source: string
  generator: string
}
interface IntegrityEntry {
  file: string
  alg: string
  value: string
}

export function assertGeneratedController(
  oldBytes: Buffer,
  bytes: Buffer,
  receipt: unknown,
  pins: ControllerPins
): void {
  assert.equal(hashBytes(bytes), pins.executable)
  assert(receipt && typeof receipt === "object")
  assert.deepEqual(Object.keys(receipt).sort(), ["executable", "source"])
  assert.deepEqual(receipt, { source: pins.source, executable: pins.executable })
  // No ignoreCert: reject signatures/unknown PE; retain original helper architecture.
  assert.equal(NtExecutable.from(bytes).is32bit(), NtExecutable.from(oldBytes).is32bit())
  assert(
    bytes.includes(Buffer.from("MODS_PROCESS_STARTED_V1\n", "utf16le")),
    "Unknown controller protocol"
  )
}

async function hashFile(path: string): Promise<string> {
  const before = await lstat(path, { bigint: true })
  assert(before.isFile() && !before.isSymbolicLink(), `Not an ordinary file: ${path}`)
  const digest = createHash("sha256")
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  const after = await lstat(path, { bigint: true })
  assert(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs,
    `Input changed during read: ${path}`
  )
  return digest.digest("hex")
}

/** Built-in Node22 recursion; reject links/devices rather than dereference another source. */
export async function readCandidateInventory(root: string): Promise<Inventory> {
  const rootInfo = await lstat(root)
  assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink())
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  assert(entries.length <= 100000, "Candidate inventory limit")
  const inventory: Inventory = { directories: [], files: [] }
  for (const entry of entries) {
    const file = join(entry.parentPath, entry.name)
    const path = runtimeRelativePath(portable(relative(root, file)))
    const info = await lstat(file)
    assert(!info.isSymbolicLink(), `Candidate link refused: ${path}`)
    if (info.isDirectory()) inventory.directories.push(path)
    else {
      assert(info.isFile(), `Unknown candidate entry: ${path}`)
      inventory.files.push({ path, size: info.size, sha256: await hashFile(file) })
    }
  }
  inventory.directories.sort()
  inventory.files.sort((a, b) => a.path.localeCompare(b.path, "en"))
  return inventory
}
export const inventoryDigest = (inventory: Inventory): string =>
  hashBytes(JSON.stringify(inventory))

export function archiveEntries(archive: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  const visit = (node: asar.DirectoryRecord, prefix: string, inherited = false): void => {
    for (const [name, raw] of Object.entries(node.files)) {
      const path = runtimeRelativePath(prefix ? `${prefix}/${name}` : name)
      const unpacked = inherited || Boolean("unpacked" in raw && raw.unpacked)
      if ("files" in raw) {
        entries.push({ path, directory: true, unpacked })
        visit(raw, path, unpacked)
      } else {
        assert(!("link" in raw), `Archive links are outside this one-off contract: ${path}`)
        assert(raw.integrity?.algorithm === "SHA256" && /^[a-f0-9]{64}$/u.test(raw.integrity.hash))
        entries.push({
          path,
          directory: false,
          unpacked,
          size: raw.size,
          sha256: raw.integrity.hash,
          executable: Boolean("executable" in raw && raw.executable)
        })
      }
    }
  }
  visit(asar.getRawHeader(archive).header, "")
  assert(entries.length <= 100000)
  assert(entries.some((entry) => entry.path === MAIN && !entry.directory && !entry.unpacked))
  return entries
}

export function assertMainOnlyOut(
  entries: ArchiveEntry[],
  current: Inventory,
  mainSha: string
): void {
  const expected = entries.filter((entry) => entry.path.startsWith("out/") && !entry.directory)
  const actual = current.files.map((file) => ({ ...file, path: `out/${file.path}` }))
  assert.deepEqual(
    actual.map((file) => file.path).sort(),
    expected.map((file) => file.path).sort(),
    "New/removed out files are not supported; use the full packager"
  )
  for (const file of actual) {
    const base = expected.find((entry) => entry.path === file.path)!
    assert.equal(
      file.sha256,
      file.path === MAIN ? mainSha : base.sha256,
      `Only ${MAIN} may change; use the full packager: ${file.path}`
    )
    if (file.path !== MAIN) assert.equal(file.size, base.size)
  }
}

function integrityResource(bytes: Buffer): {
  executable: ReturnType<typeof NtExecutable.from>
  resources: ReturnType<typeof NtExecutableResource.from>
  entry: ReturnType<typeof NtExecutableResource.from>["entries"][number]
  values: IntegrityEntry[]
} {
  // No ignoreCert: pe-library rejects signed input. Never remove a signature to save space.
  const executable = NtExecutable.from(bytes)
  assert(!executable.is32bit(), "Only the original x64 PE is supported")
  const resources = NtExecutableResource.from(executable)
  const matches = resources.entries.filter(
    (entry) => entry.type === "INTEGRITY" && entry.id === "ELECTRONASAR"
  )
  assert.equal(matches.length, 1, "Missing/duplicate original Electron integrity resource")
  const values: unknown = JSON.parse(Buffer.from(matches[0].bin).toString("utf8"))
  assert(Array.isArray(values) && values.length > 0 && values.length <= 16)
  for (const item of values)
    assert(
      item &&
        typeof item.file === "string" &&
        item.alg === "SHA256" &&
        /^[a-f0-9]{64}$/u.test(item.value)
    )
  assert.equal(new Set(values.map((item) => item.file)).size, values.length)
  return { executable, resources, entry: matches[0], values: values as IntegrityEntry[] }
}

export function replaceIntegrityResource(
  bytes: Buffer,
  oldHeader: string,
  newHeader: string
): Buffer {
  assert(/^[a-f0-9]{64}$/u.test(oldHeader) && /^[a-f0-9]{64}$/u.test(newHeader))
  const parsed = integrityResource(bytes)
  const targets = parsed.values.filter((item) => item.file === "resources\\app.asar")
  assert.equal(targets.length, 1, "Unknown original app.asar integrity chain")
  assert.equal(targets[0].value, oldHeader)
  const next = parsed.values.map((item) =>
    item.file === "resources\\app.asar" ? { ...item, value: newHeader } : item
  )
  // Mature resedit replacement, not builder's append-only addWinAsarIntegrity on an existing PE.
  parsed.resources.replaceResourceEntry({
    ...parsed.entry,
    bin: Uint8Array.from(Buffer.from(JSON.stringify(next))).buffer
  })
  parsed.resources.outputResource(parsed.executable)
  const result = Buffer.from(parsed.executable.generate())
  const check = integrityResource(result)
  assert.deepEqual(check.values, next)
  const digestResources = (entries: typeof parsed.resources.entries): unknown =>
    entries
      .filter((entry) => !(entry.type === "INTEGRITY" && entry.id === "ELECTRONASAR"))
      .map(({ type, id, lang, codepage, bin }) => ({
        type,
        id,
        lang,
        codepage,
        sha256: hashBytes(Buffer.from(bin))
      }))
  assert.deepEqual(
    digestResources(check.resources.entries),
    digestResources(parsed.resources.entries),
    "Other PE resources changed"
  )
  return result
}

let archiveWriterActive = false

/** The local official writer has no output-created callback. Its private wrapped-fs
 * factory is observed only for this standalone invocation, never Node's global fs.
 * Subscribing after createPackageFromStreams resolves is too late for body IO errors.
 */
export async function writeMainOnlyArchive(
  base: string,
  main: string,
  destination: string,
  onOutputCreatedForTest?: (output: WriteStream) => void
): Promise<void> {
  assert(
    !archiveWriterActive,
    "Only one exact runtime-delta archive writer may own the local adapter"
  )
  assert.notEqual(
    asarFs,
    process.getBuiltinModule("node:fs"),
    "Never modify the Node global filesystem object"
  )
  archiveWriterActive = true
  const originalFactory = asarFs.createWriteStream
  const builtinFactory = process.getBuiltinModule("node:fs")!.createWriteStream
  const owned = new Set<Readable | WriteStream>()
  const pending = new Set<Promise<void>>()
  const failed = Promise.withResolvers<never>()
  void failed.promise.catch(() => undefined)
  let failure: Error | undefined
  let producer: Promise<WriteStream> | undefined
  let producerSettled = false
  let factoryInstalled = false
  const abort = (error: unknown): void => {
    if (failure) return
    failure = error instanceof Error ? error : new Error(String(error))
    failed.reject(failure)
    for (const stream of owned) stream.destroy(failure)
  }
  const assertWriting = (): void => {
    if (failure) throw failure
  }
  const observe = <T extends Readable | WriteStream>(stream: T): T => {
    owned.add(stream)
    const settled = finished(stream, { cleanup: true }).then(
      () => {
        owned.delete(stream)
      },
      (error) => {
        owned.delete(stream)
        abort(error)
        throw error
      }
    )
    pending.add(settled)
    // Observe immediately, before handing the stream to any producer/user code.
    void settled.then(
      () => pending.delete(settled),
      () => pending.delete(settled)
    )
    return stream
  }
  const guardedFactory: typeof asarFs.createWriteStream = (path, options) => {
    assertWriting()
    assert(typeof path === "string")
    const target = resolve(path),
      output = resolve(destination)
    assert(
      target === output || target.startsWith(`${output}.unpacked${sep}`),
      "Unexpected official writer output"
    )
    const stream = observe(originalFactory(path, options))
    try {
      onOutputCreatedForTest?.(stream)
    } catch (error) {
      abort(error)
      throw error
    }
    return stream
  }
  const releaseFactory = (): void => {
    assert.equal(
      process.getBuiltinModule("node:fs")!.createWriteStream,
      builtinFactory,
      "Node global output factory changed"
    )
    if (factoryInstalled) {
      assert.equal(
        asarFs.createWriteStream,
        guardedFactory,
        "Archive output observer ownership changed"
      )
      asarFs.createWriteStream = originalFactory
    }
    archiveWriterActive = false
  }
  try {
    const entries = archiveEntries(base)
    const mainInfo = await lstat(main)
    assert(mainInfo.isFile() && !mainInfo.isSymbolicLink())
    const streams: asar.AsarStreamType[] = entries.map((entry) =>
      entry.directory
        ? { path: entry.path, type: "directory", unpacked: entry.unpacked }
        : {
            path: entry.path,
            type: "file",
            unpacked: entry.unpacked,
            stat: { size: entry.path === MAIN ? mainInfo.size : entry.size!, mode: 0o100644 },
            streamGenerator: () => {
              assertWriting()
              return observe(
                entry.path === MAIN
                  ? createReadStream(main)
                  : Readable.from(asar.extractFile(base, entry.path.split("/").join(sep)))
              )
            }
          }
    )
    asarFs.createWriteStream = guardedFactory
    factoryInstalled = true
    producer = asar.createPackageFromStreams(destination, streams)
    void producer.then(
      () => {
        producerSettled = true
      },
      () => {
        producerSettled = true
      }
    )
    // Both rejection observers are installed before the first header/body IO can complete.
    await Promise.race([producer, failed.promise])
    await Promise.race([Promise.all([...pending]), failed.promise])
    assertWriting()
  } catch (error) {
    abort(error)
    // Destroyed source streams reject the official pipe wait as well. Retain a
    // finite failure path even if a native close/producer cannot confirm drain.
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...(producer ? [producer] : []), ...pending]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("RUNTIME_DELTA_IO_DRAIN_UNCONFIRMED", { cause: failure })),
            5000
          )
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    throw failure
  } finally {
    if ((!producer || producerSettled) && pending.size === 0) releaseFactory()
    else {
      // Unknown cleanup cannot unlock a new writer. The exact old producer may
      // release only its own adapter after it actually settles; rejection is observed.
      void Promise.allSettled([...(producer ? [producer] : []), ...pending])
        .then(releaseFactory)
        .catch(() => undefined)
    }
  }
}

async function assertArchiveBytes(base: string, output: string, mainSha: string): Promise<void> {
  const original = archiveEntries(base),
    current = archiveEntries(output)
  assert.deepEqual(
    current.map((entry) => ({ ...entry, size: undefined, sha256: undefined })),
    original.map((entry) => ({ ...entry, size: undefined, sha256: undefined }))
  )
  for (let index = 0; index < original.length; index++) {
    const before = original[index],
      after = current[index]
    if (before.directory) continue
    const expected = before.path === MAIN ? mainSha : before.sha256
    assert.equal(after.sha256, expected)
    if (before.path !== MAIN) assert.equal(after.size, before.size)
    assert.equal(
      hashBytes(asar.extractFile(output, before.path.split("/").join(sep))),
      expected,
      `Actual new archive/unpacked bytes differ: ${before.path}`
    )
  }
}

export async function buildRuntimeDeltaPreview(input: {
  repo: string
  base: string
  destination: string
  pins: Pins
  controller?: ControllerPins
}): Promise<void> {
  assert.equal(process.platform, "win32")
  assert.equal(Number(process.versions.node.split(".")[0]), 22)
  assert.equal(input.pins.asar, BASE_ASAR, "Only the exact a07 handoff candidate is supported")
  for (const value of Object.values(input.pins)) assert(/^[a-f0-9]{64}$/u.test(value))
  const root = resolve(input.repo),
    base = resolve(input.base)
  const packageOutput = await assertFreshPackageOutput(root, input.destination)
  assert.equal(
    dirname(packageOutput),
    join(root, "output/mods-v2-validation"),
    "Use one fresh direct candidate directory under output/mods-v2-validation"
  )
  const output = join(packageOutput, "win-unpacked")
  const baseArchive = join(base, ARCHIVE),
    baseExe = join(base, EXE),
    newMain = join(root, MAIN)
  const header = asar.getRawHeader(baseArchive)
  assert.equal(await hashFile(baseArchive), input.pins.asar)
  assert.equal(hashBytes(header.headerString), input.pins.header)
  assert.equal(await hashFile(baseExe), input.pins.executable)
  const before = await readCandidateInventory(base)
  assert.equal(inventoryDigest(before), input.pins.inventory)
  const oldEntries = archiveEntries(baseArchive)
  assert.equal(await hashFile(newMain), input.pins.main)
  const currentOut = await readCandidateInventory(join(root, "out"))
  assertMainOnlyOut(oldEntries, currentOut, input.pins.main)
  const packageNow = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const packageThen = JSON.parse(asar.extractFile(baseArchive, "package.json").toString("utf8"))
  for (const key of [
    "name",
    "version",
    "main",
    "engines",
    "dependencies",
    "optionalDependencies",
    "peerDependencies"
  ]) {
    assert.deepEqual(
      packageNow[key],
      packageThen[key],
      `Package ${key} changed; use the full packager`
    )
  }
  const originalExe = await readFile(baseExe)
  const pe = integrityResource(originalExe)
  assert.equal(
    pe.values.find((item) => item.file === "resources\\app.asar")?.value,
    input.pins.header
  )
  for (const item of pe.values) {
    const file = runtimeRelativePath(item.file.replaceAll("\\", "/"))
    assert.equal(
      hashBytes(asar.getRawHeader(join(base, file)).headerString),
      item.value,
      "Original embedded ASAR chain is incomplete"
    )
  }
  const beforeFuses = await getCurrentFuseWire(baseExe)
  const baseController = before.files.find((file) => file.path === CONTROLLER_DESTINATION)
  assert(baseController, "Original controller resource path is missing")
  const currentController = await readFile(join(root, CONTROLLER_SOURCE))
  assert.equal(await hashFile(join(root, CONTROLLER_SOURCE)), hashBytes(currentController))
  if (input.controller) {
    for (const pin of Object.values(input.controller)) assert(/^[a-f0-9]{64}$/u.test(pin))
    assert.equal(hashBytes(currentController), input.controller.executable)
    assert.equal(await hashFile(join(root, CONTROLLER_RECEIPT)), input.controller.receipt)
    assert.equal(await hashFile(join(root, CONTROLLER_CS)), input.controller.source)
    assert.equal(await hashFile(join(root, CONTROLLER_GENERATOR)), input.controller.generator)
    const generated: unknown = JSON.parse(await readFile(join(root, CONTROLLER_RECEIPT), "utf8"))
    assertGeneratedController(
      await readFile(join(base, CONTROLLER_DESTINATION)),
      currentController,
      generated,
      input.controller
    )
  } else {
    assert.equal(
      hashBytes(currentController),
      baseController.sha256,
      "Generated controller changed: require exact executable/source/generator/receipt pins, never pair new main with an unproven helper"
    )
  }
  const ownsPath = (path: string): boolean =>
    path === ARCHIVE ||
    path === EXE ||
    path.startsWith(UNPACKED) ||
    Boolean(input.controller && path === CONTROLLER_DESTINATION)
  const ownBytes = before.files
    .filter((file) => ownsPath(file.path))
    .reduce((sum, file) => sum + file.size, 0)
  const available = await statfs(root)
  const required =
    ownBytes +
    Math.max(
      0,
      (await lstat(newMain)).size - (oldEntries.find((entry) => entry.path === MAIN)?.size ?? 0)
    ) +
    (input.controller ? Math.max(0, currentController.length - baseController.size) : 0) +
    128 * 1024 * 1024
  assert(
    available.bavail * available.bsize >= required,
    `Insufficient space: need ${required} bytes plus later acceptance artifacts; no files were removed`
  )
  await mkdir(packageOutput)
  await mkdir(output)
  const receipt: Record<string, unknown> = {
    status: "building-not-accepted",
    base,
    output,
    pins: input.pins,
    controller: input.controller ?? null,
    ownBytes,
    requiredBytes: required,
    availableBytes: available.bavail * available.bsize,
    sourceInventory: input.pins.inventory,
    startedAt: new Date().toISOString(),
    limitations: [
      "One-off fixed runtime-delta test package. Not NSIS/release/signing or renderer packaging.",
      "Unchanged runtime files share hardlinks; do not mutate either package's immutable resources.",
      "Actual App acceptance is mandatory and has not been performed by this script."
    ]
  }
  let receiptCreated = false
  const record = async (): Promise<void> => {
    await writeFile(
      join(packageOutput, "runtime-delta-build-evidence.json"),
      JSON.stringify(receipt, null, 2),
      { flag: receiptCreated ? "w" : "wx" }
    )
    receiptCreated = true
  }
  await record()
  try {
    for (const directory of before.directories)
      await mkdir(join(output, directory), { recursive: true })
    for (const file of before.files) {
      if (ownsPath(file.path)) continue
      await link(join(base, file.path), join(output, file.path))
    }
    await writeMainOnlyArchive(baseArchive, newMain, join(output, ARCHIVE))
    const newHeader = hashBytes(asar.getRawHeader(join(output, ARCHIVE)).headerString)
    await writeFile(
      join(output, EXE),
      replaceIntegrityResource(originalExe, input.pins.header, newHeader),
      { flag: "wx" }
    )
    if (input.controller)
      await writeFile(join(output, CONTROLLER_DESTINATION), currentController, { flag: "wx" })
    assert.deepEqual(
      await getCurrentFuseWire(join(output, EXE)),
      beforeFuses,
      "Electron fuses changed"
    )
    await assertArchiveBytes(baseArchive, join(output, ARCHIVE), input.pins.main)
    const after = await readCandidateInventory(output)
    assert.deepEqual(after.directories, before.directories)
    assert.deepEqual(
      after.files.map((file) => file.path),
      before.files.map((file) => file.path)
    )
    for (const file of before.files) {
      const actual = after.files.find((item) => item.path === file.path)!
      if (file.path === CONTROLLER_DESTINATION && input.controller) {
        assert.equal(actual.sha256, input.controller.executable)
        assert.equal(actual.size, currentController.length)
      } else if (file.path !== ARCHIVE && file.path !== EXE) assert.deepEqual(actual, file)
      const oldStat = await lstat(join(base, file.path), { bigint: true })
      const newStat = await lstat(join(output, file.path), { bigint: true })
      const owns = ownsPath(file.path)
      assert.equal(
        oldStat.dev === newStat.dev && oldStat.ino === newStat.ino,
        !owns,
        `Unexpected independent/hardlinked output ownership: ${file.path}`
      )
    }
    assert.equal(
      inventoryDigest(await readCandidateInventory(base)),
      input.pins.inventory,
      "Original candidate changed; never publish this output"
    )
    assert.equal(await hashFile(newMain), input.pins.main)
    assert.equal(await hashFile(join(root, CONTROLLER_SOURCE)), hashBytes(currentController))
    if (input.controller) {
      assert.equal(await hashFile(join(root, CONTROLLER_RECEIPT)), input.controller.receipt)
      assert.equal(await hashFile(join(root, CONTROLLER_CS)), input.controller.source)
      assert.equal(await hashFile(join(root, CONTROLLER_GENERATOR)), input.controller.generator)
    }
    assert.deepEqual(
      await readCandidateInventory(join(root, "out")),
      currentOut,
      "Normal build changed during packaging"
    )
    receipt.status = "built-not-accepted"
    receipt.asarSha256 = await hashFile(join(output, ARCHIVE))
    receipt.executableSha256 = await hashFile(join(output, EXE))
    receipt.headerSha256 = newHeader
    receipt.outputInventorySha256 = inventoryDigest(after)
  } catch (error) {
    receipt.status = "failed-partial-preserved-not-accepted"
    receipt.error = error instanceof Error ? error.stack : String(error)
    throw error
  } finally {
    receipt.finishedAt = new Date().toISOString()
    await record()
  }
}

async function main(): Promise<void> {
  const args = new Map<string, string>()
  const keys = [
    "--base",
    "--output",
    "--base-asar-sha",
    "--base-exe-sha",
    "--base-header-sha",
    "--base-inventory-sha",
    "--main-sha"
  ]
  const controllerKeys = [
    "--controller-sha",
    "--controller-receipt-sha",
    "--controller-source-sha",
    "--controller-generator-sha"
  ]
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index],
      value = process.argv[index + 1]
    assert(
      [...keys, ...controllerKeys].includes(key) && value && !args.has(key),
      `Unknown/missing/duplicate argument: ${key}`
    )
    args.set(key, value)
  }
  assert(
    keys.every((key) => args.has(key)),
    `Required: ${keys.join(" ")}`
  )
  const hasController = controllerKeys.some((key) => args.has(key))
  assert(
    !hasController || controllerKeys.every((key) => args.has(key)),
    "All four controller pins are required together"
  )
  await buildRuntimeDeltaPreview({
    repo: process.cwd(),
    base: args.get("--base")!,
    destination: args.get("--output")!,
    controller: hasController
      ? {
          executable: args.get("--controller-sha")!,
          receipt: args.get("--controller-receipt-sha")!,
          source: args.get("--controller-source-sha")!,
          generator: args.get("--controller-generator-sha")!
        }
      : undefined,
    pins: {
      asar: args.get("--base-asar-sha")!,
      executable: args.get("--base-exe-sha")!,
      header: args.get("--base-header-sha")!,
      inventory: args.get("--base-inventory-sha")!,
      main: args.get("--main-sha")!
    }
  })
}
if (
  process.argv[1] &&
  resolve(process.argv[1]).endsWith(`${sep}build-mods-runtime-delta-preview.ts`)
) {
  void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
