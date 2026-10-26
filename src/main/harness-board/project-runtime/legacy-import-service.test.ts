import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { PluginMetadata } from "../../types"
import { HostProjectStore } from "./host-store"
import { HostProjectService, type HostSkillExecutionContext } from "./host-service"
import { HostPackageSnapshots } from "./package-snapshots"
import { LegacyOperationStore } from "./legacy-operation-store"
import { LegacyProjectRuntimeService } from "./legacy-runtime-service"
import { HostLegacyImportService, reviewImportStageEligibility } from "./legacy-import-service"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { assertLegacyProjectEntry } from "./legacy-entry-gate"
import { executeHostProjectStage } from "../project-action-executor"
import { parseHostLegacyImportReceipt } from "./legacy-import-protocol"
import { createProjectActionBinding } from "./action-input"
import { inspectHostProjectExecution } from "./host-execution-inspector"
import { PROJECT_ACTION_LOCK_PATH } from "../../../shared/project-runtime/action-bindings"

const threads = vi.hoisted(() => new Map<string, object>())
const skill = vi.hoisted(() => vi.fn())
vi.mock("../host-skill-executor", () => ({
  executeHostProjectSkill: (...args: unknown[]) => skill(...args)
}))
vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  createThread: (id: string, metadata: object) => {
    const thread = {
      thread_id: id,
      created_at: 1,
      metadata: JSON.stringify({ ...metadata, cmb_thread_incarnation: id })
    }
    threads.set(id, thread)
    return thread
  },
  getThreadCore: (id: string) => threads.get(id)
}))
const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((run) => run())
  threads.clear()
  skill.mockReset()
})

