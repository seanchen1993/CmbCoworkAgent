import { afterEach, expect, it, vi } from "vitest"
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  promises as realFs
} from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRuntimeScopedFile, runtimeDirectory } from "./safe-files"
import { readRuntimeScopedFileAsync, runtimeDirectoryAsync } from "./safe-files-async"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open) }
})

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "async-scoped-file-"))
  roots.push(root)
  writeFileSync(join(root, "entry.txt"), "x".repeat(1024 * 1024))
  return root
}

it("retains the synchronous commit reader's exact observations for present and absent files", async () => {
  const root = fixture()
  for (const path of ["entry.txt", "missing.txt", "absent/entry.txt"])
    expect(await readRuntimeScopedFileAsync(root, path)).toEqual(readRuntimeScopedFile(root, path))
})

it.runIf(process.platform === "win32")(
  "uses the callback realpath semantics of the commit reader when native Windows spelling differs",
  async () => {
    const root = fixture()
    const actual = join(root, "MiXeD")
    mkdirSync(actual)
    writeFileSync(join(actual, "entry.txt"), "actual Windows identity")
    const alias = join(root, "MIXED")
    // A real directory, not a mocked return value: native realpath restores its
    // physical spelling while the established JS reader preserves the input.
    expect(await realFs.realpath(alias)).not.toBe(alias)
    expect(realpathSync(alias)).toBe(alias)
    expect(runtimeDirectory(alias)).toBe(alias)
    expect(await runtimeDirectoryAsync(alias)).toBe(alias)
    expect(await readRuntimeScopedFileAsync(alias, "entry.txt")).toEqual(
      readRuntimeScopedFile(alias, "entry.txt")
    )
  }
)

it("still rejects real hard links and directory junctions at both root and parent boundaries", async () => {
  const root = fixture()
  const hard = join(root, "hard.txt")
  linkSync(join(root, "entry.txt"), hard)
  await expect(readRuntimeScopedFileAsync(root, "entry.txt")).rejects.toThrow("FILE_UNSAFE")
  unlinkSync(hard)
  const directory = join(root, "inputs")
  mkdirSync(directory)
  writeFileSync(join(directory, "entry.txt"), "retained bytes")
  const junction = join(root, "alias")
  symlinkSync(directory, junction, process.platform === "win32" ? "junction" : "dir")
  await expect(runtimeDirectoryAsync(junction)).rejects.toThrow("DIRECTORY_INVALID")
  await expect(readRuntimeScopedFileAsync(root, "alias/entry.txt")).rejects.toThrow(
    "FILE_SCOPE_CHANGED"
  )
})

it("rejects a named-file replacement during async reads and closes the retained descriptor", async () => {
  const root = fixture()
  const originalOpen = realFs.open.bind(realFs)
  let close: ReturnType<typeof vi.spyOn> | undefined
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    close = vi.spyOn(handle, "close")
    const originalRead = handle.read.bind(handle)
    let changed = false
    vi.spyOn(handle, "read").mockImplementation((async (...readArgs: unknown[]) => {
      const value = await Reflect.apply(originalRead, handle, readArgs)
      if (!changed) {
        changed = true
        renameSync(join(root, "entry.txt"), join(root, "original.txt"))
        writeFileSync(join(root, "entry.txt"), "replacement")
      }
      return value
    }) as typeof handle.read)
    return handle
  })
  await expect(
    readRuntimeScopedFileAsync(root, "entry.txt").then(() => "unexpected success")
  ).rejects.toThrow("FILE_CHANGED")
  expect(close).toHaveBeenCalledOnce()
})

it("observes cancellation between chunks and always closes the descriptor", async () => {
  const root = fixture()
  const controller = new AbortController()
  const originalOpen = realFs.open.bind(realFs)
  let close: ReturnType<typeof vi.spyOn> | undefined
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    close = vi.spyOn(handle, "close")
    const originalRead = handle.read.bind(handle)
    vi.spyOn(handle, "read").mockImplementation((async (...readArgs: unknown[]) => {
      const value = await Reflect.apply(originalRead, handle, readArgs)
      controller.abort()
      return value
    }) as typeof handle.read)
    return handle
  })
  await expect(
    readRuntimeScopedFileAsync(root, "entry.txt", undefined, controller.signal).then(
      () => "unexpected success"
    )
  ).rejects.toMatchObject({ name: "AbortError" })
  expect(close).toHaveBeenCalledOnce()
})
