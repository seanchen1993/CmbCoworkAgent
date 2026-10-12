import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const f = vi.hoisted(() => ({
  root: "",
  spawn: vi.fn(),
  sync: vi.fn(),
  status: vi.fn(),
  restart: vi.fn(),
  close: vi.fn()
}))
vi.mock("node:child_process", () => ({ spawn: f.spawn }))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => f.root }))
vi.mock("./desktop-model-sync", () => ({ syncDesktopBotModels: f.sync }))
vi.mock("./transport-client", () => ({
  BotTransportClient: class {
    call = f.status
    restartIfIdle = f.restart
    close = f.close
  }
}))
vi.mock("./host-upgrade", () => ({ requestBotHostUpgrade: vi.fn().mockResolvedValue(false) }))

beforeEach(async () => {
  vi.resetModules()
  f.root = await mkdtemp(join(tmpdir(), "bot-desktop-maintenance-"))
  await mkdir(join(f.root, "bot-host"))
  for (const mock of [f.spawn, f.sync, f.status, f.restart, f.close]) mock.mockReset()
})
afterEach(async () => {
  await rm(f.root, { recursive: true, force: true })
})

it("can recover offline or damaged data without launching the normal runtime, and rejects new requests during maintenance", async () => {
  const { withDesktopBotMaintenance, getDesktopBotClient } = await import("./desktop-client")
  const competing = vi.fn(async () => {})
  const operation = vi.fn(async () => {
    await expect(getDesktopBotClient()).rejects.toThrow("正在备份或恢复")
    await expect(withDesktopBotMaintenance(competing)).rejects.toThrow("正在备份或恢复")
    return "restored"
  })
  expect(await withDesktopBotMaintenance(operation)).toBe("restored")
  expect(competing).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
  expect(f.sync).not.toHaveBeenCalled()
})

it("keeps active work running and refuses maintenance when the live Host cannot stop", async () => {
  await writeFile(join(f.root, "bot-host", "host.json"), JSON.stringify({ hostId: "live" }))
  f.status.mockResolvedValue({ hostId: "live" })
  f.restart.mockResolvedValue({ accepted: false, reason: "仍有任务执行" })
  const { withDesktopBotMaintenance } = await import("./desktop-client")
  const operation = vi.fn()
  await expect(withDesktopBotMaintenance(operation)).rejects.toThrow("仍有任务执行")
  expect(operation).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
})

it("waits for authenticated idle shutdown before running offline maintenance", async () => {
  const descriptor = join(f.root, "bot-host", "host.json")
  await writeFile(descriptor, JSON.stringify({ hostId: "idle" }))
  f.status.mockResolvedValue({ hostId: "idle" })
  f.restart.mockImplementation(async () => {
    await unlink(descriptor)
    return { accepted: true }
  })
  const { withDesktopBotMaintenance } = await import("./desktop-client")
  const operation = vi.fn().mockResolvedValue("saved")
  expect(await withDesktopBotMaintenance(operation)).toBe("saved")
  expect(f.restart).toHaveBeenCalledWith("idle")
  expect(f.close).toHaveBeenCalled()
  expect(operation).toHaveBeenCalledOnce()
})

it("lets the OS lock decide ownership after a stale descriptor or connection failure", async () => {
  await writeFile(join(f.root, "bot-host", "host.json"), JSON.stringify({ hostId: "stale" }))
  f.status.mockRejectedValue(new Error("ECONNREFUSED"))
  const { withDesktopBotMaintenance } = await import("./desktop-client")
  const operation = vi.fn().mockRejectedValue(new Error("仍在运行"))
  await expect(withDesktopBotMaintenance(operation)).rejects.toThrow("仍在运行")
  expect(f.close).toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
})
