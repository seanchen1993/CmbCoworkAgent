import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile, link, symlink, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readBoundedProjectFiles, PROJECT_FILE_OBSERVATION_LIMITS } from "./bounded-project-files"
import { compareStageDebugFiles } from "./stage-debug-file-comparison"
import { runtimeDigest } from "./safe-files"
import * as scopedReader from "./safe-files-async"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bounded-project-files-"))
  roots.push(root)
  const before = join(root, "before"),
    after = join(root, "after")
  await mkdir(before)
  await mkdir(after)
  return { root, before, after }
}
describe("bounded stage input file observations", () => {
  it("compares raw hashes across roots, preserving added/deleted/modified/binary and empty files", async () => {
    const f = await fixture()
    for (const root of [f.before, f.after]) {
      await writeFile(join(root, "same.txt"), "same")
      await writeFile(join(root, "empty.txt"), "")
    }
    await writeFile(join(f.before, "change.txt"), "before")
    await writeFile(join(f.after, "change.txt"), "after")
    await writeFile(join(f.before, "gone.txt"), "deleted-content-sentinel")
    await writeFile(join(f.after, "binary.bin"), Buffer.from([0, 1, 2]))
    const before = await readBoundedProjectFiles(f.before, { guard: () => {} })
    const after = await readBoundedProjectFiles(f.after, { guard: () => {} })
    const result = compareStageDebugFiles(before, after)
    expect(result.counts).toEqual({ added: 1, deleted: 1, modified: 1, unchanged: 2 })
    expect(result.files.find((file) => file.path === "binary.bin")).toMatchObject({
      change: "added",
      binary: true,
      beforeSha256: null
    })
    expect(result.files.find((file) => file.path === "change.txt")?.afterSha256).toBe(
      runtimeDigest("after")
    )
    expect(JSON.stringify(result)).not.toContain(f.root)
    expect(JSON.stringify(result)).not.toContain("deleted-content-sentinel") // no file contents
  })
  it("fully validates expected baseline contents and empty directories", async () => {
    const f = await fixture()
    await mkdir(join(f.before, "empty"))
    await writeFile(join(f.before, "input.txt"), "safe")
    const baseline = await readBoundedProjectFiles(f.before, { guard: () => {} })
    await expect(
      readBoundedProjectFiles(f.before, { guard: () => {}, expected: baseline })
    ).resolves.toBeDefined()
    await writeFile(join(f.before, "input.txt"), "changed")
    await expect(
      readBoundedProjectFiles(f.before, { guard: () => {}, expected: baseline })
    ).rejects.toThrow("FILES_CHANGED")
    await writeFile(join(f.before, "input.txt"), "safe")
    await rm(join(f.before, "empty"), { recursive: true })
    await expect(
      readBoundedProjectFiles(f.before, { guard: () => {}, expected: baseline })
    ).rejects.toThrow("FILES_CHANGED")
  })
  it.each([".env", "nested/secrets.json", ".envrc", "private.key"])(
    "rejects %s before returning any partial inventory",
    async (path) => {
      const f = await fixture()
      if (path.includes("/")) await mkdir(join(f.after, "nested"))
      await writeFile(join(f.after, path), "never return these bytes")
      const read = vi.spyOn(scopedReader, "readRuntimeScopedFileAsync")
      await expect(readBoundedProjectFiles(f.after, { guard: () => {} })).rejects.toThrow(
        "SENSITIVE_PATH"
      )
      expect(read).not.toHaveBeenCalled()
    }
  )
  it("refuses hard links and directory junctions", async () => {
    const f = await fixture()
    await writeFile(join(f.root, "outside.txt"), "outside")
    await link(join(f.root, "outside.txt"), join(f.after, "linked.txt"))
    await expect(readBoundedProjectFiles(f.after, { guard: () => {} })).rejects.toThrow(
      "UNSAFE_FILE"
    )
    await rm(join(f.after, "linked.txt"))
    await symlink(
      f.before,
      join(f.after, "linked-dir"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await expect(readBoundedProjectFiles(f.after, { guard: () => {} })).rejects.toThrow(
      "UNSAFE_FILE"
    )
  })
  it("rejects an input modified after its hash read instead of returning a mixed tree", async () => {
    const f = await fixture()
    await writeFile(join(f.after, "input.txt"), "before")
    const original = scopedReader.readRuntimeScopedFileAsync
    vi.spyOn(scopedReader, "readRuntimeScopedFileAsync").mockImplementation(async (...args) => {
      const observed = await original(...args)
      await writeFile(join(f.after, "input.txt"), "after-metadata-change")
      return observed
    })
    await expect(readBoundedProjectFiles(f.after, { guard: () => {} })).rejects.toThrow(
      "FILES_CHANGED"
    )
  })
  it("honors cancellation and original scope revocation", async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort(Error("STOP_READ"))
    await expect(
      readBoundedProjectFiles(f.after, { guard: () => {}, signal: controller.signal })
    ).rejects.toThrow("STOP_READ")
    await expect(
      readBoundedProjectFiles(f.after, {
        guard: () => {
          throw Error("SCOPE_REVOKED")
        }
      })
    ).rejects.toThrow("SCOPE_REVOKED")
  })
  it("refuses an oversized file before reading it", async () => {
    const f = await fixture()
    await writeFile(join(f.after, "large.bin"), "")
    await truncate(join(f.after, "large.bin"), PROJECT_FILE_OBSERVATION_LIMITS.fileBytes + 1)
    const read = vi.spyOn(scopedReader, "readRuntimeScopedFileAsync")
    await expect(readBoundedProjectFiles(f.after, { guard: () => {} })).rejects.toThrow("LIMIT")
    expect(read).not.toHaveBeenCalled()
  })
})
