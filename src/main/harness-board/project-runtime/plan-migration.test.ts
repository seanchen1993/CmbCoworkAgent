import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HostProjectService, type HostProjectServiceDependencies } from "./host-service"
import { HostProjectStore } from "./host-store"
import { HostPackageSnapshots } from "./package-snapshots"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { compileNativeComposition } from "../../plugins/native-composition"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { inspectHostPlanMigration } from "./plan-migration"
import { dirname } from "node:path"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import { createAuthoringSourceBundle } from "../../mods/devtools/authoring-bundle"
import { inspectProjectSource } from "../../mods/devtools/project-doctor"

const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
)
async function fixture(
  options: { stageContext?: boolean; optionalApproval?: boolean; retainedHook?: boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "host-plan-migration-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace"),
    plugin = join(root, "plugin")
  mkdirSync(workspace)
  mkdirSync(plugin)
  const manifest = hostProjectFixture(workspace).manifest
  if (options.optionalApproval) {
    manifest.stages[0].resultApproval = "human"
    manifest.stages[0].artifactIds.push("notes")
    manifest.artifacts.push({ id: "notes", path: "notes.md", required: false })
  }
  const save = () => {
    writeFileSync(
      join(plugin, "plugin.json"),
      JSON.stringify({ name: "docs", version: manifest.plugin.version })
    )
    writeFileSync(join(plugin, "devclaw.project-runtime.json"), JSON.stringify(manifest))
    for (const stage of manifest.stages) {
      mkdirSync(join(plugin, "skills", stage.id), { recursive: true })
      writeFileSync(join(plugin, stage.skill!), `---\nname: ${stage.id}\n---\nProduce ${stage.id}`)
    }
  }
  save()
  if (options.retainedHook) {
    mkdirSync(join(plugin, "hooks"))
    writeFileSync(
      join(plugin, "hooks/hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "python hooks/inspect.py", fallback: "block" }] }
          ]
        }
      })
    )
    writeFileSync(join(plugin, "hooks/inspect.py"), "# retained original tool inspection\n")
  }
  const database = join(root, "state.sqlite")
  const store = new HostProjectStore(database)
  cleanup.push(() => store.close())
  let permitted = true
  const service = new HostProjectService(store, new HostPackageSnapshots(join(root, "snapshots")), {
    resolveInstalledPlugin: async () => ({
      installedPluginId: "installed",
      root: plugin,
      packageId: "docs",
      packageVersion: manifest.plugin.version,
      enabled: permitted
    }),
    authorize: async () => {},
    ...(options.stageContext
      ? { inputIdentity: (project) => String(project.stageIndex).repeat(64) }
      : {}),
    authorizePlanMigration: async () => ({
      assertCurrent: () => {
        if (!permitted) throw Error("revoked")
      }
    }),
    executeSkill: async () => {
      writeFileSync(join(workspace, "document.md"), "Approved draft")
      if (options.optionalApproval) writeFileSync(join(workspace, "notes.md"), "Approved notes")
      return "succeeded"
    }
  })
  await service.localCreate({
    projectId: "project",
    name: "Task",
    goal: "Write",
    workspace,
    installedPluginId: "installed"
  })
  const op = service.prepare({ projectId: "project", expectedVersion: 1, idempotencyKey: "draft" })
  await service.start(op.operationId)
  if (options.optionalApproval)
    service.decideResultApproval(op.operationId, {
      ...service.resultReview(op.operationId),
      decision: "approved",
      actorId: "desktop-user"
    })
  service.transition(op.operationId)
  const insert = () => {
    manifest.plugin.version = "1.1.0"
    manifest.stages.splice(1, 0, {
      ...structuredClone(manifest.stages[1]),
      id: "normalize",
      title: "Normalize",
      skill: "skills/normalize/SKILL.md",
      approval: "none"
    })
    save()
  }
  return {
    root,
    workspace,
    plugin,
    manifest,
    save,
    store,
    database,
    service,
    insert,
    op,
    revoke: () => {
      permitted = false
    }
  }
}

