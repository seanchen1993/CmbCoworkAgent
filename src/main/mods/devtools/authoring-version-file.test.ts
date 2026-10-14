import fs from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { readBoundedAuthoringVersionFile } from "./authoring-version-file"

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "cmb-bounded-version-"))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

it("bounds bytes read when the opened file grows after fstat", () => {
  const file = join(directory, "source.ts")
  fs.writeFileSync(file, "small")
  const original = fs.readSync
  let requested = 0
  vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof original>) => {
    fs.writeFileSync(file, "x".repeat(8 * 1024 * 1024))
    requested += Number((args as unknown[])[3])
    return Reflect.apply(original, fs, args)
  })
  expect(() => readBoundedAuthoringVersionFile(file, 64 * 1024)).toThrow("CHANGED")
  expect(requested).toBe(6)
})

it("rejects a different pathname identity while keeping the original open descriptor bounded", () => {
  const file = join(directory, "record.json")
  fs.writeFileSync(file, "small")
  const original = fs.readSync
  let changed = false
  vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof original>) => {
    if (!changed) {
      changed = true
      fs.renameSync(file, join(directory, "old.json"))
      fs.writeFileSync(file, "large".repeat(1024 * 1024))
    }
    return Reflect.apply(original, fs, args)
  })
  expect(() => readBoundedAuthoringVersionFile(file, 1024 * 1024)).toThrow("CHANGED")
})

it("rejects oversized and malformed UTF-8 content", () => {
  const file = join(directory, "source.ts")
  fs.writeFileSync(file, "long")
  expect(() => readBoundedAuthoringVersionFile(file, 3)).toThrow("CHANGED")
  fs.writeFileSync(file, Buffer.from([0xff]))
  expect(() => readBoundedAuthoringVersionFile(file, 3)).toThrow("CHANGED")
})
