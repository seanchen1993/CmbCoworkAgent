import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ProjectFunctionFiles } from "./file-access"
import { basicSdkInput, validateBasicInput, validateBasicResult } from "./basic-sdk"
import type { ModJson } from "../../../shared/mods/types"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      dirname(root) !== (await realpath(tmpdir())) ||
      !basename(root).startsWith("mods-fs-metadata-")
    )
      throw Error("Unexpected metadata cleanup path")
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mods-fs-metadata-")))
  roots.push(root)
  const project = join(root, "project")
  await mkdir(project)
  await mkdir(join(project, "target"))
  await writeFile(join(project, "target", "note.txt"), "hello")
  await symlink(
    join(project, "target"),
    join(project, "alias"),
    process.platform === "win32" ? "junction" : "dir"
  )
  return {
    root,
    project,
    signal: new AbortController().signal,
    files: new ProjectFunctionFiles(
      project,
      () => {},
      async (value) => value
    )
  }
}

it("preserves stat resolution options and rejects invalid options instead of silently dropping them", () => {
  expect(basicSdkInput("fs.stat", ["note.txt"])).toEqual({ path: "note.txt", resolve: false })
  expect(basicSdkInput("fs.stat", ["note.txt", { resolve: true }])).toEqual({
    path: "note.txt",
    resolve: true
  })
  const invalidOptions: ModJson[] = [
    null,
    [],
    true,
    { resolve: "yes" },
    { resolve: true, unknown: true }
  ]
  for (const options of invalidOptions)
    expect(() => basicSdkInput("fs.stat", ["note.txt", options])).toThrow("MODS_FS_OPTIONS")
  expect(() => validateBasicInput("fs.stat", { path: "note.txt", resolve: "yes" })).toThrow(
    "MODS_FS_OPTIONS"
  )
})

it("reports the real input link and canonical target without changing default metadata", async () => {
  const f = await fixture()
  expect(await f.files.run("fs.stat", "alias", f.signal, { resolve: true })).toMatchObject({
    kind: "dir",
    isLink: true,
    realPath: join(f.project, "target")
  })
  expect(await f.files.run("fs.stat", "alias/note.txt", f.signal, { resolve: true })).toMatchObject(
    {
      kind: "file",
      size: 5,
      isLink: false,
      realPath: join(f.project, "target", "note.txt")
    }
  )
  expect(await f.files.run("fs.stat", "alias", f.signal)).not.toHaveProperty("realPath")
  expect(await f.files.run("fs.list", ".", f.signal)).toEqual([
    { name: "alias", kind: "other", size: 0, mtimeMs: 0, isLink: true },
    { name: "target", kind: "dir", size: 0, mtimeMs: 0, isLink: false }
  ])
})

it("keeps canonical resolution inside the project and does not follow listed outside links", async () => {
  const f = await fixture()
  const outside = join(f.root, "outside")
  await mkdir(outside)
  await symlink(
    outside,
    join(f.project, "outside"),
    process.platform === "win32" ? "junction" : "dir"
  )
  await expect(f.files.run("fs.stat", "outside", f.signal, { resolve: true })).rejects.toThrow(
    "MODS_FS_OUTSIDE_PROJECT"
  )
  expect(await f.files.run("fs.list", ".", f.signal)).toContainEqual({
    name: "outside",
    kind: "other",
    size: 0,
    mtimeMs: 0,
    isLink: true
  })
})

it("rejects a target replacement during mandatory metadata publication", async () => {
  const f = await fixture()
  const files = new ProjectFunctionFiles(
    f.project,
    () => {},
    async (value) => {
      await rename(join(f.project, "target"), join(f.project, "old-target"))
      await mkdir(join(f.project, "target"))
      return value
    }
  )
  await expect(files.run("fs.stat", "alias", f.signal, { resolve: true })).rejects.toThrow(
    "MODS_FS_CHANGED"
  )
})

it("validates added metadata fields while retaining legacy hook result shapes", () => {
  const legacy = { kind: "file", size: 1, mtimeMs: 1 }
  expect(() => validateBasicResult("fs.stat", legacy)).not.toThrow()
  expect(() => validateBasicResult("fs.stat", { ...legacy, isLink: "false" })).toThrow(
    "MODS_SDK_RESULT"
  )
  expect(() => validateBasicResult("fs.stat", { ...legacy, realPath: false })).toThrow(
    "MODS_SDK_RESULT"
  )
  expect(() =>
    validateBasicResult("fs.list", [{ name: "x", kind: "file", size: 1, isLink: 0 }])
  ).toThrow("MODS_SDK_RESULT")
})

it("lists each file's own timestamp at the same precision as stat without following links", async () => {
  const f = await fixture()
  const file = join(f.project, "target", "note.txt")
  // Sub-millisecond precision must not accidentally use Stats while stat uses BigIntStats.
  await utimes(file, 1_700_000_000.123456, 1_700_000_000.123456)
  const own = await lstat(file, { bigint: true })
  const entries = await f.files.run("fs.list", "target", f.signal)
  expect(entries).toEqual([
    { name: "note.txt", kind: "file", size: 5, mtimeMs: Number(own.mtimeMs), isLink: false }
  ])
  expect(await f.files.run("fs.stat", "target/note.txt", f.signal)).toMatchObject({
    mtimeMs: Number(own.mtimeMs)
  })
})

it("accepts legacy listings and finite historical timestamps but rejects invalid timestamps", () => {
  const entry = { name: "x", kind: "file", size: 1, isLink: false }
  expect(() => validateBasicResult("fs.list", [entry])).not.toThrow()
  for (const mtimeMs of [-1, -0.5, 0, 123.456])
    expect(() => validateBasicResult("fs.list", [{ ...entry, mtimeMs }])).not.toThrow()
  for (const mtimeMs of [NaN, Infinity, -Infinity, "123", null])
    expect(() => validateBasicResult("fs.list", [{ ...entry, mtimeMs }])).toThrow("MODS_SDK_RESULT")
})

it.each(["cancel", "revoke"])(
  "drops metadata when %s occurs during publication",
  async (action) => {
    const f = await fixture()
    const controller = new AbortController()
    let live = true
    const files = new ProjectFunctionFiles(
      f.project,
      () => {
        if (!live) throw Error("revoked")
      },
      async (value) => {
        if (action === "cancel") controller.abort(Error("cancelled"))
        else live = false
        return value
      }
    )
    await expect(
      files.run("fs.stat", "alias", controller.signal, { resolve: true })
    ).rejects.toThrow(action === "cancel" ? "cancelled" : "revoked")
  }
)
