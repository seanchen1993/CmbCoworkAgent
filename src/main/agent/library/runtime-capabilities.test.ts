import { beforeEach, expect, it, vi } from "vitest"
import { buildPersonalIdentityPrompt, isPersonalMemoryEnabled } from "../personal-context"
import { createAllowedSkillsBackend, resolveAllowedSkillRootDirs } from "./runtime-capabilities"

const discovery = vi.hoisted(() => vi.fn())
vi.mock("../../skills/discovery", () => ({ discoverSkills: discovery }))
beforeEach(() => discovery.mockReset())

it("an empty transport allowlist does not inspect private skill roots", async () => {
  expect(await resolveAllowedSkillRootDirs(["/private/skills"], [])).toEqual([])
  expect(discovery).not.toHaveBeenCalled()
})

it("restricts skill discovery without breaking unrelated backend methods or default paths", async () => {
  discovery.mockResolvedValue([
    { name: "allowed", rootDir: "/skills/allowed" },
    { name: "private", rootDir: "/skills/private" }
  ])
  const roots = await resolveAllowedSkillRootDirs(["/skills"], ["allowed"])
  const backend = {
    token: "bound",
    read() {
      return this.token
    },
    async lsInfo(path: string) {
      return path === "/skills"
        ? [
            { path: "/skills/allowed", is_dir: true },
            { path: "/skills/private", is_dir: true }
          ]
        : [{ path: "/workspace/file", is_dir: false }]
    }
  }
  const scoped = createAllowedSkillsBackend(backend, ["/skills"], roots)
  expect(await scoped.lsInfo("/skills")).toEqual([{ path: "/skills/allowed", is_dir: true }])
  expect(await scoped.lsInfo("/workspace")).toEqual([{ path: "/workspace/file", is_dir: false }])
  expect(scoped.read()).toBe("bound")
})

it("shared turns never read employee identity or enable personal memory; ordinary beta turns retain both", () => {
  const readIdentity = vi.fn(() => ({ userName: "private identity" }))
  expect(buildPersonalIdentityPrompt({ sharedTaskContext: true }, readIdentity)).toBe("")
  expect(readIdentity).not.toHaveBeenCalled()
  expect(isPersonalMemoryEnabled({ sharedTaskContext: true }, true)).toBe(false)
  expect(buildPersonalIdentityPrompt({}, readIdentity)).toContain("private identity")
  expect(readIdentity).toHaveBeenCalledTimes(1)
  expect(isPersonalMemoryEnabled({}, true)).toBe(true)
  expect(isPersonalMemoryEnabled({}, false)).toBe(false)
})
