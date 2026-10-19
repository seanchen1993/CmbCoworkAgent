import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as stableFiles from "../../services/stable-file-handle"
import { fingerprintAutobizWorkflow } from "./autobiz-validation"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-workflow-fingerprint-"))
  roots.push(root)
  const parent = join(root, ".autobizdevops")
  const overlay = join(parent, "workflow.d")
  await mkdir(parent)
  return { root, parent, overlay }
}

it("honors cancellation even when the optional workflow directory is absent", async () => {
  const f = await fixture()
  const signal = AbortSignal.abort(Error("cancelled workflow scan"))
  await expect(fingerprintAutobizWorkflow(f.root, signal)).rejects.toThrow(
    "cancelled workflow scan"
  )
})

it.each(["root", "nested"])(
  "rejects a %s junction instead of fingerprinting an incomplete overlay",
  async (kind) => {
    const f = await fixture()
    const outside = await fixture()
    await writeFile(join(outside.root, "workflow.json"), "{}")
    if (kind === "nested") await mkdir(f.overlay)
    await symlink(outside.root, kind === "root" ? f.overlay : join(f.overlay, "linked"), "junction")
    await expect(fingerprintAutobizWorkflow(f.root)).rejects.toThrow("AUTOBIZ_WORKFLOW_LINK")
  }
)

it("bounds nesting before recursively walking an arbitrarily deep workflow tree", async () => {
  const f = await fixture()
  await mkdir(join(f.overlay, ...Array.from({ length: 25 }, () => "d")), { recursive: true })
  await expect(fingerprintAutobizWorkflow(f.root)).rejects.toThrow("AUTOBIZ_WORKFLOW_LIMIT")
})

it("bounds empty directory entries as well as files", async () => {
  const f = await fixture()
  await mkdir(f.overlay)
  for (let base = 0; base < 2048; base += 64)
    await Promise.all(
      Array.from({ length: 64 }, (_, index) => mkdir(join(f.overlay, `d${base + index}`)))
    )
  await expect(fingerprintAutobizWorkflow(f.root)).rejects.toThrow("AUTOBIZ_WORKFLOW_LIMIT")
}, 30000)

it("refuses an oversized regular file and accepts a later bounded replacement", async () => {
  const f = await fixture()
  await mkdir(f.overlay)
  const file = join(f.overlay, "workflow.json")
  const handle = await open(file, "w")
  try {
    await handle.truncate(8 * 1024 * 1024 + 1)
  } finally {
    await handle.close()
  }
  await expect(fingerprintAutobizWorkflow(f.root)).rejects.toThrow("AUTOBIZ_WORKFLOW_LIMIT")
  await writeFile(file, "{}")
  expect(await fingerprintAutobizWorkflow(f.root)).toMatch(/^[a-f0-9]{64}$/)
})

it("rejects a directory changed into a junction between enumeration and bounded open", async () => {
  const f = await fixture()
  await mkdir(f.overlay)
  await writeFile(join(f.overlay, "workflow.json"), "original")
  const replacement = join(f.root, "replacement")
  await mkdir(replacement)
  await writeFile(join(replacement, "workflow.json"), "replacement")
  const original = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementationOnce(async (root, path) => {
    await rename(f.overlay, `${f.overlay}-previous`)
    await symlink(replacement, f.overlay, "junction")
    return original(root, path)
  })
  await expect(fingerprintAutobizWorkflow(f.root)).rejects.toThrow("AUTOBIZ_WORKFLOW_LINK")
})

it("rejects a file added after enumeration instead of accepting a partial tree hash", async () => {
  const f = await fixture()
  await mkdir(f.overlay)
  await writeFile(join(f.overlay, "workflow.json"), "{}")
  const original = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementationOnce(async (root, path) => {
    await writeFile(join(f.overlay, "new.json"), "{}")
    return original(root, path)
  })
  await expect(fingerprintAutobizWorkflow(f.root)).rejects.toThrow("AUTOBIZ_WORKFLOW_CHANGED")
})

it.each(["root", "nested"])(
  "rejects an added %s member even when directory mtime and ctime remain unchanged",
  async (kind) => {
    const f = await fixture()
    const directory = kind === "root" ? f.overlay : join(f.overlay, "nested")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "workflow.json"), "{}")
    const before = await fsPromises.lstat(directory, { bigint: true })
    const originalLstat = fsPromises.lstat
    const lstat = vi
      .spyOn(fsPromises, "lstat")
      .mockImplementation((path, options) =>
        path === directory ? Promise.resolve(before) : originalLstat(path, options)
      )
    const originalOpen = stableFiles.openStableFileHandle
    let inserted = false
    vi.spyOn(stableFiles, "openStableFileHandle").mockImplementationOnce(async (root, path) => {
      await writeFile(join(directory, "new.json"), "{}")
      inserted = true
      return originalOpen(root, path)
    })
    await expect(fingerprintAutobizWorkflow(f.root)).rejects.toThrow("AUTOBIZ_WORKFLOW_CHANGED")
    expect(inserted).toBe(true)
    const observations = lstat.mock.calls.flatMap((args, index) =>
      args[0] === directory ? [lstat.mock.results[index]] : []
    )
    expect(observations.length).toBeGreaterThanOrEqual(3)
    for (const observation of observations) expect(await observation.value).toBe(before)
  }
)

it("closes the opened handle when cancellation arrives during a bounded read", async () => {
  const f = await fixture()
  await mkdir(f.overlay)
  await writeFile(join(f.overlay, "workflow.json"), "{}")
  const controller = new AbortController()
  const original = stableFiles.readStableFileHandleBounded
  let handle: Awaited<ReturnType<typeof stableFiles.openStableFileHandle>> | undefined
  vi.spyOn(stableFiles, "readStableFileHandleBounded").mockImplementationOnce(
    async (opened, limit) => {
      handle = opened
      const value = await original(opened, limit)
      controller.abort(Error("cancelled during read"))
      return value
    }
  )
  await expect(fingerprintAutobizWorkflow(f.root, controller.signal)).rejects.toThrow(
    "cancelled during read"
  )
  expect(handle?.handle.fd).toBe(-1)
})
