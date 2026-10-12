import { afterEach, expect, it, vi } from "vitest"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotDomainError } from "../../shared/bot-types"
import { BotHost, type BotRuntimePort } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotStore } from "./store"
import { BotTransportClient } from "./transport-client"
import { OwnedShellReceiptSlot } from "./owned-shell-receipts"
import {
  inspectBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner,
  type BotOwnedShellMaintenanceReview
} from "./owned-shell-maintenance-fence"
import { requestBotHostUpgrade } from "./host-upgrade"

const cleanup: (() => void | Promise<unknown>)[] = []
const gates: (() => void)[] = []
afterEach(async () => {
  for (const release of gates.splice(0)) release()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Restart lifecycle did not settle")
    await delay(10)
  }
}
function readerGate() {
  const entered = gate<AbortSignal>(),
    released = gate<void>()
  gates.push(() => released.resolve())
  return {
    entered,
    release: () => released.resolve(),
    read: async (signal: AbortSignal, read: () => Promise<BotOwnedShellMaintenanceReview>) => {
      entered.resolve(signal)
      // Intentionally let the read finish late. Cancellation is not an I/O
      // completion guarantee; Host must retire its exact provisional attempt.
      await released.promise
      return read()
    }
  }
}

async function fixture(
  options: {
    runtime?: BotRuntimePort
    missingReader?: boolean
    beforeOwnership?: () => Promise<void>
    reader?: (
      signal: AbortSignal,
      read: () => Promise<BotOwnedShellMaintenanceReview>
    ) => Promise<BotOwnedShellMaintenanceReview>
  } = {}
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-rpc-owned-restart-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanup.push(() => store.close())
  const lock = BotHostLock.acquire(root)!
  expect(lock).not.toBeNull()
  cleanup.push(() => lock.release())
  const host = new BotHost(store, options.runtime ?? { execute: async () => "done" })
  cleanup.push(() => host.stop())
  host.bindOwnership({
    assertCurrent: () => lock.assertCurrent(),
    checkCurrent: async () => {
      await options.beforeOwnership?.()
      await lock.checkCurrent()
    }
  })
  const reader = vi.fn(async (signal: AbortSignal) => {
    const read = () =>
      inspectBotOwnedShellMaintenance(root, ownedShellMaintenanceOwner(lock), signal)
    return options.reader ? options.reader(signal, read) : read()
  })
  if (!options.missingReader) host.bindIdleRestartPreflight(reader)
  const token = randomBytes(32).toString("hex")
  const socketPath =
    process.platform === "win32" ? `\\\\.\\pipe\\cmb-restart-${token}` : join(root, "s.sock")
  let restarts = 0
  const server = new BotRpcServer(host, token, async () => {
    restarts++
  })
  await server.listen(socketPath)
  cleanup.push(() => server.close())
  const descriptor = { version: 1, pid: process.pid, hostId: host.id, token, socketPath }
  lock.publish(descriptor)
  const connect = () => {
    const client = new BotTransportClient(descriptor)
    cleanup.push(() => client.close())
    return client
  }
  const client = connect()
  await client.call("status")
  return { root, store, lock, host, server, client, reader, connect, restarts: () => restarts }
}

async function weakReceipt(f: Awaited<ReturnType<typeof fixture>>) {
  const resources = join(f.root, "shell-resources")
  await mkdir(resources, { mode: 0o700, recursive: true })
  const slot = await OwnedShellReceiptSlot.allocate(resources, {
    nonce: randomUUID(),
    hostId: f.host.id,
    dataEpoch: f.store.dataEpoch(),
    runId: randomUUID(),
    policySha256: "a".repeat(64),
    helperSha256: "b".repeat(64),
    workerSha256: "c".repeat(64),
    containment: "controlled-inherited-group"
  })
  await slot.ready(100, 101)
  await slot.authorizeRun()
  await slot.settle(false)
  return join(slot.directory, "owner.json")
}

