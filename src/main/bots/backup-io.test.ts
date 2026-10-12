import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writePrivateJson } from "./backup-io"

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) }
})
const roots: string[] = []
afterEach(async () => {
  vi.mocked(open).mockReset()
  vi.mocked(rename).mockReset()
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(open).mockImplementation(fs.open)
  vi.mocked(rename).mockImplementation(fs.rename)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-backup-json-")))
  roots.push(root)
  const path = join(root, "journal.json")
  await writeFile(path, "previous committed bytes")
  return { root, path, pending: path + ".pending" }
}

for (const stage of ["write", "sync", "rename"] as const)
  it(`cleans only its unpublished pending file after ${stage} failure and permits immediate retry`, async () => {
    const f = await fixture(),
      fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"),
      failure = new Error(`${stage} interrupted`)
    if (stage === "rename") vi.mocked(rename).mockRejectedValueOnce(failure)
    else
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await fs.open(...args)
        return {
          writeFile:
            stage === "write" ? async () => Promise.reject(failure) : handle.writeFile.bind(handle),
          sync: stage === "sync" ? async () => Promise.reject(failure) : handle.sync.bind(handle),
          close: handle.close.bind(handle)
        } as FileHandle
      })
    await expect(writePrivateJson(f.path, { revision: 1 })).rejects.toThrow("interrupted")
    expect(await readFile(f.path, "utf8")).toBe("previous committed bytes")
    await expect(readFile(f.pending)).rejects.toMatchObject({ code: "ENOENT" })
    await writePrivateJson(f.path, { revision: 2 })
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ revision: 2 })
  })

it("does not remove somebody else's pending file when wx admission is rejected", async () => {
  const f = await fixture()
  await writeFile(f.pending, "another writer owns these bytes")
  await expect(writePrivateJson(f.path, {})).rejects.toMatchObject({ code: "EEXIST" })
  expect(await readFile(f.pending, "utf8")).toBe("another writer owns these bytes")
  expect(await readFile(f.path, "utf8")).toBe("previous committed bytes")
})

it.skipIf(process.platform === "win32")(
  "retains the published target if directory fsync fails after rename",
  async () => {
    const f = await fixture(),
      fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(open).mockImplementation(async (path, ...args) => {
      if (path === f.root) throw new Error("directory sync interrupted")
      return fs.open(path, ...args)
    })
    await expect(writePrivateJson(f.path, { revision: 1 })).rejects.toThrow("interrupted")
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ revision: 1 })
    await expect(readFile(f.pending)).rejects.toMatchObject({ code: "ENOENT" })
  }
)
