import { EventEmitter } from "node:events"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  root: "",
  guard: vi.fn(),
  spawn: vi.fn(),
  quit: vi.fn()
}))
vi.mock("electron", () => ({
  app: {
    getPath: () => join(fixture.root, "CMBDevClaw.exe"),
    getVersion: () => "1.5.3",
    quit: fixture.quit
  }
}))
vi.mock("child_process", () => ({ spawn: fixture.spawn }))
vi.mock("./logger", () => ({
  appendUpdateLog: vi.fn(),
  updaterLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock("./downloader", () => ({ getUpdatesDir: () => fixture.root }))
vi.mock("./update-chain", () => ({
  clearPendingUpdateChain: vi.fn(),
  writePendingUpdateChain: vi.fn(() => true)
}))
vi.mock("../bots/desktop-client", () => ({ withDesktopBotUpdate: fixture.guard }))

import { installAsarUpdate, installFullUpdate } from "./installer"

let child: EventEmitter & { unref: ReturnType<typeof vi.fn> }
let previousResources: PropertyDescriptor | undefined
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), "cmb-update-bot-"))
  previousResources = Object.getOwnPropertyDescriptor(process, "resourcesPath")
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: fixture.root })
  fixture.guard.mockReset().mockImplementation((operation: () => Promise<void>) => operation())
  fixture.quit.mockReset()
  child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  fixture.spawn.mockReset().mockReturnValue(child)
})
afterEach(() => {
  if (previousResources) Object.defineProperty(process, "resourcesPath", previousResources)
  else Reflect.deleteProperty(process, "resourcesPath")
  rmSync(fixture.root, { recursive: true, force: true })
})

it.each(["asar", "full"])(
  "refuses %s installation before writing or launching when a Bot is busy",
  async (kind) => {
    fixture.guard.mockRejectedValue(new Error("请先完成或停止当前 Bot 任务"))
    const install = () =>
      kind === "asar"
        ? installAsarUpdate(join(fixture.root, "new.asar"), "1.5.4")
        : installFullUpdate(join(fixture.root, "new.zip"), "1.5.4")
    await expect(Promise.resolve().then(install)).rejects.toThrow("当前 Bot 任务")
    expect(readdirSync(fixture.root)).toEqual([])
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.quit).not.toHaveBeenCalled()
  }
)

it("waits for the installer to actually spawn before quitting", async () => {
  let handoffCommitted = false
  fixture.guard.mockImplementation(async (operation: () => Promise<void>) => {
    await operation()
    handoffCommitted = true
  })
  fixture.quit.mockImplementation(() => {
    expect(handoffCommitted, "Quit callbacks must run after the guard retains its lock").toBe(true)
  })
  const pending = installAsarUpdate(join(fixture.root, "new.asar"), "1.5.4")
  await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce())
  expect(fixture.quit).not.toHaveBeenCalled()
  child.emit("spawn")
  await pending
  expect(fixture.guard).toHaveBeenCalledOnce()
  expect(child.unref).toHaveBeenCalledOnce()
  expect(fixture.quit).toHaveBeenCalledOnce()
})

it("propagates an installer spawn failure without quitting so the maintenance guard can release", async () => {
  const outcome = Promise.resolve()
    .then(() => installAsarUpdate(join(fixture.root, "new.asar"), "1.5.4"))
    .then(
      () => null,
      (error: Error) => error
    )
  await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce())
  child.emit("error", new Error("installer unavailable"))
  expect(await outcome).toMatchObject({ message: "installer unavailable" })
  expect(fixture.quit).not.toHaveBeenCalled()
})