it.each(["weak", "invalid"])(
  "keeps the same real lock-owning Host and authenticated snapshot after %s resource rejection",
  async (kind) => {
    const f = await fixture()
    const path = await weakReceipt(f)
    if (kind === "invalid") await writeFile(path, "{invalid", { mode: 0o600 })
    const before = createHash("sha256")
      .update(await readFile(path))
      .digest("hex")
    const descriptor = await readFile(join(f.root, "host.json"))
    expect(await f.client.restartIfIdle(f.host.id)).toMatchObject({
      accepted: false,
      reason: expect.stringContaining(kind === "weak" ? "尚未确认停止" : "现场记录需要核对")
    })
    expect(f.reader).toHaveBeenCalledOnce()
    expect(f.restarts()).toBe(0)
    expect((await f.client.call("status")).hostId).toBe(f.host.id)
    expect((await f.client.call("status")).runtimeReady).toBe(true)
    expect((await f.client.call("snapshot")).bots).toEqual([])
    expect(await readFile(join(f.root, "host.json"))).toEqual(descriptor)
    expect(BotHostLock.acquire(f.root)).toBeNull()
    expect(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
    ).toBe(before)
  }
)

it("denies an owned Host missing its resource reader without provisional fencing", async () => {
  const f = await fixture({ missingReader: true })
  await expect(f.client.restartIfIdle(f.host.id)).rejects.toMatchObject({
    code: "restart_unavailable"
  })
  expect(f.reader).not.toHaveBeenCalled()
  expect((await f.client.call("status")).runtimeReady).toBe(true)
  expect((await f.client.call("snapshot")).bots).toEqual([])
  expect(f.restarts()).toBe(0)
})

it("preserves stale Host rejection before resource admission", async () => {
  const f = await fixture()
  await expect(f.client.restartIfIdle("another-host")).rejects.toThrow("身份已变化")
  expect(f.reader).not.toHaveBeenCalled()
  expect((await f.client.call("status")).runtimeReady).toBe(true)
  expect(f.restarts()).toBe(0)
})

it("preserves active executor denial without entering provisional RPC admission", async () => {
  const running = gate<void>(),
    ended = gate<string>()
  gates.push(() => ended.resolve("done"))
  const f = await fixture({
    runtime: {
      execute: async () => {
        running.resolve()
        return ended.promise
      }
    }
  })
  const bot = f.store.createBot({ nonce: "active-bot", name: "Active" })
  f.store.send({ nonce: "active", conversationId: bot.conversationId, text: "active" })
  f.host.start()
  await running.promise
  expect(await f.client.restartIfIdle(f.host.id)).toMatchObject({
    accepted: false,
    reason: expect.stringContaining("任务执行")
  })
  expect(f.reader).not.toHaveBeenCalled()
  expect((await f.client.call("status")).runtimeReady).toBe(true)
  expect((await f.client.call("snapshot")).bots.map((value) => value.id)).toContain(bot.bot.id)
  expect(f.restarts()).toBe(0)
  ended.resolve("done")
})

it("pauses original scheduling and RPCs, then restores only an originally started Host on a blocked read", async () => {
  const held = readerGate(),
    execute = vi.fn(async () => "done")
  const f = await fixture({ reader: held.read, runtime: { execute } })
  await weakReceipt(f)
  const bot = f.store.createBot({ nonce: "queued-bot", name: "Queued" })
  f.host.start()
  const pending = f.client.restartIfIdle(f.host.id)
  await held.entered.promise
  const queued = f.store.send({
    nonce: "queued-during-read",
    conversationId: bot.conversationId,
    text: "queue"
  })
  f.host.tick()
  expect(execute).not.toHaveBeenCalled()
  expect(f.store.getRun(queued.runIds[0]).status).toBe("queued")
  await expect(f.client.call("snapshot")).rejects.toMatchObject({ code: "host_restarting" })
  expect(() => f.host.start()).toThrow("正在核验")
  held.release()
  expect(await pending).toMatchObject({ accepted: false })
  expect((await f.client.call("status")).runtimeReady).toBe(true)
  await until(() => f.store.getRun(queued.runIds[0]).status === "succeeded")
  expect(execute).toHaveBeenCalledOnce()
  expect(f.restarts()).toBe(0)
})

