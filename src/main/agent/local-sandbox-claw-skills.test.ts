import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { SkillLifecycleRegistry } from "./skill-lifecycle/registry"
import { createClawSkillPolicy, listClawSkillSources } from "../mods/claw-skills"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

async function fixture(selected: string[]) {
  const root = mkdtempSync(join(tmpdir(), "claw-skill-backend-"))
  roots.push(root)
  const source = join(root, "skills")
  const parent = join(source, "parent")
  const child = join(parent, "child")
  const denied = join(source, "denied")
  for (const [dir, name] of [
    [parent, "parent"],
    [child, "child"],
    [denied, "denied"]
  ]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: fixture\n---\nSECRET-${name}`
    )
    writeFileSync(join(dir, "support.txt"), `SUPPORT-${name}`)
  }
  const access = {
    sources: async () => [{ sourceDir: source }],
    currentSources: vi.fn(() => [{ sourceDir: source }]),
    disabledDirs: vi.fn<() => string[]>(() => [])
  }
  const entries = await listClawSkillSources(access)
  const policy = (await createClawSkillPolicy(
    { mode: "selected", items: entries.filter(({ name }) => selected.includes(name)) },
    access
  ))!
  const sandbox = new LocalSandbox({ rootDir: root, runId: "claw-skills-fixture" })
  sandbox.setClawSkillPolicy(policy)
  sandbox.setSkillLifecycleRegistry(new SkillLifecycleRegistry(policy.lifecycleSources))
  return { root, source, parent, child, denied, sandbox, policy, access }
}

describe("LocalSandbox Claw Skill structured entrypoints", () => {
  it("uses the same selection in an inert native permission probe", async () => {
    const f = await fixture(["child"])
    const probe = LocalSandbox.createPermissionProbe({ rootDir: f.root, clawSkillPolicy: f.policy })
    expect(await probe("read_file", { file_path: join(f.parent, "SKILL.md") })).toMatchObject({
      decision: "deny"
    })
    expect(await probe("read_file", { file_path: join(f.child, "SKILL.md") })).toMatchObject({
      decision: "allow"
    })
  })
  it("runs selected alias lifecycle hooks and rejects a document changed during PreSkillUse", async () => {
    const f = await fixture(["child"])
    const alias = join(f.root, "child-alias")
    symlinkSync(f.child, alias, process.platform === "win32" ? "junction" : "dir")
    const hooks = vi.spyOn(
      f.sandbox as unknown as { runHooks: (event: string) => Promise<null> },
      "runHooks"
    )
    hooks.mockImplementation(async (event) => {
      if (event === "PreSkillUse")
        writeFileSync(join(f.child, "SKILL.md"), "---\nname: child\n---\nCHANGED_DURING_HOOK")
      return null
    })
    const result = await f.sandbox.read(join(alias, "SKILL.md"))
    expect(hooks.mock.calls.some(([event]) => event === "PreSkillUse")).toBe(true)
    expect(result).toContain("skill changed")
    expect(result).not.toContain("CHANGED_DURING_HOOK")
  })
  it("reads selected nested docs and supporting files but rejects parent, sibling and aliases", async () => {
    const f = await fixture(["child"])
    expect(await f.sandbox.read(join(f.child, "SKILL.md"))).toContain("SECRET-child")
    expect(await f.sandbox.read(join(f.child, "support.txt"))).toContain("SUPPORT-child")
    expect(await f.sandbox.read(join(f.parent, "SKILL.md"))).toContain("excluded")
    expect(await f.sandbox.read(join(f.denied, "support.txt"))).toContain("excluded")
    const alias = join(f.root, "denied-alias")
    symlinkSync(f.denied, alias, process.platform === "win32" ? "junction" : "dir")
    expect(await f.sandbox.read(join(alias, "SKILL.md"))).toContain("excluded")
  })

  it("filters actual ls, glob and grep content while traversing an excluded parent", async () => {
    const f = await fixture(["child"])
    const listed = await f.sandbox.lsInfo(f.parent)
    expect(
      listed.some(({ path }) => path.replace(/\\/g, "/").replace(/\/$/, "").endsWith("/child")),
      JSON.stringify(listed)
    ).toBe(true)
    expect(listed.some(({ path }) => path.endsWith("SKILL.md"))).toBe(false)
    const globbed = await f.sandbox.globInfo("**/SKILL.md", f.source)
    expect(globbed).toHaveLength(1)
    expect(globbed[0].path.replace(/\\/g, "/")).toContain("/parent/child/SKILL.md")
    const matches = await f.sandbox.grepRaw("SECRET-", f.source)
    if (!Array.isArray(matches)) throw new Error(`Unexpected grep failure: ${matches}`)
    expect(matches.some(({ text }) => text.includes("SECRET-child"))).toBe(true)
    expect(
      matches.some(({ text }) => text.includes("SECRET-parent") || text.includes("SECRET-denied"))
    ).toBe(false)
  })

  it("reads live skill roots once for each glob and grep result list", async () => {
    const f = await fixture(["child"])
    const workspace = join(f.root, "workspace")
    mkdirSync(workspace)
    for (let index = 0; index < 24; index++) {
      writeFileSync(join(workspace, `file-${index}.txt`), `SUPPORT-ordinary-${index}`)
    }
    const late = join(f.source, "late")
    mkdirSync(late)
    writeFileSync(join(late, "SKILL.md"), "---\nname: late\n---\n")
    writeFileSync(join(late, "support.txt"), "SUPPORT-late")
    const alias = join(f.root, "denied-alias")
    symlinkSync(f.denied, alias, process.platform === "win32" ? "junction" : "dir")

    const readsPerBatch: number[] = []
    const originalFilter = f.policy.filterVisiblePaths.bind(f.policy)
    const batch = vi.spyOn(f.policy, "filterVisiblePaths").mockImplementation((...args) => {
      const before = f.access.currentSources.mock.calls.length
      const visible = originalFilter(...args)
      readsPerBatch.push(f.access.currentSources.mock.calls.length - before)
      return visible
    })
    const globbed = await f.sandbox.globInfo("**/*.txt", f.root)
    expect(globbed).toHaveLength(25)
    expect(globbed.some(({ path }) => path.replace(/\\/g, "/").includes("/parent/child/"))).toBe(
      true
    )
    expect(readsPerBatch).toEqual([1])

    const matches = await f.sandbox.grepRaw("SUPPORT-", f.root)
    if (!Array.isArray(matches)) throw new Error(`Unexpected grep failure: ${matches}`)
    expect(matches).toHaveLength(25)
    expect(matches.some(({ text }) => text.includes("SUPPORT-child"))).toBe(true)
    expect(matches.some(({ text }) => /SUPPORT-(?:parent|denied|late)/.test(text))).toBe(false)
    expect(readsPerBatch).toEqual([1, 1])
    expect(batch.mock.calls[1][0].length).toBeGreaterThan(20)

    f.access.disabledDirs.mockReturnValue([f.child])
    expect(await f.sandbox.globInfo("**/*.txt", f.root)).toHaveLength(24)
    expect(await f.sandbox.read(join(f.child, "support.txt"))).toContain("excluded")
  })

  it("rejects skill cwd before the workspace early-allow and detects a changed document", async () => {
    const f = await fixture(["child"])
    const execution = await f.sandbox.execute("echo MUST_NOT_EXECUTE", f.parent)
    expect(JSON.stringify(execution)).toContain("excluded by the current Claw skill selection")
    writeFileSync(join(f.child, "SKILL.md"), "---\nname: child\n---\nCHANGED")
    expect(await f.sandbox.read(join(f.child, "support.txt"))).toContain("excluded")
  })

  it("selected empty hides skills and removing the policy restores the original backend", async () => {
    const f = await fixture([])
    expect(await f.sandbox.read(join(f.denied, "SKILL.md"))).toContain("excluded")
    expect(await f.sandbox.globInfo("**/SKILL.md", f.source)).toEqual([])
    f.sandbox.setClawSkillPolicy(undefined)
    expect(await f.sandbox.read(join(f.denied, "SKILL.md"))).toContain("SECRET-denied")
  })
})
