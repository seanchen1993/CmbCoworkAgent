import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isSkillVisibleForProjectMode } from "../../shared/skill-visibility"
import {
  createClawSkillPolicy,
  listClawSkillSources,
  resolveFlowSkillSource,
  createFlowSkillSourceResolver,
  type ClawSkillCatalogAccess
} from "./claw-skills"
import {
  SkillLifecycleRegistry,
  type SkillLifecycleSource
} from "../agent/skill-lifecycle/registry"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claw-skill-policy-"))
  roots.push(root)
  let sources: SkillLifecycleSource[] = [{ sourceDir: root }]
  let disabled: string[] = []
  const access: ClawSkillCatalogAccess = {
    sources: vi.fn(async () => sources),
    currentSources: () => sources,
    disabledDirs: () => disabled
  }
  const add = (path: string, name = path) => {
    const dir = join(root, path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: fixture\n---\nSECRET-${path}`
    )
    writeFileSync(join(dir, "support.txt"), `SUPPORT-${path}`)
    return dir
  }
  return {
    root,
    add,
    access,
    disable: (dirs: string[]) => {
      disabled = dirs
    },
    sources: (value: SkillLifecycleSource[]) => {
      sources = value
    }
  }
}

describe("Claw Skill catalog and real filesystem selection", () => {
  it("keeps equal-length skill roots stable when source discovery order changes", async () => {
    const f = fixture()
    const one = f.add("one")
    const two = f.add("two")
    const sources = [{ sourceDir: one }, { sourceDir: two }]
    f.sources(sources)
    const first = await listClawSkillSources(f.access)
    f.sources([...sources].reverse())
    const second = await listClawSkillSources(f.access)
    expect(first).toHaveLength(2)
    expect(second).toEqual(first)
    expect(first.map((item) => item.name)).toEqual(["one", "two"])
    writeFileSync(join(one, "SKILL.md"), "---\nname: one\n---\nchanged source")
    const changed = await listClawSkillSources(f.access)
    expect(changed[0].digest).not.toBe(first[0].digest)
    expect(changed[1]).toEqual(first[1])
  })
  it("discovers once for many flow nodes but rechecks every node document against the pin", async () => {
    const f = fixture()
    const paths = Array.from({ length: 64 }, (_, index) => f.add(`node-${index}`))
    const entries = await listClawSkillSources(f.access)
    vi.mocked(f.access.sources).mockClear()
    const started = performance.now()
    const resolveSource = await createFlowSkillSourceResolver(() => undefined, f.access)
    const sources = entries.map(resolveSource)
    expect(f.access.sources).toHaveBeenCalledTimes(1)
    const prepareMs = performance.now() - started
    const checksStarted = performance.now()
    for (const source of sources) source.assertCurrent()
    console.log(
      "FLOW_SKILL_64_PERFORMANCE",
      JSON.stringify({ prepareMs, recheckMs: performance.now() - checksStarted })
    )
    writeFileSync(join(paths[0], "SKILL.md"), "changed after resolution")
    const changed = sources.find(
      (source) => source.trustedExplicitSkill.path === join(paths[0], "SKILL.md")
    )!
    expect(() => changed.assertCurrent()).toThrow("SOURCE_CHANGED")
    expect(() => resolveSource(changed.reference)).toThrow("SOURCE_CHANGED")
  })
  it("resolves an opaque flow source and pins it even with unrestricted selection", async () => {
    const f = fixture()
    const one = f.add("one", "same")
    f.add("two", "same")
    const entries = await listClawSkillSources(f.access)
    const sources = await Promise.all(
      entries.map((entry) => resolveFlowSkillSource(entry, () => undefined, f.access))
    )
    expect(new Set(sources.map((source) => source.trustedExplicitSkill.path)).size).toBe(2)
    const source = sources.find((item) => item.trustedExplicitSkill.path === join(one, "SKILL.md"))!
    source.assertCurrent()
    writeFileSync(join(one, "SKILL.md"), "changed")
    expect(() => source.assertCurrent()).toThrow("SOURCE_CHANGED")
  })
  it("rechecks live selection and owner availability instead of accepting stale node references", async () => {
    const f = fixture()
    f.add("review")
    const [entry] = await listClawSkillSources(f.access)
    let items = [entry]
    const source = await resolveFlowSkillSource(
      entry,
      () => ({ mode: "selected", items }),
      f.access
    )
    items = []
    expect(() => source.assertCurrent()).toThrow("NOT_SELECTED")
    await expect(
      resolveFlowSkillSource(entry, () => ({ mode: "selected", items }), f.access)
    ).rejects.toThrow("NOT_SELECTED")
    items = [entry]
    f.sources([])
    expect(() => source.assertCurrent()).toThrow("SOURCE_UNAVAILABLE")
  })
  it("rejects forged names/digests and newly disabled explicit nodes", async () => {
    const f = fixture()
    const dir = f.add("review")
    const [entry] = await listClawSkillSources(f.access)
    for (const forged of [
      { ...entry, name: "forged" },
      { ...entry, digest: "forged" }
    ])
      await expect(resolveFlowSkillSource(forged, () => undefined, f.access)).rejects.toThrow(
        "SOURCE_CHANGED"
      )
    const source = await resolveFlowSkillSource(entry, () => undefined, f.access)
    f.disable([dir])
    expect(() => source.assertCurrent()).toThrow("DISABLED")
  })
  it("measures a 512-skill source and directory filtering without imposing a machine-specific timing threshold", async () => {
    const f = fixture()
    const paths: string[] = []
    for (let index = 0; index < 512; index++)
      paths.push(join(f.add(`skill-${index}`), "support.txt"))
    const catalogStart = performance.now()
    const entries = await listClawSkillSources(f.access)
    const catalogMs = performance.now() - catalogStart
    expect(entries).toHaveLength(512)
    const policyStart = performance.now()
    const policy = (await createClawSkillPolicy({ mode: "selected", items: entries }, f.access))!
    const policyMs = performance.now() - policyStart
    const samples: number[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      const started = performance.now()
      for (const path of paths) expect(policy.isPathHidden(path)).toBe(false)
      samples.push(performance.now() - started)
    }
    console.log(
      "CLAW_SKILL_512_PERFORMANCE",
      JSON.stringify({ catalogMs, policyMs, filter512SamplesMs: samples })
    )
  }, 20_000)
  it("leaves old/all selection on the original no-scan path", async () => {
    const { access } = fixture()
    expect(await createClawSkillPolicy(undefined, access)).toBeUndefined()
    expect(await createClawSkillPolicy({ mode: "all", items: [] }, access)).toBeUndefined()
    expect(access.sources).not.toHaveBeenCalled()
  })

  it("exports opaque IDs without paths and disambiguates equal names", async () => {
    const f = fixture()
    f.add("one", "same")
    f.add("two", "same")
    const entries = await listClawSkillSources(f.access)
    expect(entries).toHaveLength(2)
    expect(new Set(entries.map(({ id }) => id)).size).toBe(2)
    expect(JSON.stringify(entries)).not.toContain(f.root.replace(/\\/g, "\\\\"))
    for (const entry of entries) expect(entry.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it("projects only the selected nested skill while preserving traversal of its excluded parent", async () => {
    const f = fixture()
    const parent = f.add("parent")
    const child = f.add("parent/child", "child")
    const other = f.add("other")
    const entries = await listClawSkillSources(f.access)
    const selected = entries.find(({ name }) => name === "child")!
    const policy = (await createClawSkillPolicy({ mode: "selected", items: [selected] }, f.access))!
    expect(policy.isPathHidden(parent, { traverse: true })).toBe(false)
    expect(policy.isPathHidden(parent)).toBe(true)
    expect(policy.isPathHidden(join(parent, "SKILL.md"))).toBe(true)
    expect(policy.isPathHidden(join(child, "SKILL.md"))).toBe(false)
    expect(policy.isPathHidden(join(child, "support.txt"))).toBe(false)
    expect(policy.isPathHidden(other)).toBe(true)
    const registry = new SkillLifecycleRegistry(policy.lifecycleSources)
    expect(registry.resolveExplicit({ skillPath: parent })).toBeNull()
    expect(registry.resolveExplicit({ skillPath: child })?.name).toBe("child")
    expect(policy.middlewareSources).toHaveLength(1)
    expect(() =>
      policy.assertSkillReference({ name: "child", path: join(parent, "SKILL.md") })
    ).toThrow("NOT_SELECTED")
  })

  it("does not authorize nested registered or newly added descendants just by selecting the parent", async () => {
    const f = fixture()
    const parent = f.add("parent")
    const nested = f.add("parent/nested", "nested")
    const entries = await listClawSkillSources(f.access)
    const policy = (await createClawSkillPolicy(
      { mode: "selected", items: entries.filter(({ name }) => name === "parent") },
      f.access
    ))!
    expect(policy.isPathHidden(join(parent, "support.txt"))).toBe(false)
    expect(policy.isPathHidden(join(nested, "SKILL.md"))).toBe(true)
    const fresh = f.add("parent/fresh", "fresh")
    expect(policy.isPathHidden(join(fresh, "SKILL.md"))).toBe(true)
  })

  it("empty selection blocks registered skills while preserving ordinary workspace files", async () => {
    const f = fixture()
    const skill = f.add("one")
    const policy = (await createClawSkillPolicy({ mode: "selected", items: [] }, f.access))!
    expect(policy.lifecycleSources).toEqual([])
    expect(policy.middlewareSources).toEqual([])
    expect(policy.isPathHidden(join(skill, "SKILL.md"))).toBe(true)
    expect(policy.isPathHidden(join(f.root, "app.ts"))).toBe(false)
  })

  it("rejects aliases into unselected roots and pins aliases of selected document identity", async () => {
    const f = fixture()
    const allowed = f.add("allowed")
    const denied = f.add("denied")
    const entries = await listClawSkillSources(f.access)
    const policy = (await createClawSkillPolicy(
      { mode: "selected", items: entries.filter(({ name }) => name === "allowed") },
      f.access
    ))!
    const alias = join(f.root, "alias")
    symlinkSync(denied, alias, process.platform === "win32" ? "junction" : "dir")
    expect(policy.isPathHidden(join(alias, "SKILL.md"))).toBe(true)
    expect(() =>
      policy.assertSkillReference({ name: "allowed", path: join(alias, "SKILL.md") })
    ).toThrow()
    const selectedAlias = join(f.root, "selected-alias")
    symlinkSync(allowed, selectedAlias, process.platform === "win32" ? "junction" : "dir")
    expect(policy.isPathHidden(join(selectedAlias, "SKILL.md"))).toBe(false)
  })

  it("rechecks document digest, global disablement and source removal at actual use", async () => {
    const f = fixture()
    const dir = f.add("one")
    const entries = await listClawSkillSources(f.access)
    const policy = (await createClawSkillPolicy({ mode: "selected", items: entries }, f.access))!
    f.disable([dir])
    expect(await listClawSkillSources(f.access)).toEqual([])
    expect(() => policy.assertSkillReference({ name: "one", path: dir })).toThrow("DISABLED")
    f.disable([])
    f.sources([])
    expect(() => policy.assertSkillReference({ name: "one", path: dir })).toThrow("UNAVAILABLE")
    f.sources([{ sourceDir: f.root }])
    writeFileSync(join(dir, "SKILL.md"), "---\nname: one\n---\nCHANGED")
    expect(() => policy.assertSkillReference({ name: "one", path: dir })).toThrow("CHANGED")
    expect(policy.isPathHidden(join(dir, "support.txt"))).toBe(true)
    await expect(
      createClawSkillPolicy({ mode: "selected", items: entries }, f.access)
    ).rejects.toThrow("CHANGED")
  })
})

describe("project visibility within selected Claw skills", () => {
  const visible = (source: SkillLifecycleSource) => isSkillVisibleForProjectMode(source, {
    projectMode: true,
    boundPluginId: "allowed-plugin",
    boundPluginName: "Shared adapter"
  })

  it("distinguishes equal plugin names and rejects a selected source outside the binding", async () => {
    const f = fixture()
    const allowed = f.add("allowed", "same")
    const other = f.add("other", "same")
    const owner = { pluginName: "Shared adapter", isProjectModePlugin: true }
    const ownSource = { ...owner, sourceDir: allowed, pluginId: "allowed-plugin" }
    const otherSource = { ...owner, sourceDir: other, pluginId: "other-plugin" }
    f.sources([ownSource, otherSource])
    const entries = await listClawSkillSources(f.access)
    const results = await Promise.allSettled(entries.map((entry) =>
      createClawSkillPolicy({ mode: "selected", items: [entry] }, f.access, visible)
    ))
    const accepted = results.filter((result) => result.status === "fulfilled")
    const rejected = results.filter((result) => result.status === "rejected")
    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason.message).toContain("CLAW_SKILL_SOURCE_UNAVAILABLE")
    expect(() => accepted[0].value!.assertSkillReference({ name: "same", path: allowed }))
      .not.toThrow()
  })

  it("rechecks live source classification and hides a selected source after it loses visibility", async () => {
    const f = fixture()
    const skill = f.add("review")
    const source = {
      sourceDir: f.root,
      pluginId: "other-plugin",
      pluginName: "Shared adapter",
      isProjectModePlugin: false
    }
    f.sources([source])
    const entries = await listClawSkillSources(f.access)
    const policy = (await createClawSkillPolicy(
      { mode: "selected", items: entries }, f.access, visible
    ))!
    policy.assertAllCurrent()
    const changedSource = { ...source, isProjectModePlugin: true }
    f.sources([changedSource])
    expect(() => policy.assertAllCurrent()).toThrow("CLAW_SKILL_SOURCE_UNAVAILABLE")
    expect(() => policy.assertSkillReference({ name: "review", path: skill }))
      .toThrow("CLAW_SKILL_SOURCE_UNAVAILABLE")
    expect(policy.isPathHidden(join(skill, "support.txt"))).toBe(true)
  })

  it("keeps both known and newly added unselected project skill documents hidden", async () => {
    const f = fixture()
    const allowed = f.add("allowed")
    const other = f.add("other-plugin/known", "other")
    const ownSource = {
      sourceDir: allowed, pluginId: "allowed-plugin", isProjectModePlugin: true
    }
    const otherSource = {
      sourceDir: join(f.root, "other-plugin"),
      pluginId: "other-plugin",
      isProjectModePlugin: true
    }
    f.sources([ownSource, otherSource])
    const entry = (await listClawSkillSources(f.access)).find((item) => item.name === "allowed")!
    const policy = (await createClawSkillPolicy(
      { mode: "selected", items: [entry] }, f.access, visible
    ))!
    expect(policy.isPathHidden(join(allowed, "SKILL.md"))).toBe(false)
    expect(policy.isPathHidden(join(other, "SKILL.md"))).toBe(true)
    const late = f.add("other-plugin/late")
    expect(policy.isPathHidden(join(late, "SKILL.md"))).toBe(true)
    expect(policy.isPathHidden(join(late, "support.txt"))).toBe(true)
  })

  it("retains the no-scan path for old and all-source configurations", async () => {
    const f = fixture()
    const predicate = vi.fn(() => false)
    expect(await createClawSkillPolicy(undefined, f.access, predicate)).toBeUndefined()
    expect(await createClawSkillPolicy({ mode: "all", items: [] }, f.access, predicate))
      .toBeUndefined()
    expect(f.access.sources).not.toHaveBeenCalled()
    expect(predicate).not.toHaveBeenCalled()
  })
})