it("does not start or tick an embedded scheduling state when its owned reader denies restart", async () => {
  const execute = vi.fn(async () => "done"),
    f = await fixture({ runtime: { execute } })
  await weakReceipt(f)
  const bot = f.store.createBot({ nonce: "unstarted-bot", name: "Unstarted" })
  const queued = f.store.send({
    nonce: "unstarted-queue",
    conversationId: bot.conversationId,
    text: "queue"
  })
  const tick = vi.spyOn(f.host, "tick")
  expect(await f.client.restartIfIdle(f.host.id)).toMatchObject({ accepted: false })
  await delay(1100)
  expect(tick).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
  expect(f.store.getRun(queued.runIds[0]).status).toBe("queued")
  expect((await f.client.call("snapshot")).bots.map((value) => value.id)).toContain(bot.bot.id)
  expect(f.restarts()).toBe(0)
})

it("restores its still-current Host after a reader error without accepting exit", async () => {
  const f = await fixture({
    reader: async () => {
      throw new BotDomainError("resource_read_failed", "reader failed")
    }
  })
  await expect(f.client.restartIfIdle(f.host.id)).rejects.toMatchObject({
    code: "resource_read_failed"
  })
  expect((await f.client.call("status")).runtimeReady).toBe(true)
  expect((await f.client.call("snapshot")).bots).toEqual([])
  expect(f.restarts()).toBe(0)
})

it("cannot restore an attempt retired by actual Host.stop when its reader completes late", async () => {
  const held = readerGate(),
    f = await fixture({ reader: held.read })
  f.host.start()
  const pending = f.client.restartIfIdle(f.host.id).catch((error: unknown) => error)
  const signal = await held.entered.promise
  await f.host.stop()
  expect(signal.aborted).toBe(true)
  held.release()
  expect(await pending).toMatchObject({ code: "host_stopping" })
  expect(f.host.ready).toBe(false)
  await expect(f.client.call("status")).rejects.toMatchObject({ code: "host_restarting" })
  await expect(
    f.client.call("create", { nonce: "stopped-admission", name: "Must not dispatch" })
  ).rejects.toMatchObject({ code: "host_restarting" })
  expect(f.store.listBots()).toEqual([])
  expect(f.restarts()).toBe(0)
})

it("cannot restore or accept after the original lifetime lock inode is replaced", async () => {
  const held = readerGate(),
    f = await fixture({ reader: held.read })
  f.host.start()
  const pending = f.client.restartIfIdle(f.host.id).catch((error: unknown) => error)
  await held.entered.promise
  await rename(join(f.root, "host-lock.sqlite"), join(f.root, "retired-host-lock.sqlite"))
  await writeFile(join(f.root, "host-lock.sqlite"), "", { mode: 0o600 })
  held.release()
  expect(await pending).toMatchObject({ code: "host_ownership_lost" })
  expect(f.host.ready).toBe(false)
  expect(() => f.host.start()).toThrow("后台锁已丢失")
  await expect(f.client.call("snapshot")).rejects.toMatchObject({ code: "host_ownership_lost" })
  expect(f.restarts()).toBe(0)
})

it("joins server.close without reviving the Host or scheduling a late accepted ACK", async () => {
  const held = readerGate(),
    f = await fixture({ reader: held.read })
  f.host.start()
  const pending = f.client.restartIfIdle(f.host.id).catch((error: unknown) => error)
  const signal = await held.entered.promise
  let closed = false
  const closing = f.server.close().then(() => {
    closed = true
  })
  expect(signal.aborted).toBe(true)
  await delay(20)
  expect(closed).toBe(false)
  held.release()
  await closing
  expect(await pending).toMatchObject({ code: "host_disconnected" })
  expect(f.host.ready).toBe(false)
  expect(() => f.host.start()).toThrow("正在核验")
  expect(f.restarts()).toBe(0)
})

