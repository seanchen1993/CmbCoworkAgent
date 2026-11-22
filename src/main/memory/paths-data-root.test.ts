import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("memory storage root", () => {
  it("keeps catalogs, indexes and their settings under the configured application root", async () => {
    vi.stubEnv("CMB_COWORK_AGENT_HOME", "./synthetic-memory-profile")
    const paths = await import("./paths")
    const root = resolve("./synthetic-memory-profile")
    expect(paths.MEMORY_ROOT_DIR).toBe(join(root, "memory"))
    expect(paths.GLOBAL_MEMORY_DIR).toBe(join(root, "memory", "global"))
    expect(paths.PROJECTS_MEMORY_DIR).toBe(join(root, "memory", "projects"))
  })

  it("preserves the existing default location", async () => {
    vi.stubEnv("CMB_COWORK_AGENT_HOME", "")
    const paths = await import("./paths")
    expect(paths.MEMORY_ROOT_DIR).toBe(join(homedir(), ".cmbcoworkagent", "memory"))
  })
})
