import { createHash } from "node:crypto"
import type { Dirent, PathLike, Stats } from "node:fs"
import { link, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { setImmediate as immediate } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DERIVATION_LIMITS, snapshotDerivationSource } from "./derivation-source"

interface Controls {
  opened?(path: string): void
  opening?(path: string): void
  closing?(path: string): Promise<void> | void
  read?(path: string): Promise<void>
  closed?(path: string): Promise<void> | void
  lstat?(path: string, stat: Stats): Stats
  stat?(path: string, stat: Stats, count: number): Stats
  realpath?(path: string, actual: string): string
  chunk?: number
  eof?: boolean
  virtualSizes?: Map<string, number>
  metadataOnly?: { root: string; entries: number; stat: Stats; template: Dirent }
}

const state = vi.hoisted(() => ({
  controls: {} as Controls,
  opened: [] as string[],
  closeCalls: new Map<string, number>(),
  live: 0,
  maxLive: 0,
  allocated: 0,
  buffers: new WeakSet<object>()
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const size = (path: string, stat: Stats): Stats => {
    const bytes = state.controls.virtualSizes?.get(basename(path))
    return bytes === undefined
      ? stat
      : Object.assign(Object.create(Object.getPrototypeOf(stat)) as Stats, stat, { size: bytes })
  }
  return {
    ...actual,
    readdir: async (path: PathLike, options: { withFileTypes: true }) => {
      const virtual = state.controls.metadataOnly
      if (virtual && String(path) === virtual.root)
        return Array.from({ length: virtual.entries }, (_, index) =>
          Object.assign(
            Object.create(Object.getPrototypeOf(virtual.template)) as Dirent,
            virtual.template,
            { name: `credentials.${String(index).padStart(4, "0")}` }
          )
        )
      return actual.readdir(path, options)
    },
    lstat: async (path: PathLike) => {
      const virtual = state.controls.metadataOnly
      if (
        virtual &&
        dirname(String(path)) === virtual.root &&
        basename(String(path)).startsWith("credentials.")
      )
        return virtual.stat
      const value = size(String(path), await actual.lstat(path))
      return state.controls.lstat?.(String(path), value) ?? value
    },
    realpath: async (path: PathLike) => {
      const virtual = state.controls.metadataOnly
      if (
        virtual &&
        dirname(String(path)) === virtual.root &&
        basename(String(path)).startsWith("credentials.")
      )
        return String(path)
      const value = await actual.realpath(path)
      return state.controls.realpath?.(String(path), value) ?? value
    },
    open: async (path: PathLike, flags: string | number) => {
      state.controls.opening?.(String(path))
      const handle = await actual.open(path, flags)
      const name = String(path)
      state.opened.push(name)
      state.maxLive = Math.max(state.maxLive, ++state.live)
      try {
        state.controls.opened?.(name)
      } catch (error) {
        await handle.close()
        state.live--
        throw error
      }
      let statCount = 0
      let closed = false
      return new Proxy(handle, {
        get(target, key) {
          if (key === "stat")
            return async () => {
              const value = size(name, await target.stat())
              return state.controls.stat?.(name, value, ++statCount) ?? value
            }
          if (key === "read")
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              if (!state.buffers.has(buffer)) {
                state.buffers.add(buffer)
                state.allocated += buffer.length
              }
              await state.controls.read?.(name)
              if (state.controls.eof) return { bytesRead: 0, buffer }
              if (state.controls.virtualSizes?.has(basename(name)))
                return { bytesRead: length, buffer }
              return target.read(
                buffer,
                offset,
                Math.min(length, state.controls.chunk ?? length),
                position
              )
            }
          if (key === "close")
            return async () => {
              state.closeCalls.set(name, (state.closeCalls.get(name) ?? 0) + 1)
              try {
                if (state.controls.closing) await state.controls.closing(name)
                await target.close()
                await state.controls.closed?.(name)
              } finally {
                if (!closed) state.live--
                closed = true
              }
            }
          const value: unknown = Reflect.get(target, key, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
    }
  }
})

const roots: string[] = []
const manifest = JSON.stringify({ name: "snapshot-regression", version: "1.0.0" })
const fixture = async (entries: Record<string, string> = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "cmb-derivation-read-"))
  roots.push(root)
  for (const [name, content] of Object.entries({ "plugin.json": manifest, ...entries })) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return root
}
const changed = (stat: Stats, fields: Partial<Stats>): Stats =>
  Object.assign(Object.create(Object.getPrototypeOf(stat)) as Stats, stat, fields)
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_yes, no) => {
        timer = setTimeout(() => no(Error("fixture signal did not arrive")), 2000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

beforeEach(() => {
  state.controls = {}
  state.opened = []
  state.closeCalls = new Map()
  state.live = 0
  state.maxLive = 0
  state.allocated = 0
  state.buffers = new WeakSet()
})
afterEach(async () => {
  state.controls = {}
  expect(state.live).toBe(0)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("derivation source content read ownership", () => {
  it("keeps DFS files, exclusions, bytes, hashes and modes with partial native reads", async () => {
    const expected = {
      "a.txt": "alpha",
      "nested/b.txt": "beta",
      "plugin.json": manifest,
      "z.txt": "omega"
    }
    const root = await fixture({
      "a.txt": "alpha",
      "nested/b.txt": "beta",
      "z.txt": "omega",
      ".env": "excluded fixture value",
      "nested/secret.key": "excluded fixture value"
    })
    state.controls.chunk = 1
    const snapshot = await snapshotDerivationSource(root)
    expect(snapshot.files.map((file) => file.path)).toEqual(Object.keys(expected))
    expect(snapshot.excluded).toEqual([".env", "nested/secret.key"])
    expect(snapshot.totalBytes).toBe(
      Object.values(expected).reduce((total, value) => total + Buffer.byteLength(value), 0)
    )
    for (const file of snapshot.files) {
      const content = expected[file.path as keyof typeof expected]
      expect(file.bytes).toEqual(Buffer.from(content))
      expect(file.digest).toBe(createHash("sha256").update(content).digest("hex"))
      expect(file.mode).toBe((await lstat(join(root, file.path))).mode)
    }
    expect(state.opened.some((path) => [".env", "secret.key"].includes(basename(path)))).toBe(false)
    expect([...state.closeCalls.values()].every((count) => count === 1)).toBe(true)
  })

  it("holds at most eight real handles across directories until close finishes", async () => {
    const root = await fixture(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `${index < 6 ? "a" : "b"}/${String(index).padStart(2, "0")}.txt`,
          "content"
        ])
      )
    )
    const held = deferred()
    const eight = deferred()
    state.controls.opened = () => {
      if (state.live === 8) eight.resolve()
    }
    state.controls.read = () => held.promise
    const snapshot = snapshotDerivationSource(root)
    try {
      await within(eight.promise)
      expect(state.maxLive).toBe(8)
      expect(state.live).toBe(8)
    } finally {
      held.resolve()
      await Promise.allSettled([snapshot])
    }
    expect((await snapshot).files).toHaveLength(13)
    expect(state.maxLive).toBeLessThanOrEqual(8)
    expect(state.live).toBe(0)
  })

  it("does not open a ninth file while eight native handles await close", async () => {
    const root = await fixture(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `a${String(index).padStart(2, "0")}.txt`,
          "content"
        ])
      )
    )
    const closeGate = deferred()
    const eightClosing = deferred()
    const eightClosed = deferred()
    const ninthMetadata = deferred()
    const held = new Set(
      Array.from({ length: 8 }, (_, index) => `a${String(index).padStart(2, "0")}.txt`)
    )
    const closing = new Set<string>()
    const closed = new Set<string>()
    const opening: string[] = []
    state.controls.opening = (path) => {
      opening.push(basename(path))
    }
    state.controls.closing = async (path) => {
      const name = basename(path)
      if (!held.has(name)) return
      closing.add(name)
      if (closing.size === 8) eightClosing.resolve()
      await closeGate.promise
    }
    state.controls.closed = (path) => {
      const name = basename(path)
      if (!held.has(name)) return
      closed.add(name)
      if (closed.size === 8) eightClosed.resolve()
    }
    state.controls.realpath = (path, actual) => {
      if (basename(path) === "a08.txt") ninthMetadata.resolve()
      return actual
    }
    let settled = false
    const snapshot = snapshotDerivationSource(root)
    void snapshot.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    try {
      await within(Promise.all([eightClosing.promise, ninthMetadata.promise]))
      // Flush the ready metadata continuation once; no retry or elapsed-time polling.
      await immediate()
      expect(closing.size).toBe(8)
      expect(state.live).toBe(8)
      expect(state.maxLive).toBe(8)
      expect(opening).toHaveLength(8)
      expect(opening).not.toContain("a08.txt")
      expect(state.closeCalls.size).toBe(8)
      expect(settled).toBe(false)
    } finally {
      closeGate.resolve()
      await Promise.allSettled([snapshot])
      if (closing.size === 8) await within(eightClosed.promise)
    }
    expect((await snapshot).files).toHaveLength(10)
    expect(state.maxLive).toBeLessThanOrEqual(8)
    expect(state.live).toBe(0)
    expect(state.opened).toHaveLength(10)
    expect(state.closeCalls.size).toBe(10)
    expect([...state.closeCalls.values()].every((count) => count === 1)).toBe(true)
    const finalOpeningCount = opening.length
    await immediate()
    expect(opening).toHaveLength(finalOpeningCount)
    expect(state.live).toBe(0)
  })

  it("returns the earlier DFS read error when the later read reports failure first", async () => {
    const root = await fixture({ "a.txt": "first", "b.txt": "second" })
    const releaseFirst = deferred()
    const releaseSecond = deferred()
    const bothReading = deferred()
    const firstClosed = deferred()
    const secondClosed = deferred()
    const manifestClosed = deferred()
    const reading = new Set<string>()
    const closeOrder: string[] = []
    const firstError = Error("earlier DFS content failure")
    const secondError = Error("later DFS content failure")
    state.controls.read = async (path) => {
      const name = basename(path)
      if (name !== "a.txt" && name !== "b.txt") return
      reading.add(name)
      if (reading.size === 2) bothReading.resolve()
      if (name === "a.txt") {
        await releaseFirst.promise
        throw firstError
      }
      await releaseSecond.promise
      throw secondError
    }
    state.controls.closed = (path) => {
      const name = basename(path)
      closeOrder.push(name)
      if (name === "a.txt") firstClosed.resolve()
      if (name === "b.txt") secondClosed.resolve()
      if (name === "plugin.json") manifestClosed.resolve()
    }
    let settled = false
    const snapshot = snapshotDerivationSource(root)
    void snapshot.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    try {
      await within(Promise.all([bothReading.promise, manifestClosed.promise]))
      releaseSecond.resolve()
      await within(secondClosed.promise)
      // The later read and its native close have rejected/settled before releasing a.
      await immediate()
      expect(closeOrder).toContain("b.txt")
      expect(closeOrder).not.toContain("a.txt")
      expect(state.live).toBe(1)
      expect(settled).toBe(false)
    } finally {
      releaseFirst.resolve()
      releaseSecond.resolve()
      await Promise.allSettled([snapshot])
      if (reading.has("a.txt")) await within(firstClosed.promise)
      if (reading.has("b.txt")) await within(secondClosed.promise)
    }
    await expect(snapshot).rejects.toBe(firstError)
    expect(closeOrder.indexOf("b.txt")).toBeLessThan(closeOrder.indexOf("a.txt"))
    expect(state.live).toBe(0)
    expect(state.opened).toHaveLength(3)
    expect(state.closeCalls.size).toBe(3)
    expect([...state.closeCalls.values()].every((count) => count === 1)).toBe(true)
    const finalOpened = state.opened.length
    const finalClosed = [...state.closeCalls.values()].reduce((total, count) => total + count, 0)
    await immediate()
    expect(state.opened).toHaveLength(finalOpened)
    expect([...state.closeCalls.values()].reduce((total, count) => total + count, 0)).toBe(
      finalClosed
    )
    expect(state.live).toBe(0)
  })

  it("publishes files in DFS order when a later file closes before the first", async () => {
    const root = await fixture({ "a.txt": "first", "b.txt": "second" })
    const first = deferred()
    const secondClosed = deferred()
    state.controls.read = (path) => (basename(path) === "a.txt" ? first.promise : Promise.resolve())
    state.controls.closed = (path) => {
      if (basename(path) === "b.txt") secondClosed.resolve()
    }
    const snapshot = snapshotDerivationSource(root)
    try {
      await within(secondClosed.promise)
    } finally {
      first.resolve()
      await Promise.allSettled([snapshot])
    }
    expect((await snapshot).files.map((file) => file.path)).toEqual([
      "a.txt",
      "b.txt",
      "plugin.json"
    ])
  })

  it("retains the earliest DFS read error over a later metadata error and drains it", async () => {
    const root = await fixture({ "a.txt": "first", "z.txt": "later" })
    const first = deferred()
    const later = deferred()
    const readError = Error("earlier read")
    const metadataError = Error("later metadata")
    state.controls.read = async (path) => {
      if (basename(path) === "a.txt") {
        await first.promise
        throw readError
      }
    }
    state.controls.lstat = (path, stat) => {
      if (basename(path) === "z.txt") {
        later.resolve()
        throw metadataError
      }
      return stat
    }
    let settled = false
    const snapshot = snapshotDerivationSource(root)
    void snapshot.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    try {
      await within(later.promise)
      expect(settled).toBe(false)
      expect(state.live).toBeGreaterThan(0)
    } finally {
      first.resolve()
      await Promise.allSettled([snapshot])
    }
    await expect(snapshot).rejects.toBe(readError)
    expect(state.live).toBe(0)
  })

  it("waits for another file's actual close promise before rejecting an earlier read", async () => {
    const root = await fixture({ "a.txt": "first", "b.txt": "second" })
    const failFirst = deferred()
    const closeSecond = deferred()
    const secondClosing = deferred()
    const firstClosed = deferred()
    const manifestClosed = deferred()
    const error = Error("earlier read")
    state.controls.read = async (path) => {
      if (basename(path) === "a.txt") {
        await failFirst.promise
        throw error
      }
    }
    state.controls.closed = async (path) => {
      if (basename(path) === "a.txt") firstClosed.resolve()
      if (basename(path) === "b.txt") {
        secondClosing.resolve()
        await closeSecond.promise
      }
      if (basename(path) === "plugin.json") manifestClosed.resolve()
    }
    let settled = false
    const snapshot = snapshotDerivationSource(root)
    void snapshot.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    try {
      await within(Promise.all([secondClosing.promise, manifestClosed.promise]))
      failFirst.resolve()
      await within(firstClosed.promise)
      await immediate()
      expect(settled).toBe(false)
      expect(state.live).toBe(1)
    } finally {
      failFirst.resolve()
      closeSecond.resolve()
      await Promise.allSettled([snapshot])
    }
    await expect(snapshot).rejects.toBe(error)
    expect(state.live).toBe(0)
  })

  it("keeps same-file close failure precedence and closes the native handle", async () => {
    const root = await fixture({ "a.txt": "first" })
    const readError = Error("read failure")
    const closeError = Error("close failure")
    state.controls.read = async (path) => {
      if (basename(path) === "a.txt") throw readError
    }
    state.controls.closed = (path) => {
      if (basename(path) === "a.txt") throw closeError
    }
    await expect(snapshotDerivationSource(root)).rejects.toBe(closeError)
    expect(state.live).toBe(0)
  })

  it("reserves the complete DFS total before queueing the ninth file", async () => {
    const root = await fixture(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`a${index}.bin`, "virtual backing"])
      )
    )
    // Controlled native-FS adapter sizes/bytes; original64MiB limit is never changed.
    state.controls.virtualSizes = new Map(
      Array.from({ length: 9 }, (_, index) => [`a${index}.bin`, DERIVATION_LIMITS.fileBytes])
    )
    await expect(snapshotDerivationSource(root)).rejects.toThrow("插件文件大小超限")
    expect(state.opened.map((path) => basename(path))).not.toContain("a8.bin")
    expect(state.allocated).toBeLessThanOrEqual(DERIVATION_LIMITS.totalBytes)
    expect(state.live).toBe(0)
  })

  it("rejects an overlarge file before opening or allocating it", async () => {
    const root = await fixture({ "a.bin": "virtual backing" })
    state.controls.virtualSizes = new Map([["a.bin", DERIVATION_LIMITS.fileBytes + 1]])
    await expect(snapshotDerivationSource(root)).rejects.toThrow("插件文件大小超限")
    expect(state.opened).toEqual([])
    expect(state.allocated).toBe(0)
  })

  it("counts excluded entries toward the original4096 visited-entry ceiling", async () => {
    const root = await fixture()
    const template = (await readdir(root, { withFileTypes: true }))[0]
    const virtual = {
      root: await realpath(root),
      entries: 4096,
      template,
      stat: await lstat(join(root, "plugin.json"))
    }
    state.controls.metadataOnly = virtual
    await expect(snapshotDerivationSource(root)).rejects.toThrow("未找到完整插件清单")
    virtual.entries = 4097
    await expect(snapshotDerivationSource(root)).rejects.toThrow("插件文件数超限")
    expect(state.opened).toEqual([])
    expect(state.allocated).toBe(0)
  })

  it("retains the original24-level directory boundary before content opens", async () => {
    const root = await fixture({
      [`${Array.from({ length: 25 }, () => "d").join("/")}/file.txt`]: "content"
    })
    await expect(snapshotDerivationSource(root)).rejects.toThrow("插件目录层级超限")
    expect(state.opened).toEqual([])
  })

  it.each([
    ["inode", (stat: Stats) => changed(stat, { ino: stat.ino === 0 ? 1 : 0 })],
    ["device", (stat: Stats) => changed(stat, { dev: stat.dev + 1 })],
    ["size", (stat: Stats) => changed(stat, { size: stat.size + 1 })],
    ["hardlink", (stat: Stats) => changed(stat, { nlink: 2 })]
  ] as const)(
    "rejects changed before-read %s and releases every handle",
    async (_name, transform) => {
      const root = await fixture({ "a.txt": "first" })
      const original = await lstat(join(root, "a.txt"))
      const mutated = transform(original)
      expect([mutated.ino, mutated.dev, mutated.size, mutated.nlink]).not.toEqual([
        original.ino,
        original.dev,
        original.size,
        original.nlink
      ])
      state.controls.stat = (path, stat, count) =>
        basename(path) === "a.txt" && count === 1 ? transform(stat) : stat
      await expect(snapshotDerivationSource(root)).rejects.toThrow("来源已变化")
      expect(state.live).toBe(0)
    }
  )

  it.each([
    ["size", (stat: Stats) => changed(stat, { size: stat.size + 1 })],
    ["mtime", (stat: Stats) => changed(stat, { mtimeMs: stat.mtimeMs + 1 })]
  ] as const)(
    "rejects changed after-read %s and releases every handle",
    async (_name, transform) => {
      const root = await fixture({ "a.txt": "first" })
      state.controls.stat = (path, stat, count) =>
        basename(path) === "a.txt" && count === 2 ? transform(stat) : stat
      await expect(snapshotDerivationSource(root)).rejects.toThrow("来源已变化")
      expect(state.live).toBe(0)
    }
  )

  it("rejects premature EOF after opening and closes the actual handle", async () => {
    const root = await fixture({ "a.txt": "first" })
    state.controls.eof = true
    await expect(snapshotDerivationSource(root)).rejects.toThrow("来源已变化")
    expect(state.live).toBe(0)
  })

  it("checks the current pathname after reading and observes final root replacement", async () => {
    const root = await fixture({ "a.txt": "first" })
    let currentCalls = 0
    state.controls.lstat = (path, stat) => {
      if (basename(path) === "a.txt" && ++currentCalls === 2)
        return changed(stat, { isSymbolicLink: () => true })
      return stat
    }
    await expect(snapshotDerivationSource(root)).rejects.toThrow("来源已变化")
    expect(state.live).toBe(0)
    state.controls = {}
    let rootCalls = 0
    state.controls.realpath = (path, actual) =>
      path === root && ++rootCalls === 2 ? `${actual}-replaced` : actual
    await expect(snapshotDerivationSource(root)).rejects.toThrow("来源已变化")
    expect(state.live).toBe(0)
  })

  it("rejects a physical hardlink and a link-valued excluded name without opening either", async () => {
    const root = await fixture({ "a.txt": "first" })
    await link(join(root, "a.txt"), join(root, "b.txt"))
    await expect(snapshotDerivationSource(root)).rejects.toThrow("链接或硬链接")
    expect(state.opened).toEqual([])
    const other = await fixture({ ".env": "excluded fixture value" })
    state.controls.lstat = (path, stat) =>
      basename(path) === ".env" ? changed(stat, { isSymbolicLink: () => true }) : stat
    await expect(snapshotDerivationSource(other)).rejects.toThrow("链接或硬链接")
    expect(state.opened).toEqual([])
  })
})
