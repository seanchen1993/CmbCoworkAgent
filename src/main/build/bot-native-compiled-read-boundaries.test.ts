import { afterEach, beforeEach, expect, test, vi } from "vitest"
import io, { type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { syncBuiltinESMExports } from "node:module"
import { finished } from "node:stream/promises"
import { createPackageWithOptions } from "@electron/asar"
import { BOT_NATIVE_COMPILED_SEAL, verifyPackagedBotNativeCompiled } from "./bot-native-compiled"
import { compileMainHostFixture } from "./native-distribution-fixture"

let root: string
const liveHandles = new Set<FileHandle>()
beforeEach(async () => {
  root = await io.realpath(await io.mkdtemp(join(tmpdir(), "cmb-compiled-read-boundary-")))
})
afterEach(async () => {
  // A failed assertion must not leave a real temporary file handle behind.
  for (const handle of liveHandles) await handle.close().catch(() => undefined)
  liveHandles.clear()
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await io.rm(root, { recursive: true, force: true })
})

type ReadBoundary = { path: string; position: number; bytesRead: number }
function observeReads(afterRead?: (boundary: ReadBoundary) => Promise<void>) {
  const open = io.open.bind(io)
  const closedPaths = new Set<string>()
  vi.spyOn(io, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode)
    const filename = String(path)
    liveHandles.add(handle)
    const close = handle.close.bind(handle)
    handle.close = async () => {
      await close()
      liveHandles.delete(handle)
      closedPaths.add(filename)
    }
    // The production verifier uses the explicit Buffer/offset/length/position
    // overload. Observe completed real reads; do not supply fixture bytes.
    const read = handle.read.bind(handle) as (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) => Promise<{ bytesRead: number; buffer: Buffer }>
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const part = await read(buffer, offset, length, position)
      await afterRead?.({
        path: filename,
        position,
        bytesRead: part.bytesRead
      })
      return part
    }) as typeof handle.read
    return handle
  })
  syncBuiltinESMExports()
  return { closedPaths }
}

type Layout = "app" | "asar" | "unpacked-host"
async function fixture(layout: Layout) {
  const main = await compileMainHostFixture(root, null)
  const archive = join(root, "resources/app.asar")
  if (layout !== "app") {
    const stream = await createPackageWithOptions(
      join(root, "resources/app"),
      archive,
      layout === "unpacked-host" ? { unpack: "**/bot-host.js" } : {}
    )
    await finished(stream)
    await io.rm(join(root, "resources/app"), { recursive: true, force: true })
  }
  return { main, archive, resources: join(root, "resources") }
}

test.each(["app", "asar", "unpacked-host"] as const)(
  "unchanged %s inventory verifies and releases all opened handles",
  async (layout) => {
    const { resources } = await fixture(layout)
    const { closedPaths } = observeReads()
    await verifyPackagedBotNativeCompiled(resources, null)
    expect(closedPaths.size).toBeGreaterThan(0)
    expect(liveHandles.size).toBe(0)
  }
)

test("a header update after the prefix read cannot allocate beyond the original 16MiB bound", async () => {
  const { archive, resources } = await fixture("asar")
  let changed = false
  observeReads(async ({ path, position, bytesRead }) => {
    if (path !== archive || position !== 0 || bytesRead !== 8 || changed) return
    changed = true
    const replacement = Buffer.alloc(8)
    replacement.writeUInt32LE(4, 0)
    replacement.writeUInt32LE(32 * 1024 * 1024, 4)
    await io.writeFile(archive, replacement)
  })
  const allocate = Buffer.alloc.bind(Buffer)
  const allocateUnsafe = Buffer.allocUnsafe.bind(Buffer)
  let largestAllocation = 0
  vi.spyOn(Buffer, "alloc").mockImplementation((size, fill, encoding) => {
    largestAllocation = Math.max(largestAllocation, size)
    return allocate(size, fill, encoding)
  })
  vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size) => {
    largestAllocation = Math.max(largestAllocation, size)
    return allocateUnsafe(size)
  })
  await expect(verifyPackagedBotNativeCompiled(resources, null)).rejects.toThrow(/header/)
  expect(changed).toBe(true)
  expect(largestAllocation).toBeGreaterThan(8)
  expect(largestAllocation).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(liveHandles.size).toBe(0)
})

test("rejects an already-read unpacked Host update during a later packed member read", async () => {
  const { archive, resources } = await fixture("unpacked-host")
  const host = join(archive + ".unpacked", "out/main/bot-host.js")
  const originalArchive = await io.readFile(archive)
  let changed = false
  const { closedPaths } = observeReads(async ({ path, bytesRead }) => {
    if (path !== archive || bytesRead === 0 || !closedPaths.has(host) || changed) return
    changed = true
    const bytes = await io.readFile(host)
    bytes[0] ^= 1
    await io.writeFile(host, bytes)
  })
  await expect(verifyPackagedBotNativeCompiled(resources, null)).rejects.toThrow(
    "Compiled physical members changed"
  )
  expect(changed).toBe(true)
  expect(await io.readFile(archive)).toEqual(originalArchive)
  expect(liveHandles.size).toBe(0)
})

test("rejects an already-read physical Host update during a later Main member read", async () => {
  const { main, resources } = await fixture("app")
  const host = join(main, "bot-host.js")
  let changed = false
  const { closedPaths } = observeReads(async ({ path, bytesRead }) => {
    if (path !== join(main, "index.js") || bytesRead === 0 || !closedPaths.has(host) || changed)
      return
    changed = true
    const bytes = await io.readFile(host)
    bytes[0] ^= 1
    await io.writeFile(host, bytes)
  })
  await expect(verifyPackagedBotNativeCompiled(resources, null)).rejects.toThrow(
    "Compiled physical members changed"
  )
  expect(changed).toBe(true)
  expect(liveHandles.size).toBe(0)
})

test("a same-content seal replacement cannot overwrite the first observed identity", async () => {
  const { main, resources } = await fixture("app")
  const seal = join(main, BOT_NATIVE_COMPILED_SEAL)
  const original = await io.readFile(seal)
  const firstIdentity = await io.lstat(seal, { bigint: true })
  let changed = false
  const { closedPaths } = observeReads(async ({ path, bytesRead }) => {
    if (path !== join(main, "index.js") || bytesRead === 0 || !closedPaths.has(seal) || changed)
      return
    changed = true
    await io.rename(seal, join(root, "previous-seal.json"))
    await io.writeFile(seal, original)
  })
  await expect(verifyPackagedBotNativeCompiled(resources, null)).rejects.toThrow(
    "Compiled physical members changed"
  )
  expect(changed).toBe(true)
  expect(await io.readFile(seal)).toEqual(original)
  expect((await io.lstat(seal, { bigint: true })).ino).not.toBe(firstIdentity.ino)
  expect(liveHandles.size).toBe(0)
})
