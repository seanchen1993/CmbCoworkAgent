import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { chmodSync, mkdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { captureFlowRecoveryArtifacts } from "./recovery-artifacts"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "cmb-flow-recovery-artifacts-"))
  directories.push(workspace)
  const controller = new AbortController()
  const capture = (assertCurrent = () => {}) =>
    captureFlowRecoveryArtifacts({
      workspace,
      signal: controller.signal,
      assertCurrent
    })
  return { workspace, controller, capture }
}
describe("bounded complete workspace recovery artifact observation", () => {
  it("rejects an already-read file changed after the second read", async () => {
    const f = await fixture()
    const path = join(f.workspace, "a.txt")
    await writeFile(path, "before")
    let calls = 0
    let changed = false
    // For a one-file tree, call 13 is the second scan's post-read authority check.
    await expect(
      f.capture(() => {
        if (++calls === 13) {
          writeFileSync(path, "after!")
          changed = true
        }
      })
    ).rejects.toThrow("FLOW_RECOVERY_ARTIFACTS_CHANGED")
    expect(changed).toBe(true)
  })
  it("rejects directory membership changed and restored during observation", async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, "a.txt"), "unchanged")
    let calls = 0
    let changed = false
    await expect(
      f.capture(() => {
        if (++calls === 13) {
          const temporary = join(f.workspace, "temporary-directory")
          mkdirSync(temporary)
          rmdirSync(temporary)
          changed = true
        }
      })
    ).rejects.toThrow("FLOW_RECOVERY_ARTIFACTS_CHANGED")
    expect(changed).toBe(true)
  })
  it("rejects an already-read path replaced by a junction before publication", async () => {
    const f = await fixture()
    const external = await fixture()
    const path = join(f.workspace, "a.txt")
    await writeFile(path, "unchanged")
    let calls = 0
    let changed = false
    await expect(
      f.capture(() => {
        if (++calls === 13) {
          rmSync(path)
          symlinkSync(external.workspace, path, process.platform === "win32" ? "junction" : "dir")
          changed = true
        }
      })
    ).rejects.toThrow(/FLOW_RECOVERY_ARTIFACT(?:S_CHANGED|_LINK)/)
    expect(changed).toBe(true)
  })
  it("includes file permission mode in the persistent digest", async () => {
    const f = await fixture()
    const path = join(f.workspace, "script")
    await writeFile(path, "same bytes")
    const before = await f.capture()
    try {
      chmodSync(path, process.platform === "win32" ? 0o444 : 0o755)
      expect((await f.capture()).digest).not.toBe(before.digest)
    } finally {
      chmodSync(path, 0o644)
    }
  })
  it("includes ignored and normally excluded build outputs and their deletion", async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, ".gitignore"), "dist/\n")
    await mkdir(join(f.workspace, "dist"))
    await writeFile(join(f.workspace, "dist", "artifact.txt"), "one")
    const before = await f.capture()
    expect(before.fileCount).toBe(2)
    await writeFile(join(f.workspace, "dist", "artifact.txt"), "two")
    const modified = await f.capture()
    expect(modified.digest).not.toBe(before.digest)
    await rm(join(f.workspace, "dist", "artifact.txt"))
    const removed = await f.capture()
    expect(removed.digest).not.toBe(modified.digest)
    expect(removed.fileCount).toBe(1)
    await writeFile(join(f.workspace, "dist", "new.txt"), "new")
    expect((await f.capture()).digest).not.toBe(removed.digest)
  })
  it("covers empty directories and nested .git entries rather than silently omitting them", async () => {
    const f = await fixture()
    const before = await f.capture()
    await mkdir(join(f.workspace, "nested", ".git"), { recursive: true })
    await writeFile(join(f.workspace, "nested", ".git", "data"), "nested dependency")
    const after = await f.capture()
    expect(after.digest).not.toBe(before.digest)
    expect(after.fileCount).toBe(1)
  })
  it("explicitly excludes only root git metadata and does not claim to verify HEAD", async () => {
    const f = await fixture()
    await mkdir(join(f.workspace, ".git"))
    await writeFile(join(f.workspace, ".git", "HEAD"), "first")
    const before = await f.capture()
    await writeFile(join(f.workspace, ".git", "HEAD"), "second")
    expect(await f.capture()).toEqual(before)
    expect(before.coverage).toBe("workspace-excluding-root-git-metadata")
  })
  it("rejects a directory junction instead of traversing outside the project", async () => {
    const f = await fixture()
    const external = await fixture()
    await symlink(
      external.workspace,
      join(f.workspace, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await expect(f.capture()).rejects.toThrow("FLOW_RECOVERY_ARTIFACT_LINK")
  })
  it("fails closed when even an ignored dependency exceeds the byte limit", async () => {
    const f = await fixture()
    await mkdir(join(f.workspace, "node_modules"))
    await writeFile(join(f.workspace, "node_modules", "large"), Buffer.alloc(4 * 1024 * 1024 + 1))
    await expect(f.capture()).rejects.toThrow("FLOW_RECOVERY_ARTIFACT_LIMIT")
  })
  it("checks revocation and abort before publishing any snapshot", async () => {
    const f = await fixture()
    await expect(
      f.capture(() => {
        throw Error("revoked")
      })
    ).rejects.toThrow("revoked")
    f.controller.abort(Error("cancelled"))
    await expect(f.capture()).rejects.toThrow("cancelled")
  })
  it("returns only bounded digests and counts, never file content or secret names", async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, "sensitive-name"), "secret-content")
    const snapshot = JSON.stringify(await f.capture())
    expect(snapshot).not.toContain("sensitive-name")
    expect(snapshot).not.toContain("secret-content")
  })
})
