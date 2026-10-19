import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HOST_PACKAGE_LIMITS, RetainedPackageSnapshots } from "./package-snapshots"

const hooks = vi.hoisted(() => ({
  afterMkdir: undefined as ((path: string) => void) | undefined,
  beforeOpen: undefined as ((path: string, flags: string | number | undefined) => void) | undefined,
  beforeWrite: undefined as (() => void) | undefined
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...original,
    mkdir: async (...args: Parameters<typeof original.mkdir>) => {
      const result = await original.mkdir(...args)
      hooks.afterMkdir?.(String(args[0]))
      return result
    },
    open: async (...args: Parameters<typeof original.open>) => {
      hooks.beforeOpen?.(String(args[0]), args[1])
      return original.open(...args)
    }
  }
})

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>()
  return {
    ...original,
    writeSync: (...args: Parameters<typeof original.writeSync>) => {
      hooks.beforeWrite?.()
      return original.writeSync(...args)
    }
  }
})

const base = join(tmpdir(), "retained-publication-")
const roots: string[] = []
function fixture() {
  const root = mkdtempSync(base)
  roots.push(root)
  const source = join(root, "source")
  mkdirSync(source)
  writeFileSync(join(source, "plugin.json"), '{"name":"fixture","version":"1"}')
  writeFileSync(join(source, "resource.txt"), "Original")
  const snapshots = new RetainedPackageSnapshots(join(root, "retained"))
  return { root, source, snapshots }
}
afterEach(() => {
  hooks.afterMkdir = undefined
  hooks.beforeOpen = undefined
  hooks.beforeWrite = undefined
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base)) throw Error("Unsafe fixture cleanup")
    rmSync(root, { recursive: true, force: true })
  }
})

describe("retained package preparation lifecycle", () => {
  it("discards the losing preparation when two instances retain identical bytes concurrently", async () => {
    const { source, snapshots } = fixture()
    const peer = new RetainedPackageSnapshots(snapshots.root)
    const [first, second] = await Promise.all([
      snapshots.captureAsync(source),
      peer.captureAsync(source)
    ])
    expect(second).toEqual(first)
    expect(readdirSync(snapshots.root).filter((name) => name !== ".snapshot-retention")).toEqual([first.digest])
    expect((await peer.readAsync(first.digest)).root).toBe(first.root)
  })

  it("cleans cancelled writes after draining them and keeps an earlier published version", async () => {
    const { source, snapshots } = fixture()
    const original = snapshots.capture(source)
    writeFileSync(join(source, "resource.txt"), "Updated")
    const controller = new AbortController()
    hooks.beforeOpen = (_path, flags) => {
      if (flags === "wx") controller.abort(Error("cancelled during copy"))
    }
    await expect(snapshots.captureAsync(source, controller.signal)).rejects.toThrow(
      "cancelled during copy"
    )
    expect(readdirSync(snapshots.root).filter((name) => name !== ".snapshot-retention")).toEqual([original.digest])
    expect(readFileSync(join(snapshots.read(original.digest).root, "resource.txt"), "utf8")).toBe(
      "Original"
    )
  })

  it("cleans an asynchronous copy failure while preserving its error", async () => {
    const { source, snapshots } = fixture()
    hooks.beforeOpen = (_path, flags) => {
      if (flags === "wx") throw Error("fixture write denied")
    }
    await expect(snapshots.captureAsync(source)).rejects.toThrow("fixture write denied")
    expect(readdirSync(snapshots.root).filter((name) => name !== ".snapshot-retention")).toEqual([])
  })

  it("cleans a synchronous copy failure while preserving its error", () => {
    const { source, snapshots } = fixture()
    hooks.beforeWrite = () => {
      throw Error("fixture write denied")
    }
    expect(() => snapshots.capture(source)).toThrow("fixture write denied")
    expect(readdirSync(snapshots.root).filter((name) => name !== ".snapshot-retention")).toEqual([])
  })

  it("does not recursively remove a preparation replaced by a directory junction", async () => {
    const { root, source, snapshots } = fixture()
    const other = join(root, "other")
    mkdirSync(other)
    writeFileSync(join(other, "keep.txt"), "Keep unrelated bytes")
    const controller = new AbortController()
    hooks.afterMkdir = (path) => {
      if (dirname(dirname(path)) !== snapshots.root) return
      const staging = dirname(path)
      renameSync(staging, join(root, "displaced-preparation"))
      symlinkSync(other, staging, process.platform === "win32" ? "junction" : "dir")
      controller.abort(Error("cancelled after replacement"))
    }
    await expect(snapshots.captureAsync(source, controller.signal)).rejects.toThrow(
      "cancelled after replacement"
    )
    expect(readFileSync(join(other, "keep.txt"), "utf8")).toBe("Keep unrelated bytes")
    expect(readdirSync(snapshots.root).filter((name) => name !== ".snapshot-retention")).toHaveLength(1)
  })

  it.each(["sync", "async"])(
    "ignores prior preparations and diagnostic files in %s published capacity",
    async (mode) => {
      const { source, snapshots } = fixture()
      for (let index = 0; index < HOST_PACKAGE_LIMITS.snapshots; index++)
        mkdirSync(join(snapshots.root, `pending-prior-${index}`))
      const diagnostic = join(snapshots.root, "diagnostic.txt")
      writeFileSync(diagnostic, "Preserved diagnostic")
      const snapshot =
        mode === "sync" ? snapshots.capture(source) : await snapshots.captureAsync(source)
      expect(readFileSync(join(snapshot.root, "resource.txt"), "utf8")).toBe("Original")
      expect(readFileSync(diagnostic, "utf8")).toBe("Preserved diagnostic")
      expect(readdirSync(snapshots.root).filter((name) => name !== ".snapshot-retention")).toHaveLength(HOST_PACKAGE_LIMITS.snapshots + 2)
    }
  )

  it("keeps published capacity and retained bytes intact when concurrent versions fill the last slot", async () => {
    const { root, source, snapshots } = fixture()
    const original = snapshots.capture(source)
    for (let index = 0; index < HOST_PACKAGE_LIMITS.snapshots - 2; index++)
      mkdirSync(join(snapshots.root, index.toString(16).padStart(64, "0")))
    writeFileSync(join(source, "resource.txt"), "New first version")
    const otherSource = join(root, "other-source")
    mkdirSync(otherSource)
    writeFileSync(join(otherSource, "resource.txt"), "New second version")
    const outcomes = await Promise.allSettled([
      snapshots.captureAsync(source),
      snapshots.captureAsync(otherSource)
    ])
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const failure = outcomes.find((result) => result.status === "rejected")
    expect(failure?.status === "rejected" && failure.reason.message).toBe(
      "PROJECT_HOST_SNAPSHOT_CAPACITY"
    )
    expect(readdirSync(snapshots.root).filter((name) => name !== ".snapshot-retention")).toHaveLength(HOST_PACKAGE_LIMITS.snapshots)
    expect(readFileSync(join(snapshots.read(original.digest).root, "resource.txt"), "utf8")).toBe(
      "Original"
    )
    writeFileSync(join(otherSource, "resource.txt"), "Another unretained version")
    expect(() => snapshots.capture(otherSource)).toThrow("SNAPSHOT_CAPACITY")
  })
})
