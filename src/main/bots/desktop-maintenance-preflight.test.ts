import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { randomUUID, createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotHostLock } from "./host-lock"
import { OwnedShellReceiptSlot } from "./owned-shell-receipts"
import {
  assertBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import type { BotHostDescriptor } from "./transport-client"

const f = vi.hoisted(() => ({
  root: "",
  status: vi.fn(),
  restart: vi.fn(),
  spawn: vi.fn(),
  sync: vi.fn(),
  clients: [] as { closed: boolean }[]
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => f.root }))
vi.mock("./desktop-model-sync", () => ({ syncDesktopBotModels: f.sync }))
vi.mock("./host-upgrade", () => ({ requestBotHostUpgrade: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: f.spawn }))
// Only the authenticated transport boundary is controlled. Resource reads,
// receipts and the Host lifetime lock use the real private temporary files.
vi.mock("./transport-client", () => ({
  BotTransportClient: class {
    closed = false
    constructor(readonly descriptor: BotHostDescriptor) {
      f.clients.push(this)
    }
    call(method: string) {
      expect(method).toBe("status")
      return f.status(this.descriptor)
    }
    restartIfIdle(hostId: string) {
      expect(hostId).toBe(this.descriptor.hostId)
      return f.restart(hostId)
    }
    close() {
      this.closed = true
    }
  }
}))

let directory: string
let lock: BotHostLock | undefined
let descriptor: BotHostDescriptor
let exitListeners: ((code: number) => void)[]
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

beforeEach(async () => {
  exitListeners = process.listeners("exit")
  vi.resetModules()
  f.root = await realpath(await mkdtemp(join(tmpdir(), "cmb-maintenance-preflight-")))
  directory = join(f.root, "bot-host")
  await mkdir(directory, { mode: 0o700 })
  descriptor = {
    version: 1,
    pid: process.pid,
    hostId: randomUUID(),
    socketPath: join(directory, "host.sock"),
    token: randomUUID()
  }
  lock = BotHostLock.acquire(directory)!
  expect(lock).not.toBeNull()
  lock.publish(descriptor)
  f.clients.length = 0
  f.status.mockReset().mockImplementation(async (value: BotHostDescriptor) => ({
    hostId: value.hostId
  }))
  f.restart.mockReset().mockImplementation(async () => {
    lock!.release()
    lock = undefined
    return { accepted: true, reason: null }
  })
  f.spawn.mockReset().mockImplementation(() => {
    throw new Error("This fixture must not launch Host")
  })
  f.sync.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  for (const listener of process.listeners("exit")) {
    if (!exitListeners.includes(listener)) {
      process.off("exit", listener)
      listener(0)
    }
  }
  vi.restoreAllMocks()
  lock?.release()
  lock = undefined
  await rm(f.root, { recursive: true, force: true })
})

async function weakReceipt() {
  const resources = join(directory, "shell-resources")
  await mkdir(resources, { mode: 0o700, recursive: true })
  const slot = await OwnedShellReceiptSlot.allocate(resources, {
    nonce: randomUUID(),
    hostId: descriptor.hostId,
    dataEpoch: "initial",
    policySha256: "a".repeat(64),
    runId: randomUUID(),
    helperSha256: "b".repeat(64),
    workerSha256: "c".repeat(64),
    containment: "controlled-inherited-group"
  })
  await slot.ready(100, 101)
  await slot.authorizeRun()
  await slot.settle(false)
  return join(slot.directory, "owner.json")
}

it.each(["maintenance", "restart", "update"])(
  "rejects known weak closure before %s without stopping or replacing the usable Host",
  async (action) => {
    const path = await weakReceipt()
    const before = hash(await readFile(path))
    const api = await import("./desktop-client")
    const original = await api.getDesktopBotClient()
    const operation = vi.fn().mockResolvedValue("unexpected-operation")
    const end = vi.fn()
    const unregister = api.registerDesktopBotMaintenanceParticipant({ drain: vi.fn(), end })
    try {
      const pending =
        action === "restart"
          ? api.restartDesktopBotHost(descriptor.hostId)
          : action === "update"
            ? api.withDesktopBotUpdate(operation)
            : api.withDesktopBotMaintenance(operation)
      await expect(pending).rejects.toMatchObject({
        code: "bot_shell_resource_requires_review",
        definitive: true,
        review: { state: "requires_review", reason: "physical-closure-unproven" }
      })
      expect(f.restart).not.toHaveBeenCalled()
      expect(operation).not.toHaveBeenCalled()
      expect(f.spawn).not.toHaveBeenCalled()
      expect(f.clients[0].closed).toBe(false)
      expect(end).toHaveBeenCalledOnce()
      expect(await api.getDesktopBotClient()).toBe(original)
      expect(BotHostLock.acquire(directory)).toBeNull()
      expect(hash(await readFile(path))).toBe(before)
    } finally {
      unregister()
    }
  }
)

it("rejects invalid resource evidence without stopping the current Host", async () => {
  const path = await weakReceipt()
  await writeFile(path, "{invalid", { mode: 0o600 })
  const api = await import("./desktop-client")
  const original = await api.getDesktopBotClient()
  const operation = vi.fn()
  await expect(api.withDesktopBotMaintenance(operation)).rejects.toMatchObject({
    code: "bot_shell_resource_requires_review",
    review: { reason: "invalid-resource-evidence" }
  })
  expect(f.restart).not.toHaveBeenCalled()
  expect(operation).not.toHaveBeenCalled()
  expect(f.clients[0].closed).toBe(false)
  expect(await api.getDesktopBotClient()).toBe(original)
  expect(await readFile(path, "utf8")).toBe("{invalid")
})

it("propagates a reader failure without treating it as ready or stopping Host", async () => {
  const reader = await import("./desktop-owned-shell-maintenance")
  const failure = new Error("controlled resource reader failure")
  vi.spyOn(reader, "inspectDesktopBotShellResources").mockRejectedValue(failure)
  const api = await import("./desktop-client")
  const original = await api.getDesktopBotClient()
  const operation = vi.fn()
  await expect(api.withDesktopBotMaintenance(operation)).rejects.toBe(failure)
  expect(f.restart).not.toHaveBeenCalled()
  expect(operation).not.toHaveBeenCalled()
  expect(await api.getDesktopBotClient()).toBe(original)
  expect(f.clients[0].closed).toBe(false)
})

it("rejects a stale expected Host before the resource read or restart", async () => {
  const reader = await import("./desktop-owned-shell-maintenance")
  const inspect = vi.spyOn(reader, "inspectDesktopBotShellResources")
  const api = await import("./desktop-client")
  await api.getDesktopBotClient()
  await expect(api.restartDesktopBotHost("stale-host")).rejects.toMatchObject({
    code: "host_changed"
  })
  expect(inspect).not.toHaveBeenCalled()
  expect(f.restart).not.toHaveBeenCalled()
  expect(f.clients[0].closed).toBe(false)
})

it("keeps the original busy admission after a ready observation", async () => {
  const reader = await import("./desktop-owned-shell-maintenance")
  const inspect = vi.spyOn(reader, "inspectDesktopBotShellResources")
  f.restart.mockResolvedValue({ accepted: false, reason: "unfinished original work" })
  const api = await import("./desktop-client")
  const original = await api.getDesktopBotClient()
  const operation = vi.fn()
  await expect(api.withDesktopBotMaintenance(operation)).rejects.toMatchObject({
    code: "host_busy"
  })
  expect(inspect).toHaveBeenCalledOnce()
  expect((await inspect.mock.results[0].value).review.state).toBe("ready")
  expect(f.restart).toHaveBeenCalledExactlyOnceWith(descriptor.hostId)
  expect(operation).not.toHaveBeenCalled()
  expect(f.clients[0].closed).toBe(false)
  expect(await api.getDesktopBotClient()).toBe(original)
})

it("does not authorize offline work from ready when a resource appears during idle handoff", async () => {
  const reader = await import("./desktop-owned-shell-maintenance")
  const inspect = vi.spyOn(reader, "inspectDesktopBotShellResources")
  f.restart.mockImplementation(async () => {
    await weakReceipt()
    lock!.release()
    lock = undefined
    return { accepted: true, reason: null }
  })
  const mutation = vi.fn()
  const operation = vi.fn(async () => {
    const exclusive = BotHostLock.acquire(directory)!
    expect(exclusive).not.toBeNull()
    try {
      await assertBotOwnedShellMaintenance(directory, ownedShellMaintenanceOwner(exclusive))
      mutation()
    } finally {
      exclusive.release()
    }
  })
  const api = await import("./desktop-client")
  await expect(api.withDesktopBotMaintenance(operation)).rejects.toMatchObject({
    code: "bot_shell_resource_requires_review"
  })
  expect(inspect).toHaveBeenCalledOnce()
  expect((await inspect.mock.results[0].value).review.state).toBe("ready")
  expect(f.restart).toHaveBeenCalledExactlyOnceWith(descriptor.hostId)
  expect(operation).toHaveBeenCalledOnce()
  expect(mutation).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
})

it.each(["absent", "unresponsive"])(
  "preserves the %s Host damaged-data route and lets the original offline fence reject",
  async (kind) => {
    await weakReceipt()
    lock!.release()
    lock = undefined
    const damaged = Buffer.from("not a SQLite database")
    await writeFile(join(directory, "bots.sqlite"), damaged, { mode: 0o600 })
    if (kind === "unresponsive") {
      await writeFile(join(directory, "host.json"), JSON.stringify(descriptor), { mode: 0o600 })
      f.status.mockRejectedValue(new Error("controlled disconnected Host"))
    }
    const reader = await import("./desktop-owned-shell-maintenance")
    const inspect = vi.spyOn(reader, "inspectDesktopBotShellResources")
    const mutation = vi.fn()
    const operation = vi.fn(async () => {
      const exclusive = BotHostLock.acquire(directory)!
      expect(exclusive).not.toBeNull()
      try {
        await assertBotOwnedShellMaintenance(directory, ownedShellMaintenanceOwner(exclusive))
        mutation()
      } finally {
        exclusive.release()
      }
    })
    const api = await import("./desktop-client")
    await expect(api.withDesktopBotMaintenance(operation)).rejects.toMatchObject({
      code: "bot_shell_resource_requires_review"
    })
    expect(inspect).not.toHaveBeenCalled()
    expect(f.restart).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.sync).not.toHaveBeenCalled()
    expect(operation).toHaveBeenCalledOnce()
    expect(mutation).not.toHaveBeenCalled()
    expect(await readFile(join(directory, "bots.sqlite"))).toEqual(damaged)
  }
)
