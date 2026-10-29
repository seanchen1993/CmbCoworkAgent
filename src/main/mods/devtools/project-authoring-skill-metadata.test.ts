import { dirname, join, resolve } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { readProjectSource } from "./project-source"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { inspectProjectSource } from "./project-doctor"
import {
  assertProjectAuthoringSkillMetadata,
  ProjectAuthoringSkillMetadataError,
  projectAuthoringSkillDiagnostics
} from "./project-authoring-skill-metadata"
import { compileNativeComposition } from "../../plugins/native-composition"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { assertHostPackageSupported } from "../../harness-board/project-runtime/package-preflight"
import { readHostPackageSkill } from "../../harness-board/project-runtime/package-skill-content"
import { discoverSkillsSync } from "../../skills/discovery"
import type { DevelopmentScope } from "../v2/development-session"

const roots = new Set<string>()
const scope: DevelopmentScope = {
  threadId: "new-author-skill-metadata",
  workspace: "isolated-workspace",
  incarnation: { token: "current", legacyCreatedAt: 1 }
}
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})

async function vendorSource(header?: string) {
  const original = await readProjectSource(resolve("tests/fixtures/native-compositions/vendor"))
  return createAuthoringSourceBundle(
    original.bundle.files.map((file) =>
      file.path === "modules/normalize/SKILL.md" && header !== undefined
        ? { ...file, text: `---\n${header}\n---\n\nPRIVATE_BUSINESS_INSTRUCTION` }
        : file
    )
  )
}

async function compiledVendor(header?: string) {
  const source = await vendorSource(header)
  const native = JSON.parse(
    source.files.find((file) => file.path === "composition/source.json")!.text
  )
  const compiled = compileNativeComposition(native, {
    files: source.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) })),
    actionCatalog: []
  })
  return createAuthoringSourceBundle(
    compiled.files.map((file) => ({ path: file.path, text: file.bytes.toString("utf8") }))
  )
}

async function historicalFixture() {
  const root = await mkdtemp(join(tmpdir(), "creator-skill-history-"))
  roots.add(root)
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key: string, expected: string | undefined, value: string) => {
      if (values.get(key) !== expected) return false
      values.set(key, value)
      return true
    }
  }
  const make = () => {
    const sessions = new ProjectAuthoringSessions(async () => [])
    sessions.configurePersistence(settings, join(root, "sources"))
    return sessions
  }
  const retained = await compiledVendor("name: vendor-normalize")
  const draft = await make().save(
    scope,
    {
      id: "retained-host",
      name: "Retained Host",
      revision: 0,
      files: retained.files
    },
    () => {}
  )
  const key = `project-authoring-trial-request:${createHash("sha256")
    .update(JSON.stringify([scope.threadId, scope.workspace, scope.incarnation]))
    .digest("hex")}`
  // An older main process persisted this exact request. No caller-supplied recovery flag exists.
  const request = {
    id: "aabbea8a-2524-4232-8583-205f953a11c0",
    draftId: draft.id,
    revision: draft.revision,
    digest: retained.digest,
    goal: "Recheck retained preview",
    origin: {
      kind: "business-assembly" as const,
      planId: "c05a8904-4610-4293-8c47-a2f1bf873903",
      copyId: "4aa2b130-13b8-47e4-bc94-125aac7a220c",
      digest: "a".repeat(64)
    }
  }
  values.set(key, JSON.stringify(request))
  return { retained, draft, request, key, values, make }
}

