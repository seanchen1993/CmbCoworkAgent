import { afterEach, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { readNativeSkillUsagePolicy } from "./native-skill-usage"
import {
  createClawSkillPolicy,
  listClawSkillSources,
  type ClawSkillCatalogAccess
} from "../mods/claw-skills"

const owned: string[] = []
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(declare = true) {
  const parent = resolve("output/native-skill-usage-fixtures")
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, "case-"))
  owned.push(root)
  for (const name of ["project", "chat", "universal", "legacy", "dependent"]) {
    mkdirSync(join(root, "skills", name), { recursive: true })
    writeFileSync(
      join(root, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Fixture ${name}\n---\n${name}`
    )
  }
  const manifest = {
    apiVersion: "devclaw.capabilities/v1",
    capabilities: [
      ...["project", "chat", "universal"].map((usage) => ({
        id: usage,
        title: usage,
        kind: "skill",
        usage,
        entry: `skills/${usage}/SKILL.md`
      })),
      {
        id: "dependent",
        title: "dependent",
        kind: "skill",
        usage: "project",
        entry: "skills/dependent/SKILL.md",
        dependsOn: ["project"]
      }
    ]
  }
  if (declare) writeFileSync(join(root, "devclaw.capabilities.json"), JSON.stringify(manifest))
  const source = { sourceDir: join(root, "skills"), pluginId: "fixture", pluginRoot: root }
  const access: ClawSkillCatalogAccess = {
    sources: async () => [source],
    currentSources: () => [source],
    disabledDirs: () => []
  }
  return { root, access, manifest, plugins: [{ path: root, enabled: true }] }
}

it("leaves undeclared old plugins untouched without reading a new context", async () => {
  const f = fixture(false)
  expect(
    await readNativeSkillUsagePolicy(f.plugins, () => {
      throw Error("must not probe old threads")
    })
  ).toBeUndefined()
})
it("projects declared scope and dependencies while retaining undeclared skills", async () => {
  const f = fixture()
  const policy = await readNativeSkillUsagePolicy(f.plugins, () => ({
    usage: "chat",
    assertCurrent() {
      return undefined
    }
  }))
  const selected = await createClawSkillPolicy(undefined, f.access, undefined, policy)
  expect(selected!.skillPaths.map((path) => path.split(/[\\/]/).at(-2)).sort()).toEqual([
    "chat",
    "legacy",
    "universal"
  ])
  expect(selected!.isPathHidden(join(f.root, "skills/project/SKILL.md"))).toBe(true)
  expect(selected!.isPathHidden(join(f.root, "skills/dependent/SKILL.md"))).toBe(true)
  expect(() =>
    selected!.assertSkillReference({
      name: "project",
      path: join(f.root, "skills/project/SKILL.md")
    })
  ).toThrow("CLAW_SKILL_USAGE_UNAVAILABLE")
})
it("preserves applicable project stages and rejects explicit incompatible old selections", async () => {
  const f = fixture()
  const policy = await readNativeSkillUsagePolicy(f.plugins, () => ({
    usage: "project",
    assertCurrent() {
      return undefined
    }
  }))
  const selected = await createClawSkillPolicy(
    { mode: "all", items: [] },
    f.access,
    undefined,
    policy
  )
  expect(selected!.skillPaths.map((path) => path.split(/[\\/]/).at(-2)).sort()).toEqual([
    "dependent",
    "legacy",
    "project",
    "universal"
  ])
  const chat = (await listClawSkillSources(f.access)).find((item) => item.name === "chat")!
  await expect(
    createClawSkillPolicy({ mode: "selected", items: [chat] }, f.access, undefined, policy)
  ).rejects.toThrow("CLAW_SKILL_USAGE_UNAVAILABLE")
})
it("rechecks declaration and authoritative context at model boundaries", async () => {
  const f = fixture()
  let stale = false
  const policy = await readNativeSkillUsagePolicy(f.plugins, () => ({
    usage: "chat",
    assertCurrent() {
      if (stale) throw Error("context changed")
    }
  }))
  policy!.assertCurrent()
  stale = true
  expect(() => policy!.assertCurrent()).toThrow("context changed")
  stale = false
  writeFileSync(
    join(f.root, "devclaw.capabilities.json"),
    JSON.stringify({ ...f.manifest, changed: true })
  )
  expect(() => policy!.assertCurrent()).toThrow("NATIVE_CAPABILITY_DECLARATION_CHANGED")
})
it("fails closed for oversized or malformed explicit declarations", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "devclaw.capabilities.json"), " ".repeat(65537))
  await expect(
    readNativeSkillUsagePolicy(f.plugins, () => ({
      usage: "chat",
      assertCurrent() {
        return undefined
      }
    }))
  ).rejects.toThrow()
  writeFileSync(join(f.root, "devclaw.capabilities.json"), "not-json")
  await expect(
    readNativeSkillUsagePolicy(f.plugins, () => ({
      usage: "chat",
      assertCurrent() {
        return undefined
      }
    }))
  ).rejects.toThrow()
})

it("isolates damaged sources only during ordinary discovery and still checks authority", async () => {
  const healthy = fixture(),
    damaged = fixture()
  const plugins = [...damaged.plugins, ...healthy.plugins]
  const chosen = join(healthy.root, "skills/chat/SKILL.md")
  const unavailable = join(damaged.root, "skills/legacy/SKILL.md")
  const alias = join(healthy.root, "alias")
  symlinkSync(
    join(damaged.root, "skills/legacy"),
    alias,
    process.platform === "win32" ? "junction" : "dir"
  )
  const aliased = join(alias, "SKILL.md")
  const path = join(damaged.root, "devclaw.capabilities.json")
  writeFileSync(path, "not-json")
  let stale = false
  const capture = () => ({
    usage: "chat" as const,
    assertCurrent() {
      if (stale) throw Error("scope changed")
    }
  })
  const ordinary = await readNativeSkillUsagePolicy(plugins, capture, undefined, {
    explicitSkillPath: chosen
  })
  expect(ordinary?.allowsSkill(chosen)).toBe(true)
  expect(ordinary?.allowsSkill(unavailable)).toBe(false)
  expect(ordinary?.allowsSkill(aliased)).toBe(false)
  for (const explicitSkillPath of [unavailable, aliased]) {
    await expect(
      readNativeSkillUsagePolicy(plugins, capture, undefined, { explicitSkillPath })
    ).rejects.toBeInstanceOf(SyntaxError)
  }
  await expect(
    readNativeSkillUsagePolicy(plugins, () => ({ ...capture(), usage: "project" }), undefined, {})
  ).rejects.toBeInstanceOf(SyntaxError)
  await expect(
    readNativeSkillUsagePolicy(
      plugins,
      () => {
        throw Error("scope inaccessible")
      },
      undefined,
      {}
    )
  ).rejects.toThrow("scope inaccessible")
  stale = true
  expect(() => ordinary?.assertCurrent()).toThrow("scope changed")
  stale = false
  const controller = new AbortController()
  await expect(
    readNativeSkillUsagePolicy(
      plugins,
      () => {
        controller.abort(Error("scope cancelled"))
        return capture()
      },
      controller.signal,
      {}
    )
  ).rejects.toThrow("scope cancelled")
  writeFileSync(path, JSON.stringify(damaged.manifest))
  expect(ordinary?.allowsSkill(unavailable)).toBe(false)
  ordinary?.assertCurrent()
  writeFileSync(join(healthy.root, "devclaw.capabilities.json"), "now-invalid")
  expect(() => ordinary?.assertCurrent()).toThrow("NATIVE_CAPABILITY_DECLARATION_CHANGED")
})

it("cannot expose a disallowed declared skill through another directory alias", async () => {
  const f = fixture()
  symlinkSync(
    join(f.root, "skills/project"),
    join(f.root, "alias"),
    process.platform === "win32" ? "junction" : "dir"
  )
  const policy = await readNativeSkillUsagePolicy(f.plugins, () => ({
    usage: "chat",
    assertCurrent() {
      return undefined
    }
  }))
  expect(policy!.allowsSkill(join(f.root, "alias/SKILL.md"))).toBe(false)
})

it("omits disabled old skills from implicit/all projection but still rejects an explicit disabled pin", async () => {
  const f = fixture()
  const legacy = (await listClawSkillSources(f.access)).find((item) => item.name === "legacy")!
  f.access.disabledDirs = () => [join(f.root, "skills/legacy")]
  const policy = await readNativeSkillUsagePolicy(f.plugins, () => ({
    usage: "chat",
    assertCurrent() {
      return undefined
    }
  }))
  for (const selection of [undefined, { mode: "all" as const, items: [] }]) {
    const selected = await createClawSkillPolicy(selection, f.access, undefined, policy)
    expect(selected!.skillPaths.map((path) => path.split(/[\\/]/).at(-2)).sort()).toEqual([
      "chat",
      "universal"
    ])
  }
  await expect(
    createClawSkillPolicy({ mode: "selected", items: [legacy] }, f.access, undefined, policy)
  ).rejects.toThrow("CLAW_SKILL_DISABLED")
})

it("blocks a project flow's stage skills in chat even without separate skill declarations", async () => {
  const f = fixture(false)
  writeFileSync(
    join(f.root, "devclaw.capabilities.json"),
    JSON.stringify({
      apiVersion: "devclaw.capabilities/v1",
      capabilities: [
        {
          id: "flow",
          title: "Flow",
          kind: "flow",
          usage: "project",
          entry: "devclaw.project-runtime.json"
        }
      ]
    })
  )
  const manifest = {
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: "fixture", version: "1" },
    mode: "host",
    stateOwner: "host",
    stages: [
      {
        id: "review",
        title: "Review",
        actionIds: [],
        artifactIds: ["report"],
        checkIds: ["report-exists"],
        approval: "none",
        skill: "skills/project/SKILL.md"
      }
    ],
    actions: [],
    artifacts: [{ id: "report", path: "report.md", required: true }],
    checks: [
      { id: "report-exists", kind: "file-exists", artifactId: "report", sideEffect: "read" }
    ],
    environment: [],
    capabilities: {
      execution: true,
      conditionalTransition: true,
      idempotency: true,
      reconciliation: false,
      cancellation: true
    }
  }
  writeFileSync(join(f.root, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  const chat = await readNativeSkillUsagePolicy(f.plugins, () => ({
    usage: "chat",
    assertCurrent() {
      return undefined
    }
  }))
  expect(chat!.allowsSkill(join(f.root, "skills/project/SKILL.md"))).toBe(false)
  expect(chat!.allowsSkill(join(f.root, "skills/legacy/SKILL.md"))).toBe(true)
  const project = await readNativeSkillUsagePolicy(f.plugins, () => ({
    usage: "project",
    assertCurrent() {
      return undefined
    }
  }))
  expect(project!.allowsSkill(join(f.root, "skills/project/SKILL.md"))).toBe(true)
  writeFileSync(join(f.root, "devclaw.project-runtime.json"), "invalid")
  expect(() => chat!.assertCurrent()).toThrow("NATIVE_CAPABILITY_DECLARATION_CHANGED")
  await expect(
    readNativeSkillUsagePolicy(f.plugins, () => ({
      usage: "chat",
      assertCurrent() {
        return undefined
      }
    }))
  ).rejects.toThrow()
  const discovered = await readNativeSkillUsagePolicy(
    f.plugins,
    () => ({
      usage: "chat",
      assertCurrent() {}
    }),
    undefined,
    {}
  )
  expect(discovered!.allowsSkill(join(f.root, "skills/legacy/SKILL.md"))).toBe(false)
  expect(() => discovered!.assertCurrent()).not.toThrow()
})
