import { createHash, randomBytes } from "node:crypto"
import * as fileSystem from "node:fs/promises"
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as stableFiles from "../services/stable-file-handle"
import { BotArtifacts } from "./artifacts"
import { BotHost } from "./host"
import { BotRpcServer } from "./rpc"
import { BotStore } from "./store"
import { BotTransportClient } from "./transport-client"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open) }
})

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-file-drain-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const directory = join(root, "objects"),
    files = new BotArtifacts(directory, store)
  cleanup.push(() => files.close().catch(() => {}))
  const { conversationId } = store.createBot({ nonce: "bot", name: "Files" })
  await files.recover()
  const bytes = Buffer.from("durable publication at shutdown"),
    hash = createHash("sha256").update(bytes).digest("hex"),
    input = { id: "file", conversationId, runId: null, name: "proof.txt", mime: "text/plain" },
    upload = {
      nonce: input.id,
      conversationId,
      name: input.name,
      mime: input.mime,
      base64: bytes.toString("base64")
    }
  return { root, directory, store, files, bytes, hash, input, upload }
}
function holdReady(files: BotArtifacts) {
  const target = files as unknown as { ready(): Promise<void> },
    ready = target.ready.bind(files),
    entered = deferred(),
    release = deferred()
  vi.spyOn(target, "ready").mockImplementation(async () => {
    await ready()
    entered.resolve()
    await release.promise
  })
  return { entered: entered.promise, release: release.resolve }
}

it.each(["buffer", "stream", "upload", "remove", "recover"] as const)(
  "drains an accepted %s operation that has not reached its mutation queue",
  async (kind) => {
    const f = await fixture(),
      source = join(f.directory, "source.part")
    await writeFile(source, f.bytes)
    if (kind === "remove") await f.files.publish(f.input, f.bytes)
    const hold = holdReady(f.files)
    const operation =
      kind === "buffer"
        ? f.files.publish(f.input, f.bytes)
        : kind === "stream"
          ? f.files.publishFromFile(f.input, source, f.bytes.length, f.hash)
          : kind === "upload"
            ? f.files.upload(f.upload)
            : kind === "recover"
              ? f.files.recover()
              : f.files.remove({
                  nonce: "delete",
                  conversationId: f.input.conversationId,
                  id: f.input.id,
                  sha256: f.hash
                })
    await hold.entered
    let closed = false
    const closing = f.files.close().then(() => (closed = true))
    try {
      await turn()
      expect(closed).toBe(false)
    } finally {
      hold.release()
      await Promise.allSettled([operation, closing])
    }
    await operation
    expect(closed).toBe(true)
    if (kind !== "recover" && kind !== "remove") {
      expect(f.store.getArtifact(f.input.id).sha256).toBe(f.hash)
      expect(await readFile(join(f.directory, f.hash))).toEqual(f.bytes)
    }
    if (kind === "remove") expect(() => f.store.getArtifact(f.input.id)).toThrow("文件已删除")
    expect((await readdir(f.directory)).filter((name) => name.startsWith("pending-"))).toEqual([])
  }
)

it.each(["read", "chunk"] as const)(
  "keeps accepted %s file handles alive until completion",
  async (kind) => {
    const f = await fixture()
    await f.files.publish(f.input, f.bytes)
    const entered = deferred(),
      release = deferred(),
      open = stableFiles.openStableFileHandle
    let handle: stableFiles.StableFileHandle | undefined
    vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (...args) => {
      handle = await open(...args)
      entered.resolve()
      await release.promise
      return handle
    })
    const operation =
      kind === "read" ? f.files.read(f.input.id) : f.files.chunk({ id: f.input.id, offset: 0 })
    await entered.promise
    const closeHandle = vi.spyOn(handle!.handle, "close")
    let closed = false
    const closing = f.files.close().then(() => (closed = true))
    try {
      await turn()
      expect(closed).toBe(false)
      expect(closeHandle).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await Promise.allSettled([operation, closing])
    }
    await operation
    expect(closeHandle).toHaveBeenCalledOnce()
    expect(closed).toBe(true)
  }
)

it("reopens an immutable artifact once after a transient stable-read observation", async () => {
  const f = await fixture()
  await f.files.publish(f.input, f.bytes)
  const stableRead = stableFiles.readStableFileHandleBounded
  const read = vi
    .spyOn(stableFiles, "readStableFileHandleBounded")
    .mockImplementationOnce(async () => {
      throw new stableFiles.StableBoundedReadError("changed", 0)
    })
    .mockImplementation(stableRead)

  await expect(f.files.read(f.input.id)).resolves.toMatchObject({ bytes: f.bytes })
  expect(read).toHaveBeenCalledTimes(2)
})