it("rolls back a disconnected uncommitted client but never replays its restart", async () => {
  const held = readerGate(),
    f = await fixture({ reader: held.read })
  const pending = f.client.restartIfIdle(f.host.id).catch((error: unknown) => error)
  const signal = await held.entered.promise
  await f.client.closeAndWait()
  await until(() => signal.aborted)
  held.release()
  expect(await pending).toMatchObject({ code: "host_disconnected" })
  const observer = f.connect()
  await until(() => f.host.ready)
  expect((await observer.call("status")).hostId).toBe(f.host.id)
  expect((await observer.call("snapshot")).bots).toEqual([])
  await delay(1100)
  expect(f.restarts()).toBe(0)
})

it("counts two requests awaiting ownership and never commits two restart attempts", async () => {
  const ownership = gate<void>()
  gates.push(() => ownership.resolve())
  let paused = false
  const f = await fixture({
    beforeOwnership: async () => {
      if (paused) await ownership.promise
    }
  })
  const other = f.connect()
  await other.call("status")
  const checks = vi.spyOn(f.host, "checkOwnership")
  paused = true
  const first = f.client.restartIfIdle(f.host.id),
    second = other.restartIfIdle(f.host.id)
  await until(() => checks.mock.calls.length === 2)
  ownership.resolve()
  const results = await Promise.all([first, second])
  const accepted = results.filter((result) => result.accepted).length
  expect(accepted).toBeLessThanOrEqual(1)
  expect(f.reader.mock.calls.length).toBe(accepted)
  if (accepted) await until(() => f.restarts() === 1)
  else expect((await f.client.call("snapshot")).bots).toEqual([])
  expect(f.restarts()).toBe(accepted)
})

it("keeps the original committed restart fallback after its client loses the ACK", async () => {
  const f = await fixture()
  const original = f.host.prepareOwnedIdleRestart.bind(f.host)
  vi.spyOn(f.host, "prepareOwnedIdleRestart").mockImplementationOnce(async (...args) => {
    const result = await original(...args)
    // Drop only the response delivery boundary, after actual held-resource commit.
    f.client.close()
    return result
  })
  await expect(f.client.restartIfIdle(f.host.id)).rejects.toMatchObject({
    code: "host_disconnected"
  })
  await until(() => f.restarts() === 1)
  expect(f.host.ready).toBe(false)
  await delay(1100)
  expect(f.restarts()).toBe(1)
})

it.each(["weak", "reader-error"])(
  "keeps an existing older-build client usable after Main upgrade negative preflight: %s",
  async (kind) => {
    const f = await fixture()
    if (kind === "weak") await weakReceipt(f)
    const status = await f.client.call("status")
    const restart = vi.fn((hostId: string) => f.client.restartIfIdle(hostId))
    expect(
      await requestBotHostUpgrade(f.client, status, "next-build", {
        negativePreflight: async () => {
          if (kind === "reader-error") throw new Error("filesystem unavailable")
          const review = await inspectBotOwnedShellMaintenance(
            f.root,
            ownedShellMaintenanceOwner(f.lock)
          )
          return review.state === "requires_review" ? `${review.title}：${review.hint}` : null
        },
        restartIfIdle: restart
      })
    ).toBe(false)
    expect(restart).not.toHaveBeenCalled()
    expect(f.reader).not.toHaveBeenCalled()
    expect(f.client.upgradePending).toContain("有待更新")
    expect((await f.client.call("snapshot")).bots).toEqual([])
    await expect(
      f.client.call("create", { nonce: "denied-new-bot", name: "New" })
    ).rejects.toMatchObject({ code: "host_upgrade_pending" })
    expect(f.restarts()).toBe(0)
  }
)

it("does not add negative preflight to same-build and legacy upgrade predicates", async () => {
  const f = await fixture(),
    status = await f.client.call("status")
  const ports = { negativePreflight: vi.fn(async () => null), restartIfIdle: vi.fn() }
  expect(await requestBotHostUpgrade(f.client, status, status.buildId, ports)).toBe(false)
  expect(
    await requestBotHostUpgrade(f.client, { ...status, buildId: undefined }, "next-build", ports)
  ).toBe(false)
  expect(ports.negativePreflight).not.toHaveBeenCalled()
  expect(ports.restartIfIdle).not.toHaveBeenCalled()
  expect(f.restarts()).toBe(0)
})