describe("new creator Skill metadata diagnostics", () => {
  it.each([
    ["name: vendor-normalize", "description", "missing"],
    ['name: vendor-normalize\ndescription: "   "', "description", "empty"],
    ["name: vendor-normalize\ndescription: 73", "description", "not-string"],
    ["name: vendor-normalize\ndescription: {token: PRIVATE_VALUE}", "description", "not-string"],
    ["name: vendor-normalize\ndescription: false", "description", "not-string"],
    ["name: vendor-normalize\ndescription: null", "description", "not-string"],
    ["name: 73\ndescription: Real purpose", "name", "not-string"],
    ['name: ""\ndescription: Real purpose', "name", "empty"],
    ["name: vendor-normalize\nDescription: PRIVATE_VALUE", "description", "missing"]
  ])("locates %s without returning its YAML values", async (header, field, reason) => {
    const source = await vendorSource(header)
    const before = source.digest
    const diagnostics = projectAuthoringSkillDiagnostics(source)
    expect(diagnostics).toMatchObject([
      {
        code: "PROJECT_SKILL_FRONTMATTER",
        path: "modules/normalize/SKILL.md",
        declarationPath: "/modules/0/skill",
        field,
        reason
      }
    ])
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_")
    expect(() => assertProjectAuthoringSkillMetadata(source)).toThrow(
      "PROJECT_AUTHORING_SKILL_METADATA_INVALID"
    )
    expect(source.digest).toBe(before)
  })

  it("accepts actual business descriptions and existing identities without directory renaming", async () => {
    const source = await vendorSource()
    expect(projectAuthoringSkillDiagnostics(source)).toEqual([])
    expect(() => assertProjectAuthoringSkillMetadata(source)).not.toThrow()
    const named = await vendorSource(
      'name: vendor-normalize\ndescription: "核对实际供应商资料：保留来源"'
    )
    expect(projectAuthoringSkillDiagnostics(named)).toEqual([])
  })

  it("bounds metadata diagnostics and does not impose the new native rule on ordinary Skills", async () => {
    const source = await vendorSource()
    const native = JSON.parse(
      source.files.find((file) => file.path === "composition/source.json")!.text
    )
    native.modules = Array.from({ length: 20 }, (_, index) => ({
      ...native.modules[0],
      id: `stage-${index}`,
      skill: `modules/stage-${index}/SKILL.md`
    }))
    const modified = createAuthoringSourceBundle([
      { path: "composition/source.json", text: JSON.stringify(native) },
      ...native.modules.map((module: { skill: string }) => ({
        path: module.skill,
        text: "---\nother: PRIVATE_VALUE\n---\nPRIVATE_BODY"
      }))
    ])
    const diagnostics = projectAuthoringSkillDiagnostics(modified)
    expect(diagnostics).toHaveLength(16)
    expect(Object.isFrozen(diagnostics)).toBe(true)
    expect(diagnostics.every(Object.isFrozen)).toBe(true)
    expect(
      Object.getOwnPropertyDescriptor(
        new ProjectAuthoringSkillMetadataError(modified),
        "diagnostics"
      )
    ).toMatchObject({ writable: false, configurable: false })
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_")
    expect(
      projectAuthoringSkillDiagnostics(
        createAuthoringSourceBundle([
          { path: "plugin.json", text: '{"name":"ordinary","version":"1.0.0"}' },
          {
            path: "skills/ordinary/SKILL.md",
            text: "---\nname: ordinary\n---\nLegacy ordinary Skill"
          }
        ])
      )
    ).toEqual([])
  })

  it("preserves the source bundle rejection of untrusted non-ASCII paths", async () => {
    const source = await vendorSource("name: vendor-normalize")
    const native = JSON.parse(
      source.files.find((file) => file.path === "composition/source.json")!.text
    )
    native.modules[0].skill = "modules/未可信路径/SKILL.md"
    expect(() =>
      createAuthoringSourceBundle(
        source.files.map((file) =>
          file.path === "composition/source.json"
            ? { ...file, text: JSON.stringify(native) }
            : file.path === "modules/normalize/SKILL.md"
              ? { ...file, path: native.modules[0].skill }
              : file
        )
      )
    ).toThrow("AUTHORING_SOURCE_PATH")
  })

  it("rejects new author compilation without advancing the draft and returns the same doctor location", async () => {
    const source = await vendorSource("name: vendor-normalize")
    const sessions = new ProjectAuthoringSessions(async () => [])
    const draft = await sessions.save(
      scope,
      {
        id: "new-author",
        name: "New source",
        revision: 0,
        files: source.files
      },
      () => {}
    )
    roots.add(dirname(draft.directory))
    await expect(sessions.compile(scope, draft.id, draft.revision, () => {})).rejects.toMatchObject(
      {
        message: "PROJECT_AUTHORING_SKILL_METADATA_INVALID",
        diagnostics: [
          { path: "modules/normalize/SKILL.md", field: "description", reason: "missing" }
        ]
      }
    )
    expect(sessions.read(scope, draft.id).revision).toBe(draft.revision)
    expect(sessions.read(scope, draft.id).source.digest).toBe(draft.source.digest)
    expect(
      await sessions.inspect(scope, draft.id, draft.revision, "doctor", () => {})
    ).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          path: "modules/normalize/SKILL.md",
          field: "description",
          reason: "missing"
        })
      ])
    })
  })

  it("compiles and doctors an independent valid vendor fixture through the real creator boundary", async () => {
    const source = await vendorSource()
    const sessions = new ProjectAuthoringSessions(async () => [])
    const draft = await sessions.save(
      scope,
      {
        id: "vendor-valid",
        name: "Independent vendor",
        revision: 0,
        files: source.files
      },
      () => {}
    )
    roots.add(dirname(draft.directory))
    const compiled = await sessions.compile(scope, draft.id, draft.revision, () => {})
    expect(compiled).toMatchObject({
      revision: 2,
      validation: {
        doctor: { valid: true },
        tests: { valid: true },
        businessActionsExecuted: false
      }
    })
    expect(
      await sessions.inspect(scope, draft.id, compiled.revision, "doctor", () => {})
    ).toMatchObject({ valid: true })
  })

  it("rejects a fresh name-only compiled candidate without compile/doctor via every preparation entry", async () => {
    const source = await compiledVendor("name: vendor-normalize")
    expect(inspectProjectSource(source).report.valid).toBe(true)
    const sessions = new ProjectAuthoringSessions(async () => [])
    const draft = await sessions.save(
      scope,
      {
        id: "bypass",
        name: "New candidate",
        revision: 0,
        files: source.files
      },
      () => {}
    )
    roots.add(dirname(draft.directory))
    await expect(
      sessions.requestTrial(scope, draft.id, draft.revision, "A new goal", () => {})
    ).rejects.toThrow("PROJECT_AUTHORING_SKILL_METADATA_INVALID")
    for (const action of ["dev", "pack", "test"] as const)
      await expect(
        sessions.inspect(scope, draft.id, draft.revision, action, () => {})
      ).rejects.toThrow("PROJECT_AUTHORING_SKILL_METADATA_INVALID")
    expect(sessions.developmentStatus(scope, draft.id)).toBeUndefined()
    expect(sessions.trialRequest(scope)).toBeUndefined()
    expect(sessions.read(scope, draft.id).source.digest).toBe(source.digest)
  })

  it("saves an invalid new revision for repair while preserving the old running package and lease", async () => {
    const valid = await compiledVendor()
    const sessions = new ProjectAuthoringSessions(async () => [])
    const draft = await sessions.save(
      scope,
      {
        id: "leased",
        name: "Running package",
        revision: 0,
        files: valid.files
      },
      () => {}
    )
    roots.add(dirname(draft.directory))
    await sessions.inspect(scope, draft.id, draft.revision, "dev", () => {})
    const lease = sessions.acquireDevelopment(scope, draft.id, draft.revision, () => {})
    const original = structuredClone(lease.snapshot)
    try {
      const invalid = await compiledVendor("name: vendor-normalize")
      const saved = await sessions.save(
        scope,
        {
          id: draft.id,
          name: draft.name,
          revision: draft.revision,
          files: invalid.files
        },
        () => {}
      )
      expect(saved).toMatchObject({
        revision: 2,
        source: { digest: invalid.digest },
        development: {
          currentRevision: 1,
          currentDigest: valid.digest,
          pendingRevision: null,
          activeRuns: 1,
          updateState: "blocked",
          diagnostics: ["PROJECT_AUTHORING_SKILL_METADATA_INVALID"]
        }
      })
      expect(lease.snapshot).toEqual(original)
      expect((await readProjectSource(lease.snapshot.packagePath)).bundle.digest).toBe(valid.digest)
      await expect(
        sessions.requestTrial(scope, draft.id, saved.revision, "New revision", () => {})
      ).rejects.toThrow("PROJECT_AUTHORING_SKILL_METADATA_INVALID")
      await expect(
        sessions.inspect(scope, draft.id, saved.revision, "dev", () => {})
      ).rejects.toThrow("PROJECT_AUTHORING_SKILL_METADATA_INVALID")
      expect(sessions.trialRequest(scope)).toBeUndefined()
    } finally {
      lease.release()
    }
    expect(sessions.developmentStatus(scope, draft.id)).toMatchObject({
      currentRevision: 1,
      currentDigest: valid.digest,
      pendingRevision: null,
      activeRuns: 0,
      updateState: "blocked"
    })
  })

  it.each(["digest", "goal", "origin"] as const)(
    "does not borrow historical preparation for a changed %s",
    async (field) => {
      const f = await historicalFixture()
      if (field === "digest")
        f.values.set(f.key, JSON.stringify({ ...f.request, digest: "f".repeat(64) }))
      const sessions = f.make()
      if (field === "goal")
        await sessions.inspect(scope, f.draft.id, f.draft.revision, "dev", () => {})
      const before = sessions.developmentStatus(scope, f.draft.id)
      await expect(
        sessions.requestTrial(
          scope,
          f.draft.id,
          f.draft.revision,
          field === "goal" ? "Different user goal" : f.request.goal,
          () => {},
          [],
          field === "origin" ? { ...f.request.origin, digest: "f".repeat(64) } : f.request.origin
        )
      ).rejects.toThrow("PROJECT_AUTHORING_SKILL_METADATA_INVALID")
      expect(sessions.developmentStatus(scope, f.draft.id)).toEqual(before)
      expect(sessions.read(scope, f.draft.id).source.digest).toBe(f.retained.digest)
    }
  )

  it("retains name-only Host package reproduction, preflight, exact-path discovery and preview recovery", async () => {
    const f = await historicalFixture()
    const { retained, draft } = f
    expect(inspectProjectSource(retained).report.valid).toBe(true)
    const sessions = f.make()
    expect(sessions.trialRequest(scope)).toMatchObject(f.request)
    expect(sessions.developmentStatus(scope, draft.id)).toBeUndefined()
    const request = await sessions.requestTrial(
      scope,
      draft.id,
      draft.revision,
      f.request.goal,
      () => {},
      [],
      f.request.origin
    )
    expect(request).toMatchObject({ phase: "needs-approval", executed: false })
    const lease = sessions.acquireDevelopment(scope, draft.id, draft.revision, () => {})
    try {
      const manifest = parseProjectRuntimeManifest(
        JSON.parse(
          retained.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
        )
      )
      expect(() => assertHostPackageSupported(lease.snapshot.packagePath, manifest)).not.toThrow()
      const skill = manifest.stages[0].skill!
      expect(discoverSkillsSync(join(lease.snapshot.packagePath, "skills"))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            skillMdPath: join(lease.snapshot.packagePath, skill),
            name: "vendor-normalize"
          })
        ])
      )
      expect(readHostPackageSkill(lease.snapshot.packagePath, skill).toString("utf8")).toBe(
        retained.files.find((file) => file.path === skill)!.text
      )
      expect(sessions.read(scope, draft.id).source.digest).toBe(retained.digest)
    } finally {
      lease.release()
    }
    const restored = f.make()
    expect(restored.developmentStatus(scope, draft.id)).toBeUndefined()
    expect(await restored.inspect(scope, draft.id, draft.revision, "dev", () => {})).toMatchObject({
      currentDigest: retained.digest,
      activeRuns: 0,
      executed: false
    })
    expect(
      await restored.inspect(scope, draft.id, draft.revision, "doctor", () => {})
    ).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "PROJECT_SKILL_FRONTMATTER", field: "description" })
      ])
    })
  })
})