describe("stable native plan migration", () => {
  it.each(["destroyed", "replaced"])("does not commit migration when its desktop window is %s during input preparation", async change => {
    const f = await fixture()
    f.insert()
    const review = await f.service.reviewPlanMigration("project", 2)
    const before = f.service.get("project")
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    let pending = true
    const deps = (f.service as unknown as { deps: HostProjectServiceDependencies }).deps
    deps.prepareInputIdentity = async () => {
      if (!pending) return
      pending = false
      entered()
      await new Promise<void>(resolve => { release = resolve })
    }
    const owner = { destroyed: false }
    let mainWindow = owner
    const running = f.service.migratePlan(review, () => {
      if (mainWindow !== owner || owner.destroyed) throw Error("WINDOW_REVOKED")
    })
    await waiting
    if (change === "destroyed") owner.destroyed = true
    else mainWindow = { destroyed: false }
    release()
    await expect(running).rejects.toThrow("WINDOW_REVOKED")
    expect(f.service.get("project")).toEqual(before)
  })

  it("keeps exact settled Hooks during future migration but rejects any script or declaration change", async () => {
    const f = await fixture({ retainedHook: true })
    f.insert()
    const review = await f.service.reviewPlanMigration("project", 2)
    writeFileSync(join(f.plugin, "hooks/inspect.py"), "# changed rule\n")
    await expect(f.service.reviewPlanMigration("project", 2)).rejects.toThrow(
      "SHARED_RESOURCE_CHANGED"
    )
    writeFileSync(join(f.plugin, "hooks/inspect.py"), "# retained original tool inspection\n")
    const declaration = readFileSync(join(f.plugin, "hooks/hooks.json"))
    writeFileSync(join(f.plugin, "hooks/hooks.json"), "{}")
    await expect(f.service.reviewPlanMigration("project", 2)).rejects.toThrow(
      "SHARED_RESOURCE_CHANGED"
    )
    writeFileSync(join(f.plugin, "hooks/hooks.json"), declaration)
    expect((await f.service.migratePlan(review)).stageIndex).toBe(1)
    expect(f.store.getOperation(f.op.operationId)?.status).toBe("transitioned")
  })
  it.each([false, true])("preserves completed business bindings while recompiling future native checks (pretty=%s)", legacyGeneratedPretty => {
    const root = mkdtempSync(join(tmpdir(), "native-action-migration-"))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const descriptor: ClawActionDescriptor = {
      pluginId: "installed-checker",
      plugin: "checker",
      digest: "c".repeat(64),
      actionId: "verify",
      name: "Verify",
      platform: { id: "documents", version: "1.0.0", action: "verify" },
      inputSchema: { type: "object" },
      configSchema: { type: "object", properties: { strict: { type: "boolean" } } },
      outputSchema: { type: "object" }
    }
    const module = (id: string, strict = true) => ({
      id,
      version: "1.0.0",
      title: id,
      skill: `modules/${id}/SKILL.md`,
      inputs: [],
      outputs: [{ id, path: `${id}.json`, contract: "document/v1" }],
      checks: [
        {
          id: `${id}-business`,
          kind: "action",
          artifactId: id,
          format: "json",
          provider: { plugin: "checker", actionId: "verify" },
          config: { strict }
        }
      ]
    })
    const source = {
      apiVersion: "devclaw.native-composition/v1",
      plugin: { id: "docs", version: "1.0.0", title: "Docs", description: "Documents" },
      resources: [],
      environment: [],
      modules: [module("draft"), module("review")]
    }
    const save = (folder: string, input: typeof source, pretty = false) => {
      const compiled = compileNativeComposition(input, {
        actionCatalog: [descriptor],
        legacyGeneratedPretty: pretty,
        files: input.modules.map((item) => ({
          path: item.skill,
          bytes: Buffer.from(`---\nname: ${item.id}\n---\nWrite ${item.id}`)
        }))
      })
      for (const file of compiled.files) {
        mkdirSync(dirname(join(folder, file.path)), { recursive: true })
        writeFileSync(join(folder, file.path), file.bytes)
      }
      return parseProjectRuntimeManifest(compiled.runtime)
    }
    const original = join(root, "original"),
      revised = join(root, "revised")
    const manifest = save(original, source, legacyGeneratedPretty)
    const candidateSource = {
      ...source,
      plugin: { ...source.plugin, version: "1.1.0" },
      modules: [source.modules[0], module("normalize"), module("review", false)]
    }
    const candidate = save(revised, candidateSource)
    const state = {
      ...hostProjectFixture(root),
      manifest,
      schemaVersion: 1 as const,
      stateOwner: "host" as const,
      version: 2,
      stageIndex: 1,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 2
    }
    expect(inspectHostPlanMigration(state, candidate, original, revised).remainingStageIds).toEqual(
      ["normalize", "review"]
    )
    const changedPast = save(revised, {
      ...candidateSource,
      modules: [module("draft", false), ...candidateSource.modules.slice(1)]
    })
    expect(() => inspectHostPlanMigration(state, changedPast, original, revised)).toThrow(
      "COMPLETED_ACTION_CHANGED"
    )
    save(revised, candidateSource)
    writeFileSync(join(revised, "modules/review/SKILL.md"), "not recompiled")
    expect(() => inspectHostPlanMigration(state, candidate, original, revised)).toThrow(
      "AUTHOR_SOURCE_INVALID"
    )
  })
  it.each([false, true])("permits verified native future author Skills but rejects hand-edited generated projections (pretty=%s)", legacyGeneratedPretty => {
    const root = mkdtempSync(join(tmpdir(), "native-plan-source-"))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const module = (id: string) => ({
      id,
      version: "1.0.0",
      title: id,
      skill: `modules/${id}/SKILL.md`,
      inputs: [],
      outputs: [{ id, path: `${id}.json`, contract: "document/v1" }],
      checks: [
        { id: `${id}-schema`, kind: "json-schema", artifactId: id, schema: { type: "object" } }
      ]
    })
    const source = {
      apiVersion: "devclaw.native-composition/v1",
      plugin: { id: "docs", version: "1.0.0", title: "Docs", description: "Documents" },
      resources: [],
      environment: [],
      modules: [module("draft"), module("review")]
    }
    const save = (folder: string, input: typeof source, pretty = false) => {
      const compiled = compileNativeComposition(input, {
        actionCatalog: [],
        legacyGeneratedPretty: pretty,
        files: input.modules.map((item) => ({
          path: item.skill,
          bytes: Buffer.from(`---\nname: ${item.id}\n---\nWrite ${item.id}`)
        }))
      })
      for (const file of compiled.files) {
        mkdirSync(dirname(join(folder, file.path)), { recursive: true })
        writeFileSync(join(folder, file.path), file.bytes)
      }
      return parseProjectRuntimeManifest(compiled.runtime)
    }
    const original = join(root, "original"),
      revised = join(root, "revised")
    const manifest = save(original, source, legacyGeneratedPretty)
    const candidateSource = {
      ...source,
      plugin: { ...source.plugin, version: "1.1.0" },
      modules: [source.modules[0], module("normalize"), source.modules[1]]
    }
    const candidate = save(revised, candidateSource, legacyGeneratedPretty)
    const state = {
      ...hostProjectFixture(root),
      manifest,
      schemaVersion: 1 as const,
      stateOwner: "host" as const,
      version: 2,
      stageIndex: 1,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 2
    }
    expect(inspectHostPlanMigration(state, candidate, original, revised).remainingStageIds).toEqual(
      ["normalize", "review"]
    )
    save(revised, candidateSource)
    expect(inspectHostPlanMigration(state, candidate, original, revised).remainingStageIds)
      .toEqual(["normalize", "review"])
    for (const path of ["plugin.json", "composition/lock.json", "devclaw.project-runtime.json", "devclaw.project-actions.lock.json"]) {
      const file = join(revised, path)
      const text = readFileSync(file, "utf8")
      writeFileSync(file, JSON.stringify(JSON.parse(text), null, 2) + "\n")
      expect(() => inspectHostPlanMigration(state, candidate, original, revised))
        .toThrow("AUTHOR_SOURCE_INVALID")
      writeFileSync(file, text)
    }
    const actionLock = join(revised, "devclaw.project-actions.lock.json")
    const canonical = readFileSync(actionLock, "utf8")
    writeFileSync(actionLock, canonical + "\n")
    expect(() => inspectHostPlanMigration(state, candidate, original, revised))
      .toThrow("AUTHOR_SOURCE_INVALID")
    writeFileSync(actionLock, canonical)
    writeFileSync(join(revised, "modules/review/SKILL.md"), "Changed without compiling")
    expect(() => inspectHostPlanMigration(state, candidate, original, revised)).toThrow(
      "AUTHOR_SOURCE_INVALID"
    )
  })
  it("revalidates the actual historical stage context rather than the next stage context", async () => {
    const f = await fixture({ stageContext: true })
    f.insert()
    const review = await f.service.reviewPlanMigration("project", 2)
    expect((await f.service.migratePlan(review)).stageIndex).toBe(1)
  })

  it.each(["all-preceding", "mixed"])(
    "replays real pre-projection inputs without upgrading completed stages (%s)",
    (layout) => {
      const root = mkdtempSync(join(tmpdir(), "native-legacy-input-migration-"))
      cleanup.push(() => rmSync(root, { recursive: true, force: true }))
      const module = (
        id: string,
        inputs: Array<{ artifactId: string; contract: string }> = []
      ) => ({
        id,
        version: "1.0.0",
        title: id,
        skill: `modules/${id}/SKILL.md`,
        inputs,
        outputs: [{ id, path: `${id}.json`, contract: "document/v1" }],
        checks: [
          {
            id: `${id}-shape`,
            kind: "json-schema",
            artifactId: id,
            schema: { type: "object", required: [] as string[] }
          }
        ]
      })
      const source = {
        apiVersion: "devclaw.native-composition/v1",
        plugin: { id: "docs", version: "1.0.0", title: "Docs", description: "Documents" },
        resources: ["tests/project-contract.json"],
        environment: [],
        modules: [
          module("draft"),
          module("review"),
          module("finish", [{ artifactId: "review", contract: "document/v1" }])
        ]
      }
      const save = (
        folder: string,
        input: typeof source,
        options: {
          legacyStages?: ReadonlySet<string>
          pretty?: boolean
          skillContents?: Record<string, string>
        } = {}
      ) => {
        const compiled = compileNativeComposition(input, {
          actionCatalog: [],
          legacyGeneratedPretty: options.pretty,
          legacyInputArtifactStages: options.legacyStages,
          files: [
            ...input.modules.map((item) => ({
              path: item.skill,
              bytes: Buffer.from(
                `---\nname: ${item.id}\n---\n${options.skillContents?.[item.id] ?? `Write ${item.id}`}`
              )
            })),
            {
              path: "tests/project-contract.json",
              bytes: Buffer.from(
                JSON.stringify({
                  apiVersion: "devclaw.project-contract/v1",
                  cases: [
                    { id: "missing-draft", stageId: "draft", files: [], expected: "failed" },
                    {
                      id: "valid-draft",
                      stageId: "draft",
                      files: [{ path: "draft.json", text: "{}" }],
                      expected: "passed"
                    }
                  ]
                })
              )
            }
          ]
        })
        for (const file of compiled.files) {
          mkdirSync(dirname(join(folder, file.path)), { recursive: true })
          writeFileSync(join(folder, file.path), file.bytes)
        }
        return { compiled, manifest: parseProjectRuntimeManifest(compiled.runtime) }
      }
      const original = join(root, "original"),
        revised = join(root, "revised")
      const old = save(original, source, {
        pretty: true,
        legacyStages: new Set(
          layout === "all-preceding" ? source.modules.map((item) => item.id) : ["review"]
        )
      })
      // This is the actual old projection: the source declares a subset while runtime uses all prior inputs.
      expect(source.modules[1].inputs).toEqual([])
      expect(old.manifest.stages[1].inputArtifactIds).toBeUndefined()
      if (layout === "mixed") expect(old.manifest.stages[2].inputArtifactIds).toEqual(["review"])
      else expect(old.manifest.stages[2].inputArtifactIds).toBeUndefined()
      const oldBundle = createAuthoringSourceBundle(
        old.compiled.files.map((file) => ({
          path: file.path,
          text: file.bytes.toString("utf8")
        }))
      )
      expect(inspectProjectSource(oldBundle).report.diagnostics).toEqual([])
      const candidateSource = {
        ...source,
        plugin: { ...source.plugin, version: "1.1.0" },
        modules: [source.modules[0], source.modules[1], module("normalize"), source.modules[2]]
      }
      const state = {
        ...hostProjectFixture(root),
        manifest: old.manifest,
        status: "active" as const,
        stageIndex: 1
      }
      const completedLegacy = new Set(
        old.manifest.stages
          .slice(0, state.stageIndex)
          .filter((stage) => stage.inputArtifactIds === undefined)
          .map((stage) => stage.id)
      )
      const candidate = save(revised, candidateSource, {
        legacyStages: completedLegacy,
        skillContents: { review: "Update the still-future review" }
      }).manifest
      expect(candidate.stages[1].inputArtifactIds).toEqual([])
      expect(
        inspectHostPlanMigration(state, candidate, original, revised).remainingStageIds
      ).toEqual(["review", "normalize", "finish"])

      const changedCheck = structuredClone(candidateSource)
      changedCheck.modules[0].checks[0].schema.required = ["approved"]
      const changedContract = save(revised, changedCheck, {
        legacyStages: completedLegacy
      }).manifest
      expect(() => inspectHostPlanMigration(state, changedContract, original, revised)).toThrow(
        "COMPLETED_CONTRACT_CHANGED"
      )
      const changedSkill = save(revised, candidateSource, {
        legacyStages: completedLegacy,
        skillContents: { draft: "Changed completed author source" }
      }).manifest
      expect(() => inspectHostPlanMigration(state, changedSkill, original, revised)).toThrow(
        "COMPLETED_SKILL_CHANGED"
      )

      // Once review is completed its old all-preceding runtime contract cannot silently become explicit [].
      const completedReview = { ...state, stageIndex: 2 }
      const upgradedPast = save(revised, candidateSource, {
        legacyStages: completedLegacy
      }).manifest
      expect(() =>
        inspectHostPlanMigration(completedReview, upgradedPast, original, revised)
      ).toThrow("COMPLETED_STAGE_CHANGED")
      const preservedPast = save(revised, candidateSource, {
        legacyStages: new Set([...completedLegacy, "review"])
      }).manifest
      expect(
        inspectHostPlanMigration(completedReview, preservedPast, original, revised)
          .remainingStageIds
      ).toEqual(["normalize", "finish"])
    }
  )

  it("rejects changed approved optional artifacts even when no check references them", async () => {
    const f = await fixture({ optionalApproval: true })
    f.insert()
    const review = await f.service.reviewPlanMigration("project", 2)
    writeFileSync(join(f.workspace, "notes.md"), "Unapproved replacement")
    await expect(f.service.migratePlan(review)).rejects.toThrow("RESULT_APPROVAL_MISMATCH")
    expect(f.store.get("project")?.version).toBe(2)
  })
  it("inserts a future stage without rewriting past operations and survives a cold store read", async () => {
    const f = await fixture()
    const original = f.store.getOperation(f.op.operationId)
    f.insert()
    const review = await f.service.reviewPlanMigration("project", 2)
    expect(review.preservedStageIds).toEqual(["draft"])
    expect(review.remainingStageIds).toEqual(["normalize", "review"])
    const migrated = await f.service.migratePlan(review)
    expect(migrated).toMatchObject({ version: 3, stageIndex: 1, packageVersion: "1.1.0" })
    expect(f.store.getOperation(f.op.operationId)).toEqual(original)
    const cold = new HostProjectStore(f.database)
    try {
      expect(cold.get("project")).toEqual(migrated)
    } finally {
      cold.close()
    }
    const next = f.service.prepare({
      projectId: "project",
      expectedVersion: 3,
      idempotencyKey: "normalize"
    })
    expect(next.stageId).toBe("normalize")
    await expect(f.service.migratePlan(review)).rejects.toThrow("VERSION_CONFLICT")
  })

  it("rejects a changed completed Skill, weakened completed check or shared resources", async () => {
    const f = await fixture()
    f.insert()
    const path = join(f.plugin, "skills/draft/SKILL.md")
    const original = readFileSync(path)
    writeFileSync(path, "---\nname: draft\n---\nChanged past meaning")
    await expect(f.service.reviewPlanMigration("project", 2)).rejects.toThrow(
      "COMPLETED_SKILL_CHANGED"
    )
    writeFileSync(path, original)
    f.manifest.checks[0] = {
      ...f.manifest.checks[0],
      kind: "json-schema",
      schema: { type: "object" }
    }
    f.save()
    await expect(f.service.reviewPlanMigration("project", 2)).rejects.toThrow(
      "COMPLETED_CONTRACT_CHANGED"
    )
  })

  it("rejects stale artifacts, changed target, revoked authority and live operations", async () => {
    const f = await fixture()
    f.insert()
    const review = await f.service.reviewPlanMigration("project", 2)
    writeFileSync(join(f.workspace, "document.md"), "tampered")
    await expect(f.service.migratePlan(review)).rejects.toThrow()
    writeFileSync(join(f.workspace, "document.md"), "Approved draft")
    writeFileSync(
      join(f.plugin, "skills/review/SKILL.md"),
      "---\nname: review\n---\nA different target"
    )
    await expect(f.service.migratePlan(review)).rejects.toThrow("REVIEW_CHANGED")
    f.save()
    f.service.prepare({ projectId: "project", expectedVersion: 2, idempotencyKey: "active" })
    await expect(f.service.reviewPlanMigration("project", 2)).rejects.toThrow(
      "WORKSPACE_OPERATION_ACTIVE"
    )
    f.revoke()
    expect(f.store.get("project")?.version).toBe(2)
  })
})
