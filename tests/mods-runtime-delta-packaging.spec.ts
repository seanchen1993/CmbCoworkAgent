/** Small test artifacts only. No real candidate/build/App or cleanup/deletion operations. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import type { WriteStream } from "node:fs"
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { Readable } from "node:stream"
import { finished } from "node:stream/promises"
import { test } from "node:test"
import * as asar from "@electron/asar"
import asarFs from "@electron/asar/lib/wrapped-fs"
import { Format, NtExecutable, NtExecutableResource } from "resedit"
import {
  archiveEntries,
  assertGeneratedController,
  assertMainOnlyOut,
  replaceIntegrityResource,
  writeMainOnlyArchive
} from "../scripts/build-mods-runtime-delta-preview"

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex")
const resourceBin = (value: string, encoding: BufferEncoding = "utf8"): ArrayBuffer =>
  Uint8Array.from(Buffer.from(value, encoding)).buffer
const main = "out/main/index.js",
  oldMain = "original-main",
  newMain = "normal-new-main"

test("official ASAR stream API keeps exact file set/unpacked bytes and changes only main", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmb-runtime-delta-unit-"))
  const base = join(root, "base.asar"),
    output = join(root, "candidate.asar"),
    source = join(root, "main.js")
  const files = new Map([
    [main, oldMain],
    ["out/resources/tool.bin", "immutable-tool"],
    ["node_modules/vendor/index.js", "immutable-vendor"]
  ])
  const streams: asar.AsarStreamType[] = [...files].map(([path, bytes]) => ({
    type: "file",
    path,
    unpacked: path.endsWith("tool.bin"),
    stat: { size: Buffer.byteLength(bytes), mode: 0o100644 },
    streamGenerator: () => Readable.from(Buffer.from(bytes))
  }))
  await finished(await asar.createPackageFromStreams(base, streams))
  const originalBytes = digest(await readFile(base))
  await writeFile(source, newMain)
  await writeMainOnlyArchive(base, source, output)
  const before = archiveEntries(base),
    after = archiveEntries(output)
  assert.deepEqual(
    after.map((entry) => ({ path: entry.path, unpacked: entry.unpacked })),
    before.map((entry) => ({ path: entry.path, unpacked: entry.unpacked }))
  )
  for (const [path, bytes] of files) {
    assert.equal(
      asar.extractFile(output, path.split("/").join(sep)).toString("utf8"),
      path === main ? newMain : bytes
    )
  }
  assert.equal(digest(await readFile(base)), originalBytes)
  const oldUnpacked = await lstat(join(`${base}.unpacked`, "out/resources/tool.bin"), {
    bigint: true
  })
  const newUnpacked = await lstat(join(`${output}.unpacked`, "out/resources/tool.bin"), {
    bigint: true
  })
  assert(oldUnpacked.dev !== newUnpacked.dev || oldUnpacked.ino !== newUnpacked.ino)
  const out = {
    directories: ["main", "resources"],
    files: [
      { path: "main/index.js", size: Buffer.byteLength(newMain), sha256: digest(newMain) },
      {
        path: "resources/tool.bin",
        size: Buffer.byteLength("immutable-tool"),
        sha256: digest("immutable-tool")
      }
    ]
  }
  assert.doesNotThrow(() => assertMainOnlyOut(before, out, digest(newMain)))
  assert.throws(() =>
    assertMainOnlyOut(before, { ...out, files: out.files.slice(0, 1) }, digest(newMain))
  )
  assert.throws(() =>
    assertMainOnlyOut(
      before,
      {
        ...out,
        files: [...out.files, { path: "main/new-chunk.js", size: 1, sha256: digest("x") }]
      },
      digest(newMain)
    )
  )
  assert.throws(() =>
    assertMainOnlyOut(
      before,
      {
        ...out,
        files: out.files.map((file) =>
          file.path === "resources/tool.bin" ? { ...file, sha256: digest("changed") } : file
        )
      },
      digest(newMain)
    )
  )
  console.log(`Retained small unit artifacts (no deletion): ${root}`)
})

function executable(integrity: unknown, duplicate = false): Buffer {
  const exe = NtExecutable.createEmpty(false, false)
  const resources = NtExecutableResource.from(exe)
  const item = {
    type: "INTEGRITY",
    id: "ELECTRONASAR",
    lang: 1033,
    codepage: 1200,
    bin: resourceBin(JSON.stringify(integrity))
  }
  resources.entries.push(item)
  if (duplicate) resources.entries.push({ ...item, lang: 2052 })
  resources.entries.push({
    type: 10,
    id: 1,
    lang: 1033,
    codepage: 1200,
    bin: resourceBin("unchanged-other-resource")
  })
  resources.outputResource(exe)
  return Buffer.from(exe.generate())
}

test("resedit replaces the unique header resource, preserving other integrity items and resources", () => {
  const old = "a".repeat(64),
    next = "b".repeat(64),
    other = "c".repeat(64)
  const values = [
    { file: "resources\\app.asar", alg: "SHA256", value: old },
    { file: "resources\\default_app.asar", alg: "SHA256", value: other }
  ]
  const original = executable(values),
    originalHash = digest(original)
  const updated = replaceIntegrityResource(original, old, next)
  const resources = NtExecutableResource.from(NtExecutable.from(updated))
  const matches = resources.entries.filter((item) => item.type === "INTEGRITY")
  assert.equal(matches.length, 1)
  assert.deepEqual(JSON.parse(Buffer.from(matches[0].bin).toString("utf8")), [
    { ...values[0], value: next },
    values[1]
  ])
  assert.equal(
    Buffer.from(resources.entries.find((item) => item.type === 10)!.bin).toString(),
    "unchanged-other-resource"
  )
  assert.equal(digest(original), originalHash)
  assert.throws(() => replaceIntegrityResource(original, "d".repeat(64), next))
  assert.throws(() => replaceIntegrityResource(executable(values, true), old, next))
  assert.throws(() => replaceIntegrityResource(executable([values[1]]), old, next))
  assert.throws(() => replaceIntegrityResource(Buffer.from("unknown PE"), old, next))
})

test("signed PE input is rejected by the unchanged mature parser default", () => {
  const old = "a".repeat(64),
    bytes = executable([{ file: "resources\\app.asar", alg: "SHA256", value: old }])
  const original = NtExecutable.from(bytes)
  const headers = Format.ImageNtHeaders.from(bytes, original.dosHeader.newHeaderAddress)
  headers.optionalHeaderDataDirectory.set(Format.ImageDirectoryEntry.Certificate, {
    virtualAddress: bytes.length,
    size: 8
  })
  assert.throws(() => replaceIntegrityResource(bytes, old, "b".repeat(64)), /signed executable/iu)
})

test("the optional controller accepts only exact generator receipt, source digest and original PE architecture", () => {
  const controller = (marker: string, is32bit = true): Buffer => {
    const exe = NtExecutable.createEmpty(is32bit, false),
      resources = NtExecutableResource.from(exe)
    resources.entries.push({
      type: 10,
      id: 1,
      lang: 1033,
      codepage: 1200,
      bin: resourceBin(marker, "utf16le")
    })
    resources.outputResource(exe)
    return Buffer.from(exe.generate())
  }
  const bytes = controller("MODS_PROCESS_STARTED_V1\n"),
    old = controller("old-controller")
  const pins = {
    executable: digest(bytes),
    source: "d".repeat(64),
    receipt: "e".repeat(64),
    generator: "f".repeat(64)
  }
  const receipt = { executable: pins.executable, source: pins.source }
  assert.doesNotThrow(() => assertGeneratedController(old, bytes, receipt, pins))
  assert.throws(() =>
    assertGeneratedController(old, bytes, { ...receipt, source: "a".repeat(64) }, pins)
  )
  assert.throws(() => assertGeneratedController(old, bytes, { ...receipt, extra: true }, pins))
  assert.throws(() =>
    assertGeneratedController(old, bytes, receipt, { ...pins, executable: "a".repeat(64) })
  )
  assert.throws(() => assertGeneratedController(controller("old", false), bytes, receipt, pins))
  const unknown = controller("unrecognized-protocol")
  assert.throws(() =>
    assertGeneratedController(
      old,
      unknown,
      { ...receipt, executable: digest(unknown) },
      { ...pins, executable: digest(unknown) }
    )
  )
})

for (const code of ["ENOSPC", "EIO"]) {
  test(`real output ${code} after the official header rejects before producer return without continuing new files`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-runtime-delta-fault-"))
    const base = join(root, "base.asar"),
      output = join(root, "failed.asar"),
      source = join(root, "main.js")
    const bytes = "x".repeat(512 * 1024)
    const baseStreams: asar.AsarStreamType[] = [
      {
        type: "file",
        path: main,
        unpacked: false,
        stat: { size: bytes.length, mode: 0o100644 },
        streamGenerator: () => Readable.from(Buffer.from(bytes))
      },
      {
        type: "file",
        path: "later/unpacked.bin",
        unpacked: true,
        stat: { size: 5, mode: 0o100644 },
        streamGenerator: () => Readable.from(Buffer.from("later"))
      }
    ]
    await finished(await asar.createPackageFromStreams(base, baseStreams))
    const baseHash = digest(await readFile(base))
    await writeFile(source, bytes)
    const outputs: string[] = []
    const outputStreams: WriteStream[] = []
    const fault = Object.assign(new Error(`actual output fault ${code}`), { code })
    const started = performance.now()
    let bodyAttempted = false
    let actualHeaderSeen = false
    let reentrant: Promise<{ error: unknown }> | undefined
    const builtinFactory = process.getBuiltinModule("node:fs")!.createWriteStream
    assert.notEqual(asarFs, process.getBuiltinModule("node:fs"))
    await assert.rejects(
      writeMainOnlyArchive(base, source, output, (stream) => {
        assert.equal(process.getBuiltinModule("node:fs")!.createWriteStream, builtinFactory)
        outputs.push(String(stream.path))
        outputStreams.push(stream)
        if (String(stream.path) !== output) return
        reentrant = writeMainOnlyArchive(base, source, join(root, "forbidden-reentry.asar")).then(
          () => ({ error: null }),
          (error) => ({ error })
        )
        const write = stream.write
        let writes = 0
        stream.write = function (this: typeof stream, ...args: unknown[]): boolean {
          if (++writes === 3) {
            bodyAttempted = true
            // The official header callback has completed before its body source
            // can call write. Fail the real output stream, never substitute a result.
            try {
              actualHeaderSeen = asar.getRawHeader(output).header.files.out !== undefined
            } catch {
              /* checked after bounded rejection */
            }
            stream.destroy(fault)
            return false
          }
          return Boolean(Reflect.apply(write, this, args))
        }
      }),
      (error) => error === fault
    )
    assert(bodyAttempted)
    assert(
      actualHeaderSeen,
      "The original archive header must actually be on disk before the injected fault"
    )
    assert.equal(process.getBuiltinModule("node:fs")!.createWriteStream, builtinFactory)
    assert(
      outputStreams.every((stream) => stream.destroyed && stream.closed),
      "Failed writers must actually close"
    )
    assert(reentrant)
    assert.match(String((await reentrant).error), /Only one exact runtime-delta archive writer/u)
    assert(
      performance.now() - started < 2000,
      "Output failure must not hang on the official source-end wait"
    )
    assert.deepEqual(outputs, [output], "Failure must stop the later unpacked output factory")
    assert.equal(digest(await readFile(base)), baseHash)
    // A subsequent distinct writer proves the previous adapter really drained
    // and restored its exact owner; the failed output remains for diagnostics.
    await writeMainOnlyArchive(base, source, join(root, "recovery.asar"))
    assert.equal(
      digest(asar.extractFile(join(root, "recovery.asar"), main.split("/").join(sep))),
      digest(bytes)
    )
    console.log(`Retained output-failure artifacts (no deletion): ${root}`)
  })
}
