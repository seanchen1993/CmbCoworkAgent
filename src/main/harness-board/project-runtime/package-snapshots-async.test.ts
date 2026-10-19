import { afterEach, describe, expect, it } from "vitest"
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RetainedPackageSnapshots } from "./package-snapshots"
import { runtimeDirectoryIdentity } from "./safe-files"

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "async-snapshots-"))
  roots.push(root)
  const source = join(root, "source")
  mkdirSync(join(source, "skills", "example"), { recursive: true })
  mkdirSync(join(source, "empty"))
  writeFileSync(join(source, "plugin.json"), '{"name":"fixture"}')
  writeFileSync(join(source, "skills/example/SKILL.md"), "# Original")
  writeFileSync(join(source, "resource.bin"), Buffer.from([0, 255, 1]))
  return { root, source, snapshots: new RetainedPackageSnapshots(join(root, "retained")) }
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function expectOnlyIdleRetentionMetadata(root: string) {
  expect(readdirSync(root)).toEqual([".snapshot-retention"])
  const metadata = join(root, ".snapshot-retention")
  const directory = lstatSync(metadata)
  expect(directory.isDirectory() && !directory.isSymbolicLink()).toBe(true)
  // This exact allowlist rejects pending/published packages and all reader/maintenance locks.
  expect(readdirSync(metadata).sort()).toEqual(["protocol-v1.json", "readers"])
  const marker = join(metadata, "protocol-v1.json")
  const stat = lstatSync(marker)
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true)
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
    version: 1,
    rootIdentity: runtimeDirectoryIdentity(root),
    boot: expect.any(String),
    legacy: []
  })
  const readers = join(metadata, "readers")
  const readerDirectory = lstatSync(readers)
  expect(readerDirectory.isDirectory() && !readerDirectory.isSymbolicLink()).toBe(true)
  expect(readdirSync(readers)).toEqual([])
}

describe("async retained package admission", () => {
  it("retains identical complete bytes and digest while allowing the main loop to run", async () => {
    const { root, source, snapshots } = fixture()
    const original = new RetainedPackageSnapshots(join(root, "sync")).capture(source)
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    try {
      const copied = await snapshots.captureAsync(source)
      expect(copied.digest).toBe(original.digest)
      expect(readFileSync(join(copied.root, "resource.bin"))).toEqual(Buffer.from([0, 255, 1]))
      expect(readdirSync(join(copied.root, "empty"))).toEqual([])
      expect((await snapshots.readAsync(copied.digest)).digest).toBe(original.digest)
      expect((await snapshots.captureAsync(source)).root).toBe(copied.root)
      const guard = await snapshots.captureGuardAsync(copied.digest)
      guard()
      writeFileSync(join(copied.root, "skills/example/SKILL.md"), "# Changed")
      expect(guard).toThrow("PACKAGE_CHANGED")
      await expect(snapshots.readAsync(copied.digest)).rejects.toThrow("PACKAGE_CHANGED")
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
    }
  })

  it("rejects unsafe sources before publishing and honors cancellation", async () => {
    const { source, snapshots } = fixture()
    writeFileSync(join(source, ".env"), "fixture-not-a-secret")
    await expect(snapshots.captureAsync(source)).rejects.toThrow("PACKAGE_SENSITIVE_PATH")
    rmSync(join(source, ".env"))
    linkSync(join(source, "resource.bin"), join(source, "linked.bin"))
    await expect(snapshots.captureAsync(source)).rejects.toThrow()
    rmSync(join(source, "linked.bin"))
    const controller = new AbortController()
    controller.abort(Error("cancelled by fixture"))
    await expect(snapshots.captureAsync(source, controller.signal)).rejects.toThrow("cancelled")
    expectOnlyIdleRetentionMetadata(snapshots.root)
  })

  it("drains in-flight readers when an admission is cancelled", async () => {
    const { source, snapshots } = fixture()
    for (let index = 0; index < 24; index++)
      writeFileSync(join(source, `asset-${index}.txt`), "fixture".repeat(1024))
    const controller = new AbortController()
    const pending = snapshots.captureAsync(source, controller.signal)
    queueMicrotask(() => controller.abort(Error("cancelled during admission")))
    await expect(pending).rejects.toThrow("cancelled")
    expectOnlyIdleRetentionMetadata(snapshots.root)
  })
})
