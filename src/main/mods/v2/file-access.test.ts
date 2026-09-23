import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { FUNCTION_READ_LIMIT, ProjectFunctionFiles } from "./file-access"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "function-fs-")))
  roots.push(root)
  const project = join(root, "project")
  await mkdir(project)
  let live = true
  const files = new ProjectFunctionFiles(
    project,
    () => {
      if (!live) throw Error("revoked")
    },
    async (value) => value
  )
  const signal = new AbortController().signal
  return {
    root,
    project,
    files,
    signal,
    revoke: () => {
      live = false
    }
  }
}

it("reads UTF-8 files, sorts directory entries and returns real metadata", async () => {
  const f = await fixture()
  await writeFile(join(f.project, "b.txt"), "你好")
  await mkdir(join(f.project, "a"))
  expect(await f.files.run("fs.read", "b.txt", f.signal)).toBe("你好")
  expect(await f.files.run("fs.list", ".", f.signal)).toEqual([
    { name: "a", kind: "dir", size: 0 },
    { name: "b.txt", kind: "file", size: 6 }
  ])
  expect(await f.files.run("fs.stat", join(f.project, "b.txt"), f.signal)).toMatchObject({
    kind: "file",
    size: 6,
    mtimeMs: expect.any(Number)
  })
  expect(await f.files.run("fs.exists", "absent", f.signal)).toBe(false)
  await expect(f.files.run("fs.read", "absent", f.signal)).rejects.toMatchObject({
    code: "MODS_FS_NOT_FOUND"
  })
})

it("refuses traversal, outside junctions, ADS and device paths", async () => {
  const f = await fixture()
  const outside = join(f.root, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "private.txt"), "private")
  await symlink(outside, join(f.project, "link"), process.platform === "win32" ? "junction" : "dir")
  for (const path of ["../outside/private.txt", "link/private.txt", join(outside, "private.txt")]) {
    await expect(f.files.run("fs.read", path, f.signal)).rejects.toThrow("MODS_FS_OUTSIDE_PROJECT")
    expect(await f.files.run("fs.exists", path, f.signal)).toBe(false)
  }
  for (const path of ["file:secret", "NUL", "aux.txt", "name. ", "\\\\?\\C:\\private.txt"])
    await expect(f.files.run("fs.read", path, f.signal)).rejects.toThrow("MODS_FS_PATH")
  expect(await f.files.run("fs.list", ".", f.signal)).toEqual([
    { name: "link", kind: "other", size: 0 }
  ])
})

it("bounds content and refuses cancellation or revocation even for exists", async () => {
  const f = await fixture()
  await writeFile(join(f.project, "large"), Buffer.alloc(FUNCTION_READ_LIMIT + 1))
  await expect(f.files.run("fs.read", "large", f.signal)).rejects.toThrow("MODS_FS_READ_LIMIT")
  const controller = new AbortController()
  controller.abort(Error("stopped"))
  await expect(f.files.run("fs.exists", ".", controller.signal)).rejects.toThrow("stopped")
  f.revoke()
  await expect(f.files.run("fs.exists", ".", f.signal)).rejects.toThrow("revoked")
})

it("protects content before returning and drops publication after a revoked grant", async () => {
  const f = await fixture()
  await writeFile(join(f.project, "secret.txt"), "SECRET")
  const files = new ProjectFunctionFiles(
    f.project,
    () => undefined,
    async (value) => (typeof value === "string" ? value.replaceAll("SECRET", "HIDDEN") : value)
  )
  expect(await files.run("fs.read", "secret.txt", f.signal)).toBe("HIDDEN")
  const controller = new AbortController()
  const revoked = new ProjectFunctionFiles(
    f.project,
    () => undefined,
    async (value) => {
      controller.abort(Error("revoked during publication"))
      return value
    }
  )
  await expect(revoked.run("fs.read", "secret.txt", controller.signal)).rejects.toThrow(
    "revoked during publication"
  )
})

it("refuses a canonical project root replaced with an outside junction", async () => {
  const f = await fixture()
  const outside = join(f.root, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "private.txt"), "private")
  await rename(f.project, join(f.root, "original-project"))
  await symlink(outside, f.project, process.platform === "win32" ? "junction" : "dir")
  await expect(f.files.run("fs.read", "private.txt", f.signal)).rejects.toThrow(
    "MODS_FS_ROOT_CHANGED"
  )
})

it("bounds directory iteration instead of accumulating an unbounded host result", async () => {
  const f = await fixture()
  // Real directory entries remain essential here; bound setup concurrency so the
  // full Windows suite does not spend its entire deadline on sequential creates.
  for (let start = 0; start < 1025; start += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, 1025 - start) }, (_, offset) =>
        writeFile(join(f.project, `entry-${start + offset}`), "")
      )
    )
  await expect(f.files.run("fs.list", ".", f.signal)).rejects.toThrow("MODS_FS_ENTRY_LIMIT")
  const filtered = new ProjectFunctionFiles(
    f.project,
    () => {},
    async (v) => v,
    async (tool) => ({ decision: tool === "host:ls" ? "allow" : "deny" })
  )
  await expect(filtered.run("fs.list", ".", f.signal)).rejects.toThrow("MODS_FS_ENTRY_LIMIT")
}, 30000)

it("applies real backend path policy before reading and hides denied directory entries", async () => {
  const f = await fixture()
  await writeFile(join(f.project, "public.txt"), "public")
  await writeFile(join(f.project, "private.txt"), "never publish")
  const query = vi.fn(async (_tool: string, input: Record<string, unknown>) => ({
    decision: String(input.file_path ?? input.path).endsWith("private.txt")
      ? ("deny" as const)
      : ("allow" as const)
  }))
  const files = new ProjectFunctionFiles(
    f.project,
    () => {},
    async (v) => v,
    query
  )
  expect(await files.run("fs.read", "public.txt", f.signal)).toBe("public")
  await expect(files.run("fs.read", "private.txt", f.signal)).rejects.toThrow(
    "MODS_FS_ACCESS_DENIED"
  )
  expect(await files.run("fs.exists", "private.txt", f.signal)).toBe(false)
  expect(await files.run("fs.list", ".", f.signal)).toEqual([
    { name: "public.txt", kind: "file", size: 6 }
  ])
  expect(query).toHaveBeenCalledWith("host:read_file", { file_path: join(f.project, "public.txt") })
})

it("does not publish a read whose backend policy changed during the operation", async () => {
  const f = await fixture()
  await writeFile(join(f.project, "name.txt"), "private")
  let checked = 0
  const publish = vi.fn(async (v) => v)
  const files = new ProjectFunctionFiles(
    f.project,
    () => {},
    publish,
    async () => ({ decision: ++checked < 3 ? "allow" : "deny" })
  )
  await expect(files.run("fs.read", "name.txt", f.signal)).rejects.toThrow("MODS_FS_ACCESS_DENIED")
  expect(publish).not.toHaveBeenCalled()
})
