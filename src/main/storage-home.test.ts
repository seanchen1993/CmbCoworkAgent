import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

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
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
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
})