it("reports an immutable artifact as corrupt after its one stable-read retry", async () => {
  const f = await fixture()
  await f.files.publish(f.input, f.bytes)
  const read = vi.spyOn(stableFiles, "readStableFileHandleBounded").mockImplementation(async () => {
    throw new stableFiles.StableBoundedReadError("changed", 0)
  })

  await expect(f.files.read(f.input.id)).rejects.toMatchObject({ code: "artifact_corrupt" })
  expect(read).toHaveBeenCalledTimes(2)
})

it.each(["read", "chunk"] as const)(
  "reports a referenced but missing immutable object as corrupt when %sing it",
  async (kind) => {
    const f = await fixture()
    await f.files.publish(f.input, f.bytes)
    await unlink(join(f.directory, f.hash))

    const result =
      kind === "read" ? f.files.read(f.input.id) : f.files.chunk({ id: f.input.id, offset: 0 })
    await expect(result).rejects.toMatchObject({ code: "artifact_corrupt" })
  }
)

it("flushes a renamed immutable object directory before publishing its ready record", async () => {
  if (process.platform === "win32") return
  const f = await fixture(),
    open = fileSystem.open
  let directorySynced = false
  vi.spyOn(fileSystem, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === f.directory && args[1] === "r") {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        directorySynced = true
        await sync()
      })
    }
    return handle
  })
  const publish = f.store.publishArtifact.bind(f.store)
  vi.spyOn(f.store, "publishArtifact").mockImplementation((...args) => {
    expect(directorySynced).toBe(true)
    return publish(...args)
  })

  await f.files.publish(f.input, f.bytes)
})

it("rejects a chunk if its immutable object changes before final confirmation", async () => {
  const f = await fixture()
  await f.files.publish(f.input, f.bytes)
  const stableOpen = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (...args) => {
    const file = await stableOpen(...args)
    if (String(args[1]) === join(f.directory, f.hash)) {
      const stat = file.handle.stat.bind(file.handle)
      let changed = false
      vi.spyOn(file.handle, "stat").mockImplementation(async (...statArgs) => {
        if (!changed) {
          changed = true
          await fileSystem.writeFile(join(f.directory, f.hash), Buffer.alloc(f.bytes.length, 65))
        }
        return stat(...statArgs)
      })
    }
    return file
  })

  await expect(f.files.chunk({ id: f.input.id, offset: 0 })).rejects.toMatchObject({
    code: "artifact_corrupt"
  })
})

it("shares one shutdown promise and rejects new external operations while draining", async () => {
  const f = await fixture()
  const hold = holdReady(f.files),
    accepted = f.files.publish(f.input, f.bytes)
  await hold.entered
  const closing = f.files.close()
  try {
    expect(f.files.close()).toBe(closing)
    const attempted = [
      f.files.publish(f.input, f.bytes),
      f.files.upload(f.upload),
      f.files.publishFromFile(f.input, "unused", f.bytes.length, f.hash),
      f.files.remove({
        nonce: "delete",
        conversationId: f.input.conversationId,
        id: f.input.id,
        sha256: f.hash
      }),
      f.files.read(f.input.id),
      f.files.chunk({ id: f.input.id, offset: 0 }),
      f.files.recover(),
      f.files.transfers.finish(f.input.id)
    ]
    const results = await Promise.allSettled(attempted)
    expect(results).toHaveLength(8)
    for (const result of results)
      expect(result).toMatchObject({ status: "rejected", reason: { message: "文件服务正在关闭" } })
  } finally {
    hold.release()
    await Promise.allSettled([accepted, closing])
  }
  await accepted
})

it("allows an accepted queued transfer finish to publish internally during shutdown", async () => {
  const f = await fixture()
  await f.files.transfers.begin({ ...f.upload, size: f.bytes.length, sha256: f.hash })
  await f.files.transfers.chunk({ id: f.input.id, offset: 0, base64: f.upload.base64 })
  const entered = deferred(),
    release = deferred(),
    open = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[1].endsWith(".json")) {
      entered.resolve()
      await release.promise
    }
    return handle
  })
  const accepted = f.files.transfers.finish(f.input.id)
  await entered.promise
  let closed = false
  const closing = f.files.close().then(() => (closed = true))
  try {
    await turn()
    expect(closed).toBe(false)
    await expect(
      f.files.publishFromFile(f.input, "unused", f.bytes.length, f.hash)
    ).rejects.toThrow("正在关闭")
  } finally {
    release.resolve()
    await Promise.allSettled([accepted, closing])
  }
  expect((await accepted).sha256).toBe(f.hash)
  expect(f.store.getArtifact(f.input.id).sha256).toBe(f.hash)
  expect(await readFile(join(f.directory, f.hash))).toEqual(f.bytes)
  expect(await readdir(join(f.directory, "uploads"))).toEqual([])
})