async function fixture() {
  skill.mockImplementation(() => {
    throw Error("Import validation must never invoke a Skill/model")
  })
  const root = mkdtempSync(join(tmpdir(), "legacy-native-import-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const sourceWorkspace = join(root, "old"),
    workspace = join(root, "new")
  const sourcePlugin = join(root, "legacy-plugin"),
    targetPlugin = join(root, "host-plugin")
  for (const path of [sourceWorkspace, workspace, sourcePlugin, targetPlugin]) mkdirSync(path)
  const manifest = hostProjectFixture(workspace).manifest
  manifest.stages[0].resultApproval = "human"
  for (const path of [sourcePlugin, targetPlugin]) {
    writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
    writeFileSync(
      join(path, "devclaw.project-runtime.json"),
      JSON.stringify(
        path === sourcePlugin
          ? {
              ...manifest,
              mode: "legacy",
              stateOwner: "plugin",
              stages: manifest.stages.map((stage) => {
                const legacyStage = { ...stage }
                delete legacyStage.resultApproval
                return legacyStage
              })
            }
          : manifest
      )
    )
    for (const stage of manifest.stages) {
      mkdirSync(join(path, "skills", stage.id), { recursive: true })
      writeFileSync(join(path, stage.skill!), `---\nname: ${stage.id}\n---\nA real retained Skill`)
    }
  }
  writeFileSync(join(sourceWorkspace, "old-document.md"), "Legacy document bytes")
  const legacyPath = join(root, "legacy.sqlite"),
    hostPath = join(root, "host.sqlite")
  const legacyStore = new LegacyOperationStore(legacyPath),
    store = new HostProjectStore(hostPath)
  cleanup.push(
    () => legacyStore.close(),
    () => store.close()
  )
  const plugin = {
    id: "old-install",
    name: "docs",
    version: "1.0.0",
    path: sourcePlugin,
    enabled: true
  } as PluginMetadata
  const legacy = new LegacyProjectRuntimeService(
    legacyStore,
    new HostPackageSnapshots(join(root, "old-snapshots")),
    {
      resolveThread: () => undefined,
      resolvePlugin: async () => plugin,
      assertProjectIdle: () => {},
      assertInstalledSourceCurrent: () => {},
      assertProjectBindingCurrent: () => {}
    }
  )
  cleanup.push(legacy.register())
  await legacy.enable("old-project", sourceWorkspace)
  const execute = vi.fn((context) =>
    executeHostProjectStage(context, {} as BrowserWindow, () => {})
  )
  const host = new HostProjectService(
    store,
    new HostPackageSnapshots(join(root, "host-snapshots")),
    {
      resolveInstalledPlugin: async () => ({
        installedPluginId: "new-install",
        packageId: "docs",
        packageVersion: "1.0.0",
        root: targetPlugin,
        enabled: true
      }),
      authorize: async () => {},
      authorizeStageBranch: async () => ({ assertCurrent: () => {} }),
      authorizePlanMigration: async () => ({ assertCurrent: () => {} }),
      inspectOperation: inspectHostProjectExecution,
      executeSkill: execute
    }
  )
  let safe = true
  const imports = new HostLegacyImportService(legacy, host, {
    authorize: async () => ({
      assertCurrent: () => {
        if (!safe) throw Error("EXTERNAL_RESOURCE_UNKNOWN")
      }
    })
  })
  const input = {
    sourceProjectId: "old-project",
    target: {
      projectId: "new-project",
      name: "Imported",
      workspace,
      installedPluginId: "new-install",
      goal: "Revalidate prior document"
    },
    prefixStageIds: ["draft"],
    artifacts: [{ artifactId: "document", sourcePath: "old-document.md" }]
  }
  return {
    root,
    sourceWorkspace,
    workspace,
    imports,
    input,
    legacy,
    legacyStore,
    legacyPath,
    host,
    store,
    hostPath,
    targetPlugin,
    manifest,
    execute,
    revoke: () => {
      safe = false
    }
  }
}

it("freezes the original writer and runs fresh checks plus a new approval without a model or old success", async () => {
  const f = await fixture()
  const review = await f.imports.review(f.input)
  const project = await f.imports.confirm(review)
  expect(project).toMatchObject({ version: 1, stageIndex: 0 })
  expect(f.host.operations(project.projectId)).toEqual([])
  expect(readFileSync(join(f.sourceWorkspace, "old-document.md"), "utf8")).toBe(
    "Legacy document bytes"
  )
  expect(f.legacy.get("old-project")).toBeDefined()
  expect(() =>
    assertLegacyProjectEntry("old-project", "feature", f.sourceWorkspace, undefined)
  ).toThrow("FROZEN")
  expect(() => f.legacyStore.disable("old-project")).toThrow("FROZEN")
  await expect(
    f.legacy.withBoundSkillSource("old-project", f.sourceWorkspace, async () => {})
  ).rejects.toThrow("FROZEN")
  const cold = new LegacyOperationStore(f.legacyPath)
  try {
    expect(() => cold.assertNotFrozen("old-project")).toThrow("FROZEN")
  } finally {
    cold.close()
  }
  const operation = f.host.prepare({
    projectId: project.projectId,
    expectedVersion: 1,
    idempotencyKey: "import-check"
  })
  expect(() => f.host.start(operation.operationId)).toThrow("REVALIDATION_REQUIRED")
  const result = await f.host.validateImported(operation.operationId)
  expect(result.status).toBe("succeeded")
  expect(result.execution?.terminal?.code).toBe("import_validation_complete")
  expect(f.execute.mock.calls[0][0].importedValidationOnly).toBe(true)
  expect(() => f.host.transition(operation.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
  f.host.decideResultApproval(operation.operationId, {
    ...f.host.resultReview(operation.operationId),
    decision: "approved",
    actorId: "desktop-user"
  })
  expect(f.host.transition(operation.operationId).stageIndex).toBe(1)
  await expect(f.imports.confirm(review)).resolves.toMatchObject({ stageIndex: 1 })
  expect(f.host.importedSource(project.projectId)?.historicalSuccess).toBe("untrusted-source-only")
  const receipt = f.host.importedSource(project.projectId)!
  expect(parseHostLegacyImportReceipt(receipt)).toEqual(receipt)
  const tampered = structuredClone(receipt)
  tampered.review.prefixStageIds = []
  expect(() => parseHostLegacyImportReceipt(tampered)).toThrow("IMPORT_RECEIPT_INVALID")
  tampered.review.prefixStageIds = ["review"]
  expect(() => parseHostLegacyImportReceipt(tampered)).toThrow("IMPORT_RECEIPT_CHANGED")
})

it.each(["source-changed", "resource-unknown", "overlap"])(
  "rejects unsafe import before freezing (%s)",
  async (mode) => {
    const f = await fixture()
    const review = await f.imports.review(f.input)
    if (mode === "source-changed")
      writeFileSync(join(f.sourceWorkspace, "old-document.md"), "changed")
    if (mode === "resource-unknown") f.revoke()
    if (mode === "overlap") review.target.workspace = f.sourceWorkspace
    await expect(f.imports.confirm(review)).rejects.toThrow()
    expect(f.legacyStore.importFreeze("old-project")).toBeUndefined()
    expect(f.host.get("new-project")).toBeUndefined()
  }
)

it("retains the freeze after a copy conflict and refuses to silently reroute a different import", async () => {
  const f = await fixture()
  const review = await f.imports.review(f.input)
  writeFileSync(join(f.workspace, "document.md"), "Unrelated target file")
  await expect(f.imports.confirm(review)).rejects.toThrow("TARGET_FILE_EXISTS")
  expect(f.legacyStore.importFreeze("old-project")?.reviewDigest).toBe(review.reviewDigest)
  const other = await f.imports.review({
    ...f.input,
    target: { ...f.input.target, projectId: "other" }
  })
  await expect(f.imports.confirm(other)).rejects.toThrow("REVIEW_CHANGED")
  expect(readFileSync(join(f.workspace, "document.md"), "utf8")).toBe("Unrelated target file")
  // Removing the unrelated destination is an explicit correction; the same frozen review retries.
  rmSync(join(f.workspace, "document.md"))
  await expect(f.imports.confirm(review)).resolves.toMatchObject({ stageIndex: 0 })
  expect(f.legacyStore.importFreeze("old-project")?.reviewDigest).toBe(review.reviewDigest)
})

it.each(["no-checks", "uncovered-artifact"])(
  "blocks an imported prefix with %s before freeze",
  async (mode) => {
    const f = await fixture()
    if (mode === "no-checks") f.manifest.stages[0].checkIds = []
    else {
      f.manifest.artifacts.push({ id: "unchecked", path: "unchecked.md", required: true })
      f.manifest.stages[0].artifactIds.push("unchecked")
      f.input.artifacts.push({ artifactId: "unchecked", sourcePath: "old-document.md" })
    }
    writeFileSync(join(f.targetPlugin, "devclaw.project-runtime.json"), JSON.stringify(f.manifest))
    const target = await f.host.reviewImportTarget("new-install")
    const eligibility = reviewImportStageEligibility(target.snapshot)
    expect(eligibility[0]).toMatchObject({
      eligible: false,
      reason:
        mode === "no-checks" ? "IMPORT_STAGE_CHECKS_REQUIRED" : "IMPORT_ARTIFACT_CHECK_REQUIRED"
    })
    await expect(f.imports.review(f.input)).rejects.toThrow(eligibility[0].reason)
    expect(f.legacyStore.importFreeze("old-project")).toBeUndefined()
  }
)

async function adaptedFixture(reexecute = false) {
  const f = await fixture()
  delete f.manifest.stages[0].resultApproval
  writeFileSync(join(f.targetPlugin, "devclaw.project-runtime.json"), JSON.stringify(f.manifest))
  writeFileSync(join(f.sourceWorkspace, "state.json"), JSON.stringify({ feature: "draft_done" }))
  const descriptor = {
    protocol: "devclaw.legacy-import-adapter/v1",
    adapters: [
      {
        id: "documents",
        title: "Document conversion",
        sourcePackageIds: ["docs"],
        parameters: [{ id: "feature", label: "Feature" }],
        checkpoint: { sourcePath: "state.json", pointers: [["{feature}"]] },
        stablePoints: [
          {
            value: "draft_done",
            prefixStageIds: ["draft"],
            reexecuteStageIds: reexecute ? ["draft"] : []
          }
        ],
        artifacts: [
          {
            artifactId: "document",
            stageId: "draft",
            fields: { feature: "{feature}" },
            files: [{ sourcePath: "old-document.md", path: "document.md" }],
            trees: []
          }
        ]
      }
    ]
  }
  writeFileSync(join(f.targetPlugin, "devclaw.legacy-import.json"), JSON.stringify(descriptor))
  const input = {
    sourceProjectId: f.input.sourceProjectId,
    target: f.input.target,
    adapterId: "documents",
    parameters: { feature: "feature" }
  }
  return { ...f, adapterInput: input, descriptor }
}

it("converts source bytes into a reviewed bundle and requires a new human decision even when the manifest says none", async () => {
  const f = await adaptedFixture()
  expect(await f.imports.listAdapters("new-install")).toEqual([
    {
      id: "documents",
      title: "Document conversion",
      parameters: [{ id: "feature", label: "Feature" }]
    }
  ])
  const review = await f.imports.reviewAdapter(f.adapterInput)
  expect(review.protocol).toBe("devclaw.host-legacy-import/v2")
  expect(review.adaptation?.checkpoint).toMatchObject({
    sourcePath: "state.json",
    pointer: ["feature"],
    value: "draft_done"
  })
  expect(review.adaptation?.sourceFiles.map((file) => file.sourcePath)).toEqual([
    "old-document.md",
    "state.json"
  ])
  await f.imports.confirm(review)
  expect(JSON.parse(readFileSync(join(f.workspace, "document.md"), "utf8"))).toEqual({
    feature: "feature",
    files: { "document.md": "Legacy document bytes" }
  })
  const operation = f.host.prepare({
    projectId: "new-project",
    expectedVersion: 1,
    idempotencyKey: "adapted"
  })
  expect((await f.host.validateImported(operation.operationId)).status).toBe("succeeded")
  expect(skill).not.toHaveBeenCalled()
  expect(() => f.host.transition(operation.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
  const reviewed = f.host.resultReview(operation.operationId)
  f.host.decideResultApproval(operation.operationId, {
    ...reviewed,
    actorId: "desktop-user",
    decision: "approved"
  })
  expect(f.host.transition(operation.operationId).stageIndex).toBe(1)
  const cold = new HostProjectStore(f.hostPath)
  try {
    expect(cold.importedSource("new-project")?.review).toEqual(review)
  } finally {
    cold.close()
  }
})

it("reexecutes an incompatible stage with the real source archive, fresh validation and a new result approval", async () => {
  const f = await adaptedFixture(true)
  const review = await f.imports.reviewAdapter(f.adapterInput)
  await f.imports.confirm(review)
  skill.mockImplementation(async (context: HostSkillExecutionContext) => {
    expect(context.importedValidationOnly).toBeUndefined()
    expect(context.importedMaterialPath).toBe(".devclaw/import-source.json")
    context.assertInputsCurrent?.()
    const material = JSON.parse(
      readFileSync(join(context.project.workspace, context.importedMaterialPath!), "utf8")
    )
    expect(material.historicalSuccess).toBe("untrusted-source-only")
    expect(material.files["old-document.md"]).toBe("Legacy document bytes")
    context.bindThread("fresh-skill-thread")
    writeFileSync(
      join(context.project.workspace, "document.md"),
      "New output from: " + material.files["old-document.md"]
    )
    context.recordTerminal({ outcome: "success", code: "deterministic-model-fixture" })
    return "succeeded"
  })
  const operation = f.host.prepare({
    projectId: "new-project",
    expectedVersion: 1,
    idempotencyKey: "real-reexecution"
  })
  await expect(f.host.validateImported(operation.operationId)).rejects.toThrow(
    "REEXECUTION_REQUIRED"
  )
  const result = await f.host.start(operation.operationId)
  expect(result.status).toBe("succeeded")
  expect(result.receipts).toEqual([
    expect.objectContaining({ checkId: "document-exists", result: "passed" })
  ])
  expect(skill).toHaveBeenCalledTimes(1)
  expect(() => f.host.transition(operation.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
  f.host.decideResultApproval(operation.operationId, {
    ...f.host.resultReview(operation.operationId),
    actorId: "desktop-user",
    decision: "approved"
  })
  expect(f.host.transition(operation.operationId).stageIndex).toBe(1)
  expect(readFileSync(join(f.sourceWorkspace, "old-document.md"), "utf8")).toBe(
    "Legacy document bytes"
  )
})

it.each(["descriptor", "checkpoint", "new-source", "unknown", "parameters", "revoke"])(
  "rejects changed or untrusted adapter evidence (%s)",
  async (mode) => {
    const f = await adaptedFixture()
    const review = await f.imports.reviewAdapter(f.adapterInput)
    if (mode === "descriptor") {
      f.descriptor.adapters[0].title = "Changed"
      writeFileSync(
        join(f.targetPlugin, "devclaw.legacy-import.json"),
        JSON.stringify(f.descriptor)
      )
    }
    if (mode === "checkpoint")
      writeFileSync(join(f.sourceWorkspace, "state.json"), JSON.stringify({ feature: "running" }))
    if (mode === "new-source")
      writeFileSync(join(f.sourceWorkspace, "old-document.md"), "Changed source")
    if (mode === "unknown") review.adaptation!.checkpoint.value = "fabricated_done"
    if (mode === "parameters") review.adaptation!.parameters.feature = "../escape"
    if (mode === "revoke") f.revoke()
    await expect(f.imports.confirm(review)).rejects.toThrow()
    expect(f.legacyStore.importFreeze("old-project")).toBeUndefined()
  }
)

it("rejects mutated immutable source material before starting a reexecuted Skill", async () => {
  const f = await adaptedFixture(true)
  await f.imports.confirm(await f.imports.reviewAdapter(f.adapterInput))
  const operation = f.host.prepare({
    projectId: "new-project",
    expectedVersion: 1,
    idempotencyKey: "changed-material"
  })
  writeFileSync(join(f.workspace, ".devclaw/import-source.json"), "forged")
  await expect(f.host.start(operation.operationId)).rejects.toThrow(
    "IMPORT_SOURCE_MATERIAL_CHANGED"
  )
  expect(skill).not.toHaveBeenCalled()
})

it("restores the exact reviewed target after a cold partial-copy failure and rechecks source authority", async () => {
  const f = await adaptedFixture()
  const review = await f.imports.reviewAdapter(f.adapterInput)
  writeFileSync(join(f.workspace, "document.md"), "Existing unrelated file")
  await expect(f.imports.confirm(review)).rejects.toThrow("TARGET_FILE_EXISTS")
  const coldStore = new LegacyOperationStore(f.legacyPath)
  try {
    const coldLegacy = new LegacyProjectRuntimeService(
      coldStore,
      new HostPackageSnapshots(join(f.root, "old-snapshots")),
      {
        resolveThread: () => undefined,
        resolvePlugin: async () =>
          ({
            id: "old-install",
            name: "docs",
            version: "1.0.0",
            path: join(f.root, "legacy-plugin"),
            enabled: true
          }) as PluginMetadata,
        assertProjectIdle: () => {},
        assertInstalledSourceCurrent: () => {},
        assertProjectBindingCurrent: () => {}
      }
    )
    const coldImports = new HostLegacyImportService(coldLegacy, f.host, {
      authorize: async () => ({ assertCurrent: () => {} })
    })
    const restored = await coldImports.resumeReview("old-project")
    expect(restored).toEqual(review)
    expect(restored.target.projectId).toBe("new-project")
    writeFileSync(join(f.sourceWorkspace, "old-document.md"), "Changed while closed")
    await expect(coldImports.resumeReview("old-project")).rejects.toThrow("REVIEW_CHANGED")
    writeFileSync(join(f.sourceWorkspace, "old-document.md"), "Legacy document bytes")
    rmSync(join(f.workspace, "document.md"))
    expect(
      (await coldImports.confirm(await coldImports.resumeReview("old-project"))).stageIndex
    ).toBe(0)
    expect(() => coldStore.assertNotFrozen("old-project")).toThrow("FROZEN")
    writeFileSync(
      join(f.sourceWorkspace, "old-document.md"),
      "Old source edited after successful import"
    )
    expect(await coldImports.resumeReview("old-project")).toEqual(review)
    expect((await coldImports.confirm(review)).projectId).toBe("new-project")
  } finally {
    coldStore.close()
  }
})

it("admits declared actions only for genuine reexecution, never for validation-only import", async () => {
  const f = await adaptedFixture(true)
  const binding = createProjectActionBinding(
    "format",
    {
      pluginId: "installed-formatter",
      plugin: "formatter",
      digest: "a".repeat(64),
      actionId: "format",
      name: "Format",
      platform: { id: "formatter", version: "1.0.0", action: "format" },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    },
    {}
  )
  f.manifest.actions = [{ id: binding.id, ref: binding.ref }]
  f.manifest.stages[0].actionIds = [binding.id]
  writeFileSync(join(f.targetPlugin, "devclaw.project-runtime.json"), JSON.stringify(f.manifest))
  writeFileSync(
    join(f.targetPlugin, PROJECT_ACTION_LOCK_PATH),
    JSON.stringify({ apiVersion: "devclaw.project-actions-lock/v1", bindings: [binding] })
  )
  const target = await f.host.reviewImportTarget("new-install")
  expect(reviewImportStageEligibility(target.snapshot)[0].eligible).toBe(false)
  expect(reviewImportStageEligibility(target.snapshot, ["draft"])[0].eligible).toBe(true)
  expect((await f.imports.reviewAdapter(f.adapterInput)).adaptation?.reexecuteStageIds).toEqual([
    "draft"
  ])
  expect(skill).not.toHaveBeenCalled()
})

it("keeps old digest-only freezes closed and reports that their original review cannot be recovered", async () => {
  const f = await fixture()
  f.legacyStore.freezeForImport("old-project", "a".repeat(64), () => {})
  await expect(f.imports.resumeReview("old-project")).rejects.toThrow("IMPORT_REVIEW_NOT_RECORDED")
  expect(() => f.legacyStore.assertNotFrozen("old-project")).toThrow("FROZEN")
})

it("blocks branch and plan-policy escape until every imported prefix result is freshly accepted", async () => {
  const f = await adaptedFixture()
  const project = await f.imports.confirm(await f.imports.reviewAdapter(f.adapterInput))
  const branchWorkspace = join(f.root, "branch")
  mkdirSync(branchWorkspace)
  const branch = {
    baselineId: "reviewed-baseline",
    sourceProjectId: project.projectId,
    expectedSourceVersion: project.version,
    stageId: "draft",
    projectId: "branch-project",
    name: "Branch",
    workspace: branchWorkspace,
    installedPluginId: "new-install",
    goal: project.goal
  }
  await expect(f.host.createBranchAtStage(branch)).rejects.toThrow("IMPORT_REVALIDATION_PENDING")
  const creation = {
    ...hostProjectFixture(branchWorkspace),
    projectId: "db-branch",
    manifest: project.manifest
  }
  expect(() =>
    f.store.createBranch(creation, "draft", { projectId: project.projectId, expectedVersion: 1 })
  ).toThrow("IMPORT_REVALIDATION_PENDING")
  f.manifest.stages[1].id = "renamed-future"
  writeFileSync(join(f.targetPlugin, "devclaw.project-runtime.json"), JSON.stringify(f.manifest))
  await expect(f.host.reviewPlanMigration(project.projectId, 1)).rejects.toThrow(
    "IMPORT_REVALIDATION_PENDING"
  )
  expect(() =>
    f.store.commitPlanMigration(
      { ...project, manifest: f.manifest },
      1,
      {
        projectId: project.projectId,
        expectedVersion: 1,
        sourceDigest: project.pluginDigest,
        targetDigest: project.pluginDigest,
        targetVersion: project.packageVersion,
        inputFingerprint: "a".repeat(64),
        candidateInputFingerprint: "a".repeat(64),
        preservedStageIds: [],
        remainingStageIds: ["draft", "renamed-future"],
        contractDigest: "a".repeat(64)
      },
      () => {}
    )
  ).toThrow("IMPORT_REVALIDATION_PENDING")
  f.manifest.stages[1].id = "review"
  writeFileSync(join(f.targetPlugin, "devclaw.project-runtime.json"), JSON.stringify(f.manifest))
  const operation = f.host.prepare({
    projectId: project.projectId,
    expectedVersion: 1,
    idempotencyKey: "accept-prefix"
  })
  await f.host.validateImported(operation.operationId)
  await expect(f.host.createBranchAtStage(branch)).rejects.toThrow("IMPORT_REVALIDATION_PENDING")
  f.host.decideResultApproval(operation.operationId, {
    ...f.host.resultReview(operation.operationId),
    actorId: "desktop-user",
    decision: "approved"
  })
  const accepted = f.host.transition(operation.operationId)
  expect(() => f.store.assertImportPrefixComplete(project.projectId)).not.toThrow()
  await expect(
    f.host.createBranchAtStage({ ...branch, expectedSourceVersion: accepted.version })
  ).rejects.toThrow("IMPORT_PREFIX_BRANCH_UNSUPPORTED")
  expect(() =>
    f.store.createBranch(creation, "draft", {
      projectId: project.projectId,
      expectedVersion: accepted.version
    })
  ).toThrow("IMPORT_PREFIX_BRANCH_UNSUPPORTED")
  writeFileSync(
    join(branchWorkspace, "document.md"),
    readFileSync(join(f.workspace, "document.md"))
  )
  expect(
    (
      await f.host.createBranchAtStage({
        ...branch,
        stageId: "review",
        expectedSourceVersion: accepted.version
      })
    ).stageIndex
  ).toBe(1)
  writeFileSync(
    join(f.targetPlugin, "skills/review/SKILL.md"),
    "---\nname: review\n---\nA revised future Skill"
  )
  const review = await f.host.reviewPlanMigration(project.projectId, accepted.version)
  expect((await f.host.migratePlan(review)).version).toBe(accepted.version + 1)
})

it.each([false, true])(
  "rejects generic validation as an imported prefix escape (reexecute=%s)",
  async (reexecute) => {
    const f = await adaptedFixture(reexecute)
    await f.imports.confirm(await f.imports.reviewAdapter(f.adapterInput))
    const operation = f.host.prepare({
      projectId: "new-project",
      expectedVersion: 1,
      idempotencyKey: "generic-validate-escape"
    })
    // A normal file-exists check would accept these bytes, but they are neither the mapped output
    // nor evidence that the required fresh Skill ran.
    writeFileSync(join(f.workspace, "document.md"), "Unreviewed replacement")
    const authority = vi.fn()
    await expect(f.host.validate(operation.operationId, authority)).rejects.toThrow(
      "IMPORTED_STAGE_REVALIDATION_REQUIRED"
    )
    expect(authority).toHaveBeenCalledTimes(1)
    expect(skill).not.toHaveBeenCalled()
    expect(f.store.getOperation(operation.operationId)?.status).toBe("prepared")
    expect(() => f.host.transition(operation.operationId)).toThrow()
  }
)

it("retains ordinary validation with both authority fences after the imported prefix", async () => {
  const f = await adaptedFixture()
  await f.imports.confirm(await f.imports.reviewAdapter(f.adapterInput))
  const prefix = f.host.prepare({
    projectId: "new-project",
    expectedVersion: 1,
    idempotencyKey: "prefix-validation"
  })
  await f.host.validateImported(prefix.operationId)
  f.host.decideResultApproval(prefix.operationId, {
    ...f.host.resultReview(prefix.operationId),
    actorId: "desktop-user",
    decision: "approved"
  })
  const project = f.host.transition(prefix.operationId)
  const operation = f.host.prepare({
    projectId: project.projectId,
    expectedVersion: project.version,
    idempotencyKey: "ordinary-following-stage"
  })
  f.host.approve(operation.operationId, {
    expectedVersion: operation.expectedVersion,
    inputFingerprint: operation.inputFingerprint,
    actorId: "desktop-user",
    decision: "approved"
  })
  const authority = vi.fn()
  expect((await f.host.validate(operation.operationId, authority)).status).toBe("succeeded")
  expect(authority).toHaveBeenCalledTimes(2)
  expect(skill).not.toHaveBeenCalled()
})

it("keeps a recovered successful validation unknown when the original mapped bytes changed", async () => {
  const f = await adaptedFixture()
  await f.imports.confirm(await f.imports.reviewAdapter(f.adapterInput))
  const original = readFileSync(join(f.workspace, "document.md"))
  const operation = f.host.prepare({
    projectId: "new-project",
    expectedVersion: 1,
    idempotencyKey: "crash-after-terminal"
  })
  const ticket = f.store.start(operation.operationId, operation.inputFingerprint)
  f.store.bindExecutionThread(ticket, "original-validation-thread")
  f.store.recordExecutionTerminal(ticket, {
    outcome: "success",
    code: "import_validation_complete"
  })
  f.store.recoverInterrupted()
  writeFileSync(join(f.workspace, "document.md"), "Different but still present")
  await expect(f.host.reconcile(operation.operationId)).rejects.toThrow("IMPORT_ARTIFACT_CHANGED")
  expect(f.store.getOperation(operation.operationId)?.status).toBe("unknown")
  writeFileSync(join(f.workspace, "document.md"), original)
  expect((await f.host.reconcile(operation.operationId)).status).toBe("succeeded")
  expect(skill).not.toHaveBeenCalled()
})

it.each(["error", "cancelled", "reexecuted-success"] as const)(
  "preserves legitimate imported recovery (%s)",
  async (outcome) => {
    const reexecute = outcome === "reexecuted-success"
    const f = await adaptedFixture(reexecute)
    await f.imports.confirm(await f.imports.reviewAdapter(f.adapterInput))
    const operation = f.host.prepare({
      projectId: "new-project",
      expectedVersion: 1,
      idempotencyKey: "legitimate-recovery"
    })
    const ticket = f.store.start(operation.operationId, operation.inputFingerprint)
    f.store.bindExecutionThread(ticket, "original-stage-thread")
    f.store.recordExecutionTerminal(ticket, {
      outcome: reexecute ? "success" : outcome,
      code: "original-physical-terminal"
    })
    f.store.recoverInterrupted()
    writeFileSync(join(f.workspace, "document.md"), "Current output from the original stage")
    expect((await f.host.reconcile(operation.operationId)).status).toBe(
      reexecute ? "succeeded" : outcome === "error" ? "failed" : "cancelled"
    )
    expect(skill).not.toHaveBeenCalled()
  }
)
