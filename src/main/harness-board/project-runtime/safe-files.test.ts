import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  probeRuntimeScopedFile,
  readRuntimeScopedFile,
  runtimeDirectory,
  runtimeDirectoryIdentity
} from "./safe-files"

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>())
}))

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "scoped-canonical-")))
  roots.push(root)
  fs.mkdirSync(join(root, "inputs"))
  const file = join(root, "inputs/entry.txt")
  const bytes = Buffer.from("actual bound text".repeat(8192))
  fs.writeFileSync(file, bytes)
  return { root, file, bytes }
}
function changeDuringRead(change: () => void) {
  const read = fs.readSync
  let changed = false
  vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const value = Reflect.apply(read, fs, args)
    if (!changed) {
      changed = true
      change()
    }
    return value
  }) as typeof fs.readSync)
}

describe("canonical scoped file safety", () => {
  it("keeps exact observations and root identity for real Unicode and nested files", () => {
    const f = fixture()
    fs.mkdirSync(join(f.root, "资料"))
    fs.writeFileSync(join(f.root, "资料/文件.txt"), f.bytes)
    expect(runtimeDirectory(f.root)).toBe(f.root)
    expect(runtimeDirectoryIdentity(f.root)).toContain(f.root)
    expect(readRuntimeScopedFile(f.root, "资料/文件.txt").bytes).toEqual(f.bytes)
    expect(readRuntimeScopedFile(f.root, "inputs/entry.txt")).toEqual(
      readRuntimeScopedFile(f.root, "inputs/entry.txt")
    )
  })

  it("preserves missing files, bounded reads and invalid relative-path failures", () => {
    const f = fixture()
    expect(readRuntimeScopedFile(f.root, "missing.txt").present).toBe(false)
    expect(readRuntimeScopedFile(f.root, "missing/entry.txt").present).toBe(false)
    expect(() => readRuntimeScopedFile(f.root, "inputs/entry.txt", 16)).toThrow("FILE_LIMIT")
    expect(() => readRuntimeScopedFile(f.root, "../entry.txt")).toThrow("FILE_PATH_INVALID")
  })

  it("probes presence without reading or allocating resource content and preserves path checks", () => {
    const f = fixture()
    const read = vi.spyOn(fs, "readSync")
    const close = vi.spyOn(fs, "closeSync")
    const observed = probeRuntimeScopedFile(f.root, "inputs/entry.txt")
    expect(observed.present).toBe(true)
    expect(observed.bytes).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    expect(probeRuntimeScopedFile(f.root, "missing/entry.txt").present).toBe(false)
    expect(() => probeRuntimeScopedFile(f.root, "../entry.txt")).toThrow("FILE_PATH_INVALID")
  })

  it("refuses hard links and junction parents when probing resource presence", () => {
    const f = fixture()
    fs.linkSync(f.file, join(f.root, "hard.txt"))
    expect(() => probeRuntimeScopedFile(f.root, "inputs/entry.txt")).toThrow("FILE_UNSAFE")
    fs.unlinkSync(join(f.root, "hard.txt"))
    fs.symlinkSync(join(f.root, "inputs"), join(f.root, "alias"),
      process.platform === "win32" ? "junction" : "dir")
    expect(() => probeRuntimeScopedFile(f.root, "alias/entry.txt")).toThrow("FILE_SCOPE_CHANGED")
  })

  it("refuses file replacement during a metadata-only probe and closes its descriptor", () => {
    const f = fixture()
    const open = fs.openSync
    const close = vi.spyOn(fs, "closeSync")
    let changed = false
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (!changed && args[0] === f.file) {
        changed = true
        fs.renameSync(f.file, join(f.root, "original.txt"))
        fs.writeFileSync(f.file, f.bytes)
      }
      return Reflect.apply(open, fs, args)
    }) as typeof fs.openSync)
    expect(() => probeRuntimeScopedFile(f.root, "inputs/entry.txt")).toThrow("FILE_CHANGED")
    expect(close).toHaveBeenCalledOnce()
  })

  it("does not turn probe access errors into missing-file observations", () => {
    const f = fixture()
    vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw Object.assign(Error("access denied"), { code: "EACCES" })
    })
    expect(() => probeRuntimeScopedFile(f.root, "inputs/entry.txt")).toThrow("access denied")
  })

  it("binds a fresh root inode on every unwrapped read, even for same bytes at the same path", () => {
    const f = fixture()
    const first = readRuntimeScopedFile(f.root, "inputs/entry.txt")
    const retired = f.root + "-retired"
    fs.renameSync(f.root, retired)
    roots.push(retired)
    fs.mkdirSync(f.root)
    fs.mkdirSync(join(f.root, "inputs"))
    fs.writeFileSync(f.file, f.bytes)
    const second = readRuntimeScopedFile(f.root, "inputs/entry.txt")
    expect(second.bytes).toEqual(first.bytes)
    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  it("keeps the original repeated root checks for dynamically wrapped filesystem methods", () => {
    const f = fixture()
    const original = fs.lstatSync
    const observed = vi.spyOn(fs, "lstatSync").mockImplementation(original)
    expect(readRuntimeScopedFile(f.root, "inputs/entry.txt").bytes).toEqual(f.bytes)
    // Directory, identity directory, identity bigint, initial parent, final parent.
    expect(observed.mock.calls.filter(([path]) => path === f.root)).toHaveLength(5)
  })

  it("rejects an existing hard link and an actual junction parent", () => {
    const f = fixture()
    fs.linkSync(f.file, join(f.root, "hard.txt"))
    expect(() => readRuntimeScopedFile(f.root, "inputs/entry.txt")).toThrow("FILE_UNSAFE")
    fs.unlinkSync(join(f.root, "hard.txt"))
    const alias = join(f.root, "alias")
    fs.symlinkSync(join(f.root, "inputs"), alias, process.platform === "win32" ? "junction" : "dir")
    expect(() => runtimeDirectory(alias)).toThrow("DIRECTORY_INVALID")
    expect(() => readRuntimeScopedFile(f.root, "alias/entry.txt")).toThrow("FILE_SCOPE_CHANGED")
  })

  it.each([false, true])(
    "rejects named-file replacement during reading (same bytes: %s)",
    (same) => {
      const f = fixture()
      const before = fs.statSync(f.file)
      const close = vi.spyOn(fs, "closeSync")
      changeDuringRead(() => {
        fs.renameSync(f.file, join(f.root, "original.txt"))
        fs.writeFileSync(f.file, same ? f.bytes : Buffer.alloc(f.bytes.length, 120))
        fs.utimesSync(f.file, before.atime, before.mtime)
      })
      expect(() => readRuntimeScopedFile(f.root, "inputs/entry.txt")).toThrow("FILE_CHANGED")
      expect(close).toHaveBeenCalledOnce()
    }
  )

  it("rejects in-place equal-size content changes even after restoring the original mtime", () => {
    const f = fixture()
    const before = fs.statSync(f.file)
    changeDuringRead(() => {
      fs.writeFileSync(f.file, Buffer.alloc(f.bytes.length, 121))
      fs.utimesSync(f.file, before.atime, before.mtime)
    })
    expect(() => readRuntimeScopedFile(f.root, "inputs/entry.txt")).toThrow("FILE_CHANGED")
  })

  it("rejects parent retarget to the same retained file and does not reuse prior observations", () => {
    const f = fixture()
    expect(readRuntimeScopedFile(f.root, "inputs/entry.txt").bytes).toEqual(f.bytes)
    const original = join(f.root, "original-inputs")
    // Windows prevents directory rename while a contained fd is open. Retarget after the
    // original named-file/parent observations but immediately before the physical open.
    const open = fs.openSync
    let changed = false
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (!changed && args[0] === f.file) {
        changed = true
        fs.renameSync(join(f.root, "inputs"), original)
        fs.symlinkSync(
          original,
          join(f.root, "inputs"),
          process.platform === "win32" ? "junction" : "dir"
        )
      }
      return Reflect.apply(open, fs, args)
    }) as typeof fs.openSync)
    expect(() => readRuntimeScopedFile(f.root, "inputs/entry.txt")).toThrow(
      /FILE_CHANGED|FILE_SCOPE_CHANGED/
    )
    vi.restoreAllMocks()
    expect(() => readRuntimeScopedFile(f.root, "inputs/entry.txt")).toThrow("FILE_SCOPE_CHANGED")
  })

  it("rejects hard-link insertion while reading and still closes the physical descriptor", () => {
    const f = fixture()
    const close = vi.spyOn(fs, "closeSync")
    changeDuringRead(() => fs.linkSync(f.file, join(f.root, "second-name.txt")))
    expect(() => readRuntimeScopedFile(f.root, "inputs/entry.txt")).toThrow("FILE_CHANGED")
    expect(close).toHaveBeenCalledOnce()
  })
})
