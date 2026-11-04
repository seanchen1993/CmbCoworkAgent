import * as fs from "fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { CurrentUtf8File } from "./current-utf8-file"

vi.mock("fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs")>()) }))
const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "current-utf8-"))
  roots.push(root)
  const path = join(root, "registry.json")
  fs.writeFileSync(path, "first")
  return { root, path, reader: new CurrentUtf8File(path) }
}
afterEach(async () => {
  await Promise.resolve()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("current-utf8-"))
      throw Error("Unsafe cleanup")
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it("reuses a descriptor only inside a synchronous burst and reads new bytes every time", async () => {
  const f = fixture()
  const open = vi.spyOn(fs, "openSync"),
    close = vi.spyOn(fs, "closeSync")
  expect(f.reader.read()).toBe("first")
  expect(f.reader.read()).toBe("first")
  expect(open).toHaveBeenCalledTimes(1)
  expect(close).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(close).toHaveBeenCalledTimes(1)
  expect(f.reader.read()).toBe("first")
  expect(open).toHaveBeenCalledTimes(2)
})

it("observes same-length edits, shrink and growth without waiting for a tick", () => {
  const f = fixture()
  expect(f.reader.read()).toBe("first")
  for (const text of ["other", "x", "longer text", "", "中文😀"]) {
    fs.writeFileSync(f.path, text)
    expect(f.reader.read()).toBe(text)
  }
})

it("reopens atomic replacements and never returns a deleted registry from its old descriptor", () => {
  const f = fixture()
  expect(f.reader.read()).toBe("first")
  fs.renameSync(f.path, join(f.root, "previous"))
  fs.writeFileSync(f.path, "other")
  expect(f.reader.read()).toBe("other")
  fs.unlinkSync(f.path)
  expect(() => f.reader.read()).toThrow()
  fs.writeFileSync(f.path, "new")
  expect(f.reader.read()).toBe("new")
})

it("rejects pathname replacement during reading and recovers on the next fresh read", () => {
  const f = fixture()
  const actual = fs.readSync
  const read = vi.spyOn(fs, "readSync").mockImplementationOnce((...args) => {
    const result = Reflect.apply(actual, fs, args)
    fs.renameSync(f.path, join(f.root, "previous"))
    fs.writeFileSync(f.path, "other")
    return result
  })
  expect(() => f.reader.read()).toThrow("CURRENT_FILE_CHANGED")
  read.mockRestore()
  expect(f.reader.read()).toBe("other")
})

it("propagates read failures, closes the descriptor and never substitutes retained bytes", () => {
  const f = fixture()
  expect(f.reader.read()).toBe("first")
  const close = vi.spyOn(fs, "closeSync")
  const read = vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
    throw Error("EACCES")
  })
  expect(() => f.reader.read()).toThrow("EACCES")
  expect(close).toHaveBeenCalledTimes(1)
  read.mockRestore()
  expect(f.reader.read()).toBe("first")
})
