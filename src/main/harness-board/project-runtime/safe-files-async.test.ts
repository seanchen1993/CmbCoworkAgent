import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, renameSync, rmSync, writeFileSync, promises as realFs } from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRuntimeScopedFile } from "./safe-files"
import { readRuntimeScopedFileAsync } from "./safe-files-async"

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
