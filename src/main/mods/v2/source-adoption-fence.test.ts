import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { assertFunctionSourcesCurrent } from "./source-adoption-fence"

// Controlled OS races use the real functions through configurable Vitest exports.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>())
}))

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-source-fence-")
    )
      throw Error("Unexpected cleanup target")
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(imported = false) {
  const root = await mkdtemp(join(tmpdir(), "mods-source-fence-"))
  roots.push(root)
  await mkdir(join(root, "hooks"))
  await writeFile(join(root, "plugin.json"), '{"name":"source-fence"}')
  await writeFile(join(root, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(
    join(root, "hooks/register.ts"),
    imported
      ? 'import {value} from "./value";export function register(){if(value) return}'
      : "export function register(){}"
  )
  if (imported) await writeFile(join(root, "hooks/value.js"), "export const value = 1")
  return { root, compiled: await compileFunctionPlugin(root) }
}

it("checks the original bytes even when a later file has the same length", async () => {
  const f = await fixture()
  expect(() => assertFunctionSourcesCurrent(f.compiled)).not.toThrow()
  await writeFile(join(f.root, "hooks/register.ts"), "export function register()[]")
  expect(() => assertFunctionSourcesCurrent(f.compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
})

it("rejects a newly installed higher priority manifest or native declaration", async () => {
  for (const file of [".claude-plugin/plugin.json", "mods/manifest.json"]) {
    const f = await fixture()
    await mkdir(dirname(join(f.root, file)), { recursive: true })
    await writeFile(join(f.root, file), '{"name":"changed"}')
    expect(() => assertFunctionSourcesCurrent(f.compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
  }
})

it("rejects a newly added higher priority import alternative and an edited transitive source", async () => {
  const first = await fixture(true)
  await writeFile(join(first.root, "hooks/value.ts"), "export const value = 2")
  expect(() => assertFunctionSourcesCurrent(first.compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
  const second = await fixture(true)
  await writeFile(join(second.root, "hooks/value.js"), "export const value = 2")
  expect(() => assertFunctionSourcesCurrent(second.compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
})

it("preserves cold loading when an ignored priority manifest cannot be bounded for adoption", async () => {
  for (const directory of [false, true]) {
    const f = await fixture()
    await mkdir(join(f.root, ".codex-plugin"))
    const file = join(f.root, ".codex-plugin/plugin.json")
    if (directory) await mkdir(file)
    else await writeFile(file, JSON.stringify({ ignored: "x".repeat(33000) }))
    const compiled = await compileFunctionPlugin(f.root)
    expect(compiled.name).toBe("source-fence")
    expect(() => assertFunctionSourcesCurrent(compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
  }
})

it("keeps the existing 256KiB declaration limit while proving the same author source", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "plugin.json"), '{"name":"source-fence","types":"author.d.ts"}')
  for (const size of [65537, 262144]) {
    await writeFile(join(f.root, "author.d.ts"), "/*" + "x".repeat(size - 4) + "*/")
    const compiled = await compileFunctionPlugin(f.root)
    expect(compiled.authorTypes?.entry).toBe("author.d.ts")
    expect(() => assertFunctionSourcesCurrent(compiled)).not.toThrow()
  }
  await writeFile(join(f.root, "author.d.ts"), "/*" + "x".repeat(262141) + "*/")
  await expect(compileFunctionPlugin(f.root)).rejects.toThrow()
})

it("rejects a same-content replacement inode before reading any of its bytes", async () => {
  const f = await fixture()
  const file = join(f.root, "plugin.json")
  const bytes = fs.readFileSync(file)
  fs.renameSync(file, file + ".previous")
  fs.writeFileSync(file, bytes)
  const read = vi.spyOn(fs, "readSync")
  try {
    expect(() => assertFunctionSourcesCurrent(f.compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
    expect(read).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
  }
})

it("checks the opened inode before reading when a leaf swaps after its name check", async () => {
  const f = await fixture()
  const file = join(f.root, "plugin.json"),
    bytes = fs.readFileSync(file)
  const actualOpen = fs.openSync
  let swapped = false
  const open = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    if (String(args[0]) === file && !swapped) {
      fs.renameSync(file, file + ".previous")
      fs.writeFileSync(file, bytes)
      swapped = true
    }
    return Reflect.apply(actualOpen, fs, args)
  })
  const read = vi.spyOn(fs, "readSync")
  try {
    expect(() => assertFunctionSourcesCurrent(f.compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
    expect(swapped).toBe(true)
    expect(read).not.toHaveBeenCalled()
  } finally {
    open.mockRestore()
    read.mockRestore()
  }
})

it("a cached parent replaced with another directory or junction cannot read the new file", async () => {
  for (const link of [false, true]) {
    const f = await fixture(true)
    const outside = await mkdtemp(join(tmpdir(), "mods-source-fence-"))
    roots.push(outside)
    await writeFile(join(outside, "register.ts"), "secret outside source")
    const actual = fs.lstatSync
    const read = vi.spyOn(fs, "readSync")
    let readsBeforeSwap = -1
    const stat = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) === join(f.root, "hooks/register.ts") && readsBeforeSwap < 0) {
        readsBeforeSwap = read.mock.calls.length
        fs.renameSync(join(f.root, "hooks"), join(f.root, "previous-hooks"))
        if (link)
          fs.symlinkSync(
            outside,
            join(f.root, "hooks"),
            process.platform === "win32" ? "junction" : "dir"
          )
        else {
          fs.mkdirSync(join(f.root, "hooks"))
          fs.writeFileSync(join(f.root, "hooks/register.ts"), "secret replacement source")
        }
      }
      return Reflect.apply(actual, fs, args)
    })
    try {
      expect(() => assertFunctionSourcesCurrent(f.compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
      expect(readsBeforeSwap).toBeGreaterThan(0)
      expect(read.mock.calls.length).toBe(readsBeforeSwap)
    } finally {
      stat.mockRestore()
      read.mockRestore()
    }
  }
})

it("rechecks a cached parent replaced after the last file was verified", async () => {
  const f = await fixture(true)
  const actualOpen = fs.openSync,
    actualClose = fs.closeSync
  let lastFd = -1,
    swapped = false
  const open = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    const fd = Reflect.apply(actualOpen, fs, args)
    if (String(args[0]) === join(f.root, "hooks/value.js")) lastFd = fd
    return fd
  })
  const close = vi.spyOn(fs, "closeSync").mockImplementation((...args) => {
    Reflect.apply(actualClose, fs, args)
    if (args[0] === lastFd) {
      fs.renameSync(join(f.root, "hooks"), join(f.root, "previous-hooks"))
      fs.mkdirSync(join(f.root, "hooks"))
      swapped = true
    }
  })
  try {
    expect(() => assertFunctionSourcesCurrent(f.compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
    expect(swapped).toBe(true)
  } finally {
    open.mockRestore()
    close.mockRestore()
  }
})

it.skipIf(process.platform !== "win32")(
  "accepts a real Windows case alias without losing the negative import proof",
  async () => {
    const f = await fixture(true)
    await writeFile(
      join(f.root, "hooks/register.ts"),
      'import {value} from "./VALUE";export function register(){if(value) return}'
    )
    const compiled = await compileFunctionPlugin(f.root)
    expect(() => assertFunctionSourcesCurrent(compiled)).not.toThrow()
    await writeFile(join(f.root, "hooks/value.ts"), "export const value = 2")
    expect(() => assertFunctionSourcesCurrent(compiled)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
  }
)
