import { mkdtemp, rm } from "fs/promises"
import * as fs from "fs"
import { existsSync } from "fs"
import { tmpdir } from "os"
import { basename, dirname, join, resolve } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("fs", async original => ({ ...(await original<typeof import("fs")>()) }))

vi.mock("electron", () => ({
  app: {}
}))

describe("storage home override", () => {
  let tempRoot: string | undefined
  const previousOverride = process.env.CMB_COWORK_AGENT_HOME

  afterEach(async () => {
    if (previousOverride === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = previousOverride
    vi.resetModules()
    if (tempRoot) {
      if (
        dirname(resolve(tempRoot)) !== resolve(tmpdir()) ||
        !basename(tempRoot).startsWith("cmb-storage-home-")
      )
        throw new Error("Unexpected storage fixture cleanup path")
      await rm(tempRoot, { recursive: true, force: true })
    }
    tempRoot = undefined
  })

  it("keeps explicitly isolated app data outside the real user home", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "cmb-storage-home-"))
    const isolatedHome = join(tempRoot, "app-data")
    process.env.CMB_COWORK_AGENT_HOME = `  ${isolatedHome}  `
    vi.resetModules()

    const storage = await import("./storage")

    expect(storage.getOpenworkDir()).toBe(isolatedHome)
    expect(storage.getDbPath()).toBe(join(isolatedHome, "cmbcoworkagent.sqlite"))
  })

  it("creates and rechecks the log directory with one existence probe", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "cmb-storage-home-"))
    const isolatedHome = join(tempRoot, "app-data"), logs = join(isolatedHome, "logs")
    process.env.CMB_COWORK_AGENT_HOME = isolatedHome
    vi.resetModules()
    const storage = await import("./storage")
    expect(existsSync(isolatedHome)).toBe(false)
    expect(storage.getLogsDir()).toBe(logs)
    expect(fs.statSync(logs).isDirectory()).toBe(true)
    const exists = vi.spyOn(fs, "existsSync")
    try {
      expect(storage.getRendererLogPath()).toBe(join(logs, "renderer.log"))
      expect(exists.mock.calls.filter(([name]) => name === logs || name === isolatedHome))
        .toEqual([[logs]])
    } finally { exists.mockRestore() }
    fs.rmdirSync(logs)
    fs.rmdirSync(isolatedHome)
    expect(storage.getMainLogPath()).toBe(join(logs, "main.log"))
    expect(fs.statSync(logs).isDirectory()).toBe(true)
    fs.rmdirSync(logs)
    fs.rmdirSync(isolatedHome)
    fs.writeFileSync(isolatedHome, "occupied")
    expect(() => storage.getLogsDir()).toThrow()
  })

  it("looks up checkpoint paths without creating the app home or a checkpoint directory", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "cmb-storage-home-"))
    const isolatedHome = join(tempRoot, "app-data")
    process.env.CMB_COWORK_AGENT_HOME = isolatedHome
    vi.resetModules()
    const storage = await import("./storage")
    expect(existsSync(isolatedHome)).toBe(false)
    expect(storage.peekThreadCheckpointPath("read-only-thread")).toBe(
      join(isolatedHome, "threads", "read-only-thread.sqlite")
    )
    expect(() => storage.peekThreadCheckpointPath("../outside")).toThrow("Invalid threadId")
    expect(existsSync(isolatedHome)).toBe(false)
  })
})
