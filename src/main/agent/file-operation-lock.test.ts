import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { withFileOperation, withWorkspaceExecution } from "./file-operation-lock"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-resource-lock-"))
  roots.push(root)
  return root
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("shared file resources", () => {
  it("coordinates new files reached through a dangling directory link", async () => {
    const root = await fixture()
    const target = join(root, "missing")
    const alias = join(root, "alias")
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
    const entered = deferred()
    const release = deferred()
    const queued = deferred()
    const controller = new AbortController()
    const original = controller.signal.addEventListener.bind(controller.signal)
    vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
      original(...args)
      if (args[0] === "abort") queued.resolve()
    })
    const holder = withFileOperation(root, join(target, "new"), "write", async () => {
      entered.resolve()
      await release.promise
      await mkdir(target)
      await writeFile(join(target, "new"), "created")
    })
    await entered.promise
    const handler = vi.fn(async () => undefined)
    const pending = withFileOperation(root, join(alias, "new"), "write", handler, controller.signal)
    try {
      await queued.promise
      expect(handler).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await Promise.all([holder, pending])
    }
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it.each(["read", "write"] as const)("coordinates hard-link %s aliases", async (access) => {
    const root = await fixture()
    const file = join(root, "a")
    const alias = join(root, "alias")
    await writeFile(file, "initial")
    await link(file, alias)
    const entered = deferred()
    const release = deferred()
    const queued = deferred()
    const controller = new AbortController()
    const original = controller.signal.addEventListener.bind(controller.signal)
    vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
      original(...args)
      if (args[0] === "abort") queued.resolve()
    })
    const holder = withFileOperation(root, file, "write", async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const handler = vi.fn(async () => undefined)
    const pending = withFileOperation(root, alias, access, handler, controller.signal)
    try {
      await queued.promise
      expect(handler).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await Promise.all([holder, pending])
    }
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("rejects a queued path whose alias now points to a different file", async () => {
    const root = await fixture()
    const real = join(root, "real")
    const other = join(root, "other")
    const alias = join(root, "alias")
    await Promise.all([mkdir(real), mkdir(other)])
    await Promise.all([writeFile(join(real, "a"), "old"), writeFile(join(other, "a"), "new")])
    await symlink(real, alias, process.platform === "win32" ? "junction" : "dir")
    const entered = deferred()
    const release = deferred()
    const resolvedAlias = deferred()
    const original = fsPromises.realpath
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (target) => {
      const resolved = await original(target)
      if (String(target) === join(alias, "a")) resolvedAlias.resolve()
      return resolved
    })
    const holder = withFileOperation(root, join(real, "a"), "write", async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const handler = vi.fn(async () => undefined)
    const pending = withFileOperation(root, join(alias, "a"), "write", handler)
    const rejected = expect(pending).rejects.toThrow("File path changed")
    await resolvedAlias.promise
    await rm(alias)
    await symlink(other, alias, process.platform === "win32" ? "junction" : "dir")
    release.resolve()
    await Promise.all([holder, rejected])
    expect(handler).not.toHaveBeenCalled()
  })

  it("overlaps different files and same-file readers", async () => {
    const root = await fixture()
    const cases: Array<Array<[string, "read" | "write"]>> = [
      [
        ["a", "write"],
        ["b", "write"]
      ],
      [
        ["a", "read"],
        ["a", "read"]
      ]
    ]
    for (const accesses of cases) {
      const entered = [deferred(), deferred()]
      const release = deferred()
      const jobs = accesses.map(([file, access], i) =>
        withFileOperation(root, join(root, file), access, async () => {
          entered[i].resolve()
          await release.promise
        })
      )
      try {
        await Promise.all(entered.map((item) => item.promise))
      } finally {
        release.resolve()
        await Promise.all(jobs)
      }
    }
  })

  it.each(["read", "write"] as const)("excludes same-file %s while writing", async (access) => {
    const root = await fixture()
    const started = deferred()
    const release = deferred()
    let writing = false
    const writer = withFileOperation(root, join(root, "a"), "write", async () => {
      writing = true
      started.resolve()
      await release.promise
      writing = false
    })
    await started.promise
    const next = withFileOperation(root, join(root, "a"), access, async () => {
      expect(writing).toBe(false)
    })
    await withFileOperation(root, join(root, "b"), "write", async () => undefined)
    release.resolve()
    await Promise.all([writer, next])
  })

  it("protects new files reached through a junction or symlink", async () => {
    const root = await fixture()
    const real = join(root, "real")
    const alias = join(root, "alias")
    await mkdir(real)
    await symlink(real, alias, process.platform === "win32" ? "junction" : "dir")
    const started = deferred()
    const release = deferred()
    let writing = false
    const first = withFileOperation(root, join(real, "nested", "new.txt"), "write", async () => {
      writing = true
      started.resolve()
      await release.promise
      await mkdir(join(real, "nested"))
      await writeFile(join(real, "nested", "new.txt"), "first")
      writing = false
    })
    await started.promise
    const second = withFileOperation(root, join(alias, "nested", "new.txt"), "write", async () => {
      expect(writing).toBe(false)
    })
    await withFileOperation(root, join(root, "unrelated"), "write", async () => undefined)
    release.resolve()
    await Promise.all([first, second])
  })

  it("excludes file operations during an unknown command, but not another workspace", async () => {
    const root = await fixture()
    const other = await fixture()
    const started = deferred()
    const release = deferred()
    let executing = false
    const command = withWorkspaceExecution(root, "write", async () => {
      executing = true
      started.resolve()
      await release.promise
      executing = false
    })
    await started.promise
    const file = withFileOperation(root, join(root, "a"), "write", async () => {
      expect(executing).toBe(false)
    })
    await withFileOperation(other, join(other, "a"), "write", async () => {
      expect(executing).toBe(true)
    })
    release.resolve()
    await Promise.all([command, file])
  })

  it.each(["file", "workspace"])(
    "cancels a queued %s waiter and leaves the holder intact",
    async (kind) => {
      const root = await fixture()
      const started = deferred()
      const release = deferred()
      const controller = new AbortController()
      const run = (fn: () => Promise<void>, signal?: AbortSignal) =>
        kind === "file"
          ? withFileOperation(root, join(root, "a"), "write", fn, signal)
          : withWorkspaceExecution(root, "write", fn, signal)
      const holder = run(async () => {
        started.resolve()
        await release.promise
      })
      await started.promise
      const handler = vi.fn(async () => undefined)
      const enqueued = deferred()
      const addListener = controller.signal.addEventListener.bind(controller.signal)
      vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
        addListener(...args)
        if (args[0] === "abort") enqueued.resolve()
      })
      const pending = run(handler, controller.signal)
      const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" })
      await enqueued.promise
      controller.abort()
      await canceled
      expect(handler).not.toHaveBeenCalled()
      release.resolve()
      await holder
      await run(handler)
      expect(handler).toHaveBeenCalledTimes(1)
    }
  )

  it("releases both levels after failure", async () => {
    const root = await fixture()
    await expect(
      withFileOperation(root, join(root, "a"), "write", async () => {
        throw new Error("failed")
      })
    ).rejects.toThrow("failed")
    await withWorkspaceExecution(root, "write", async () => undefined)
    await withFileOperation(root, join(root, "a"), "write", async () => undefined)
  })

  const modes = ["file-read", "file-write", "scan", "exclusive"] as const
  type Mode = (typeof modes)[number]
  const runMode = (
    root: string,
    mode: Mode,
    file: string,
    fn: () => Promise<void>,
    signal?: AbortSignal
  ) =>
    mode === "file-read" || mode === "file-write"
      ? withFileOperation(
          root,
          join(root, file),
          mode === "file-read" ? "read" : "write",
          fn,
          signal
        )
      : withWorkspaceExecution(root, mode === "scan" ? "read" : "write", fn, signal)

  it.each(modes.flatMap((first) => modes.map((second) => [first, second] as const)))(
    "coordinates workspace modes %s then %s",
    async (first, second) => {
      const root = await fixture()
      const entered = deferred()
      const release = deferred()
      const observed = deferred()
      const controller = new AbortController()
      const compatible =
        first !== "exclusive" &&
        second !== "exclusive" &&
        !([first, second].includes("scan") && [first, second].includes("file-write"))
      const addListener = controller.signal.addEventListener.bind(controller.signal)
      vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
        addListener(...args)
        if (args[0] === "abort") observed.resolve()
      })
      let holding = true
      const holder = runMode(root, first, "a", async () => {
        entered.resolve()
        await release.promise
        holding = false
      })
      await entered.promise
      const handler = vi.fn(async () => {
        expect(holding).toBe(compatible)
        observed.resolve()
      })
      const pending = runMode(root, second, "b", handler, controller.signal)
      try {
        await observed.promise
        expect(handler).toHaveBeenCalledTimes(compatible ? 1 : 0)
      } finally {
        release.resolve()
        await Promise.all([holder, pending])
      }
    }
  )

  it("does not let new writes starve a queued scan, and cancellation unblocks them", async () => {
    const root = await fixture()
    const entered = deferred()
    const release = deferred()
    const scanQueued = deferred()
    const writerQueued = deferred()
    const scanController = new AbortController()
    const writerController = new AbortController()
    for (const [signal, queued] of [
      [scanController.signal, scanQueued],
      [writerController.signal, writerQueued]
    ] as const) {
      const original = signal.addEventListener.bind(signal)
      vi.spyOn(signal, "addEventListener").mockImplementation((...args) => {
        original(...args)
        if (args[0] === "abort") queued.resolve()
      })
    }
    const holder = runMode(root, "file-write", "a", async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const scan = runMode(root, "scan", "a", async () => undefined, scanController.signal)
    const canceled = expect(scan).rejects.toMatchObject({ name: "AbortError" })
    await scanQueued.promise
    const handler = vi.fn(async () => undefined)
    const writer = runMode(root, "file-write", "b", handler, writerController.signal)
    await writerQueued.promise
    expect(handler).not.toHaveBeenCalled()
    scanController.abort()
    await canceled
    await writer
    expect(handler).toHaveBeenCalledTimes(1)
    release.resolve()
    await holder
  })
})
