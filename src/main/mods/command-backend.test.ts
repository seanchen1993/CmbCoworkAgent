import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ClawSourceSelection } from "../../shared/mods/claw"
import type { ModThreadBinding } from "./manager"

const mocks = vi.hoisted(() => ({
  source: "",
  selections: new Map<string, ClawSourceSelection>(),
  bindings: new Map<string, ModThreadBinding>(),
  release: vi.fn()
}))
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.env.TEMP }
}))
vi.mock("./manager", () => ({
  authorizeCurrentModInput: async () => undefined,
  getModsManager: () => ({
    clawProfile: (_workspace: string, threadId: string) => ({
      skills: mocks.selections.get(threadId)
    }),
    isActive: () => false,
    isEnabled: () => false,
    bindThread: (binding: ModThreadBinding) => {
      mocks.bindings.set(binding.threadId, binding)
      return () => {
        mocks.bindings.delete(binding.threadId)
        mocks.release()
      }
    }
  })
}))
vi.mock("../storage", async (original) => ({
  ...(await original<typeof import("../storage")>()),
  getWindowsSandboxMode: () => "none",
  getEnabledHooks: () => [],
  getEnabledPluginHookMetadata: () => [],
  getEnabledSkillHookMetadata: () => [],
  getEnabledSkillsSources: async () => [],
  getSkillsSources: () => [],
  getDisabledSkillDirs: () => [],
  getEnabledPluginSkillSourceMetadata: () => [
    {
      sourceDir: mocks.source,
      pluginId: "skill-owner",
      pluginName: "Skill Owner",
      pluginRoot: mocks.source
    }
  ]
}))
import { bindStandaloneModCommand } from "./command-backend"
import { listClawSkillSources } from "./claw-skills"

const roots: string[] = []
const releases: Array<() => Promise<void>> = []
beforeEach(() => {
  mocks.selections.clear()
  mocks.bindings.clear()
  mocks.release.mockClear()
})
afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claw-command-skills-"))
  roots.push(root)
  mocks.source = join(root, "skills")
  for (const name of ["one", "two"]) {
    const dir = join(mocks.source, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: fixture\n---\nSECRET_${name}`
    )
  }
  const entries = await listClawSkillSources()
  const bind = async (threadId: string, names?: string[]) => {
    if (names)
      mocks.selections.set(threadId, {
        mode: "selected",
        items: entries.filter(({ name }) => names.includes(name))
      })
    releases.push(
      await bindStandaloneModCommand(
        root,
        threadId,
        `turn:${threadId}`,
        new AbortController().signal
      )
    )
    const binding = mocks.bindings.get(threadId)!
    return {
      binding,
      read: (name: string) =>
        binding.invokeTool!("host:read_file", { file_path: join(mocks.source, name, "SKILL.md") })
    }
  }
  return { root, entries, bind }
}

describe("standalone SDK native command Skill binding", () => {
  it("the actual registered native adapter enforces each thread's selection and activates the real owner", async () => {
    const f = await fixture()
    const one = await f.bind("one-thread", ["one"])
    const two = await f.bind("two-thread", ["two"])
    expect(await one.read("one")).toContain("SECRET_one")
    expect(await one.read("two")).toContain("excluded")
    expect(await two.read("two")).toContain("SECRET_two")
    expect(await two.read("one")).toContain("excluded")
    expect(one.binding.activePluginIds?.has("skill-owner")).toBe(true)
  })

  it("empty selection blocks the cold native adapter while legacy commands keep the old path", async () => {
    const f = await fixture()
    const empty = await f.bind("empty", [])
    expect(await empty.read("one")).toContain("excluded")
    const legacy = await f.bind("legacy")
    expect(await legacy.read("one")).toContain("SECRET_one")
  })

  it("rejects stale selected source before binding a native adapter", async () => {
    const f = await fixture()
    mocks.selections.set("stale", { mode: "selected", items: f.entries })
    writeFileSync(join(mocks.source, "one", "SKILL.md"), "CHANGED")
    await expect(
      bindStandaloneModCommand(f.root, "stale", "turn", new AbortController().signal)
    ).rejects.toThrow("CHANGED")
    expect(mocks.bindings.has("stale")).toBe(false)
  })
})