it("drains accepted work before surfacing a child shutdown failure", async () => {
  const f = await fixture(),
    hold = holdReady(f.files),
    accepted = f.files.publish(f.input, f.bytes)
  await hold.entered
  const error = new Error("child cleanup failed")
  vi.spyOn(f.files.transfers, "close").mockRejectedValue(error)
  let closed = false
  const closing = f.files.close()
  void closing.then(
    () => (closed = true),
    () => (closed = true)
  )
  try {
    await turn()
    expect(closed).toBe(false)
  } finally {
    hold.release()
    await Promise.allSettled([accepted, closing])
  }
  await expect(closing).rejects.toBe(error)
  await accepted
  // The shared shutdown result remains the original error on subsequent calls.
  await expect(f.files.close()).rejects.toBe(error)
})

it("drains and removes temporary bytes when an accepted publication fails during fsync", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred(),
    open = fileSystem.open,
    failure = new Error("fsync failed")
  let closedHandle = false
  vi.spyOn(fileSystem, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]).includes("pending-")) {
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        entered.resolve()
        await release.promise
        throw failure
      })
      const close = handle.close.bind(handle)
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close()
        closedHandle = true
      })
    }
    return handle
  })
  const commit = vi.spyOn(f.store, "publishArtifact"),
    accepted = f.files.publish(f.input, f.bytes)
  await entered.promise
  let closed = false
  const closing = f.files.close().then(() => (closed = true))
  try {
    await turn()
    expect(closed).toBe(false)
    expect(closedHandle).toBe(false)
  } finally {
    release.resolve()
    await Promise.allSettled([accepted, closing])
  }
  await expect(accepted).rejects.toBe(failure)
  expect(closedHandle).toBe(true)
  expect(commit).not.toHaveBeenCalled()
  expect((await readdir(f.directory)).filter((name) => name.startsWith("pending-"))).toEqual([])
})

it("drains a dispatched authenticated socket upload before the Host closes its database", async () => {
  const f = await fixture(),
    host = new BotHost(f.store, undefined, 4, undefined, f.files),
    token = randomBytes(32).toString("hex"),
    socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\bot-file-${token.slice(0, 16)}`
        : join(f.root, "h.sock"),
    server = new BotRpcServer(host, token)
  await server.listen(socketPath)
  cleanup.push(() => server.close())
  const client = new BotTransportClient({
    version: 1,
    pid: process.pid,
    hostId: host.id,
    token,
    socketPath
  })
  cleanup.push(() => client.close())
  const hold = holdReady(f.files),
    upload = f.files.upload.bind(f.files)
  let accepted: ReturnType<BotArtifacts["upload"]> | undefined
  vi.spyOn(f.files, "upload").mockImplementation((...args) => (accepted = upload(...args)))
  // The client correctly rejects when its socket closes. Independently observe
  // the already dispatched server-side operation that still owns I/O and DB work.
  const response = client.call("upload", f.upload).catch(() => undefined)
  let serverClosed = false,
    closed = false
  let serverClosing: Promise<void> | undefined,
    stopping: Promise<void> | undefined,
    closing: Promise<void> | undefined
  try {
    await hold.entered
    serverClosing = server.close().then(() => {
      serverClosed = true
    })
    stopping = host.stop()
    closing = f.files.close().then(() => {
      closed = true
    })
    await turn()
    expect(serverClosed).toBe(false)
    expect(closed).toBe(false)
  } finally {
    hold.release()
    await Promise.allSettled([accepted, serverClosing, stopping, closing, response])
  }
  await Promise.all([serverClosing, stopping, closing])
  expect(serverClosed).toBe(true)
  expect(closed).toBe(true)
  expect((await accepted)!.sha256).toBe(f.hash)
  expect(f.store.artifacts(f.input.conversationId)).toHaveLength(1)
  expect(await readFile(join(f.directory, f.hash))).toEqual(f.bytes)
})
