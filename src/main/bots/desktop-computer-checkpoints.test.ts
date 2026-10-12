import { beforeEach, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
const f = vi.hoisted(() => ({
  worker: vi.fn(),
  list: vi.fn(),
  recovery: vi.fn(),
  progress: vi.fn(),
  startup: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn(),
  lstat: vi.fn(),
  read: vi.fn(),
  deliverables: vi.fn(),
  listDeliverables: vi.fn()
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => "/fixture" }))
vi.mock("./desktop-maintenance-worker", () => ({
  runDesktopMaintenanceWorker: f.worker,
  desktopComputerMaintenanceProgress: f.progress
}))
vi.mock("./computer-checkpoint-service", () => ({
  listBotComputerCheckpoints: f.list,
  listBotComputerRecoveryCopies: f.recovery,
  resolveBotComputerDeliverables: f.deliverables,
  listBotComputerDeliverables: f.listDeliverables
}))
vi.mock("./computer-startup-progress", () => ({ readVerifiedComputerStartupProgress: f.startup }))
vi.mock("./backup-io", () => ({ readPrivateJson: f.read }))
vi.mock("node:fs/promises", () => ({ realpath: f.realpath, lstat: f.lstat }))
vi.mock("electron", () => ({ shell: { openPath: f.open } }))
import {
  executeDesktopBotComputerCheckpoint,
  deleteDesktopBotComputerRecoveryCopy,
  revealDesktopBotComputerRecoveryCopy,
  desktopBotComputerProgress,
  revealDesktopBotComputerDeliverables,
  listDesktopBotComputerDeliverables
} from "./desktop-computer-checkpoints"
beforeEach(() => {
  Object.values(f).forEach((mock) => mock.mockReset())
  f.progress.mockReturnValue(null)
  f.realpath.mockImplementation(async (path) => path)
  f.lstat.mockResolvedValue({ isDirectory: () => true })
  f.open.mockResolvedValue("")
})

it("rejects untrusted maintenance requests before starting the worker", async () => {
  for (const input of [
    null,
    { action: "create", nonce: "invalid" },
    {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: { id: randomUUID(), sha256: "a".repeat(64) },
      directory: "/foreign"
    }
  ])
    await expect(executeDesktopBotComputerCheckpoint(input)).rejects.toThrow()
  await expect(
    deleteDesktopBotComputerRecoveryCopy({ id: "../../foreign", sha256: "a".repeat(64) })
  ).rejects.toThrow()
  expect(f.worker).not.toHaveBeenCalled()
})

it("forwards the exact durable request to the shared offline worker", async () => {
  const input = {
    action: "restore" as const,
    nonce: randomUUID(),
    checkpoint: { id: randomUUID(), sha256: "a".repeat(64) }
  }
  f.worker.mockResolvedValue({ action: "restore" })
  await executeDesktopBotComputerCheckpoint(input)
  expect(f.worker).toHaveBeenCalledExactlyOnceWith(
    "bot-computer-checkpoint",
    "/fixture/bot-host",
    input,
    expect.any(Function)
  )
  f.worker.mockClear()
  await deleteDesktopBotComputerRecoveryCopy(input.checkpoint)
  expect(f.worker).toHaveBeenCalledExactlyOnceWith(
    "bot-computer-checkpoint",
    "/fixture/bot-host",
    { action: "delete-recovery", recovery: input.checkpoint },
    expect.any(Function)
  )
})

it("opens only a listed, canonical recovery copy and rejects replacement paths", async () => {
  const id = randomUUID()
  f.recovery.mockResolvedValue([])
  await expect(revealDesktopBotComputerRecoveryCopy(id)).rejects.toThrow("不存在")
  expect(f.open).not.toHaveBeenCalled()
  f.recovery.mockResolvedValue([{ id, sha256: "a".repeat(64) }])
  f.realpath.mockImplementation(async (path) => (path.endsWith(id) ? "/foreign" : path))
  await expect(revealDesktopBotComputerRecoveryCopy(id)).rejects.toThrow("变化")
  expect(f.open).not.toHaveBeenCalled()
  f.realpath.mockImplementation(async (path) => path)
  await revealDesktopBotComputerRecoveryCopy(id)
  expect(f.open).toHaveBeenCalledExactlyOnceWith(
    `/fixture/bot-host/computer-recovery/recovery/${id}`
  )
})

it("opens independent code only through the verified deliverable owner", async () => {
  const id = randomUUID()
  await expect(revealDesktopBotComputerDeliverables("../foreign")).rejects.toThrow()
  expect(f.deliverables).not.toHaveBeenCalled()
  f.deliverables.mockRejectedValueOnce(new Error("恢复成果归属无效"))
  await expect(revealDesktopBotComputerDeliverables(id)).rejects.toThrow("归属无效")
  expect(f.open).not.toHaveBeenCalled()
  const path = `/fixture/bot-host/computer-recovery/deliverables/${id}`
  f.deliverables.mockResolvedValue(path)
  await revealDesktopBotComputerDeliverables(id)
  expect(f.deliverables).toHaveBeenLastCalledWith("/fixture/bot-host", id)
  expect(f.open).toHaveBeenCalledExactlyOnceWith(path)
  expect(f.recovery).not.toHaveBeenCalled()
})

it("lists only bounded, validated code deliverables through their owner", async () => {
  const item = {
    id: randomUUID(),
    checkpoint: { id: randomUUID(), sha256: "a".repeat(64) },
    projects: 1
  }
  f.listDeliverables.mockResolvedValue([item])
  expect(await listDesktopBotComputerDeliverables()).toEqual([item])
  expect(f.listDeliverables).toHaveBeenCalledExactlyOnceWith("/fixture/bot-host")
  expect(f.recovery).not.toHaveBeenCalled()
  for (const invalid of [
    [{ ...item, path: "/foreign" }],
    [{ ...item, projects: 0 }],
    Array.from({ length: 21 }, () => item)
  ]) {
    f.listDeliverables.mockResolvedValue(invalid)
    await expect(listDesktopBotComputerDeliverables()).rejects.toThrow()
  }
})

it("returns copied public progress without owner/token fields or a new Host launch", async () => {
  const progress = {
    nonce: randomUUID(),
    operation: "create",
    phase: "capture",
    component: "shared",
    activity: "file-io",
    startedAt: 1,
    updatedAt: 2,
    sequence: 3,
    entries: 4,
    bytes: 5
  }
  f.progress.mockReturnValue(progress)
  expect(await desktopBotComputerProgress()).toEqual(progress)
  expect(f.read).not.toHaveBeenCalled()
  f.progress.mockReturnValue(null)
  f.read.mockResolvedValue({ value: { hostId: "starting" } })
  f.startup.mockResolvedValue({
    ...progress,
    format: 1,
    workSequence: 7,
    owner: {
      pid: 100,
      hostTokenSha256: "a".repeat(64),
      root: { dev: "1", ino: "2" },
      lock: { dev: "1", ino: "3" }
    }
  })
  const result = await desktopBotComputerProgress()
  expect(result).toEqual(progress)
  expect(result).not.toHaveProperty("owner")
  expect(result).not.toHaveProperty("format")
  expect(result).not.toHaveProperty("workSequence")
})
