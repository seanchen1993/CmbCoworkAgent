import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadAgentProfilesAsync } from "./agent-registry"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
  vi.restoreAllMocks()
})

describe("async agent registry", () => {
  it("loads workspace profiles without synchronous filesystem APIs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cmb-agent-registry-async-"))
    temporaryRoots.push(workspace)
    const agentsDir = join(workspace, ".cmbcoworkagent", "agents")
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, "async-review.md"),
      "---\nname: async-review\ndescription: async profile\nworkload: read_only\n---\nReview safely.\n",
      "utf8"
    )

    await expect(loadAgentProfilesAsync(workspace)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "async-review", shellAccess: "read_only" })
      ])
    )
  })

  it("skips and warns for a profile larger than the 256 KiB cap", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cmb-agent-registry-large-"))
    temporaryRoots.push(workspace)
    const agentsDir = join(workspace, ".cmbcoworkagent", "agents")
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, "oversized.md"), "x".repeat(256 * 1024 + 1), "utf8")
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const profiles = await loadAgentProfilesAsync(workspace)

    expect(profiles.some((profile) => profile.name === "oversized")).toBe(false)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("skipped to bound load cost"))
  })

  it("streams a pressure directory while retaining only the deterministic first 256", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cmb-agent-registry-pressure-"))
    temporaryRoots.push(workspace)
    const agentsDir = join(workspace, ".cmbcoworkagent", "agents")
    await mkdir(agentsDir, { recursive: true })
    for (let start = 0; start < 320; start += 64) {
      await Promise.all(
        Array.from({ length: Math.min(64, 320 - start) }, (_, offset) => {
          const index = start + offset
          const name = `pressure-${index.toString().padStart(3, "0")}`
          return writeFile(
            join(agentsDir, `${name}.md`),
            `---\nname: ${name}\nworkload: read_only\n---\nReview.\n`,
            "utf8"
          )
        })
      )
    }
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    let turns = 0
    const timer = setInterval(() => {
      turns += 1
    }, 0)

    try {
      const profiles = await loadAgentProfilesAsync(workspace)
      const pressureNames = profiles
        .map((profile) => profile.name)
        .filter((name) => name.startsWith("pressure-"))
      expect(pressureNames).toHaveLength(256)
      expect(pressureNames).toContain("pressure-000")
      expect(pressureNames).toContain("pressure-255")
      expect(pressureNames).not.toContain("pressure-256")
      expect(turns).toBeGreaterThan(0)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("loading the first 256"))
    } finally {
      clearInterval(timer)
    }
  }, 20_000)
})
