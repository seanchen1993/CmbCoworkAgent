import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  HostProjectService,
  type HostProjectServiceDependencies,
  type HostStageBranchInput
} from "./host-service"
import { HostProjectStore } from "./host-store"
import { HostPackageSnapshots } from "./package-snapshots"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { runtimeDigest } from "./safe-files"

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

async function fixture(
  overrides: Partial<HostProjectServiceDependencies> = {},
  finishSource = true
) {
  const root = mkdtempSync(join(tmpdir(), "host-stage-branch-"))
  const workspace = join(root, "original")
  const branchWorkspace = join(root, "branch")
  const sourceRoot = join(root, "source")
  const candidateRoot = join(root, "candidate")
  for (const directory of [workspace, branchWorkspace, sourceRoot]) mkdirSync(directory)
  const manifest = hostProjectFixture(workspace).manifest
  writeFileSync(join(sourceRoot, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  writeFileSync(join(sourceRoot, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  for (const stage of manifest.stages) {
    mkdirSync(join(sourceRoot, "skills", stage.id), { recursive: true })
    writeFileSync(
      join(sourceRoot, stage.skill!),
      `---\nname: ${stage.id}\n---\nOriginal ${stage.id}`
    )
  }
  mkdirSync(join(sourceRoot, "hooks"))
  writeFileSync(join(sourceRoot, "hooks", "shared.py"), "# original shared check\n")
  cpSync(sourceRoot, candidateRoot, { recursive: true })
  const store = new HostProjectStore(join(root, "projects.sqlite"))
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  let identity = runtimeDigest("configuration-and-knowledge/v1")
  const authorizeStageBranch = vi.fn(async () => ({ assertCurrent: () => {} }))
  const executeSkill = vi.fn<HostProjectServiceDependencies["executeSkill"]>(async (context) => {
    context.bindThread(`native-${context.operation.operationId}`)
    writeFileSync(
      join(context.project.workspace, "document.md"),
      context.operation.stageId === "draft" ? "Actual upstream output" : "Actual revised output"
    )
    const failed = !finishSource && context.operation.stageId === "review"
    context.recordTerminal({ outcome: failed ? "error" : "success", code: "native-settled" })
    return failed ? "failed" : "succeeded"
  })
  const dependencies: HostProjectServiceDependencies = {
    resolveInstalledPlugin: async (id) => ({
      installedPluginId: id,
      root: id === "original-installation" ? sourceRoot : candidateRoot,
      packageId: "docs",
      packageVersion: "1.0.0",
      enabled: true
    }),
    prepareInputIdentity: async () => {},
    inputIdentity: () => identity,
    authorize: async () => {},
    executeSkill,
    authorizeStageBranch,
    ...overrides
  }
  const snapshots = new HostPackageSnapshots(join(root, "packages"))
  const service = new HostProjectService(store, snapshots, dependencies)
  await service.localCreate({
    projectId: "original-project",
    name: "Original",
    workspace,
    installedPluginId: "original-installation",
    goal: "Original task"
  })
  const operation = service.prepare({
    projectId: "original-project",
    expectedVersion: 1,
    idempotencyKey: "real-draft"
  })
  expect((await service.start(operation.operationId)).status).toBe("succeeded")
  service.transition(operation.operationId)
  cpSync(join(workspace, "document.md"), join(branchWorkspace, "document.md"))
  const review = service.prepare({
    projectId: "original-project",
    expectedVersion: 2,
    idempotencyKey: "real-review"
  })
  service.approve(review.operationId, {
    expectedVersion: 2,
    inputFingerprint: review.inputFingerprint,
    decision: "approved",
    actorId: "desktop-user"
  })
  expect((await service.start(review.operationId)).status).toBe(
    finishSource ? "succeeded" : "failed"
  )
  const source = finishSource
    ? service.transition(review.operationId)
    : service.get("original-project")!
  const input: HostStageBranchInput = {
    baselineId: "native-baseline",
    sourceProjectId: source.projectId,
    expectedSourceVersion: source.version,
    stageId: "review",
    projectId: "new-branch",
    name: "Isolated review",
    workspace: branchWorkspace,
    installedPluginId: "candidate-installation",
    goal: source.goal
  }
  return {
    service,
    store,
    source,
    root,
    workspace,
    branchWorkspace,
    sourceRoot,
    candidateRoot,
    input,
    dependencies,
    authorizeStageBranch,
    executeSkill,
    changeIdentity: () => {
      identity = runtimeDigest("changed-configuration")
    }
  }
}

describe("native host stage branch admission", () => {
  it("branches an already settled failed middle stage without completing the original flow", async () => {
    const setup = await fixture({}, false)
    expect(setup.source).toMatchObject({ stageIndex: 1, status: "active", version: 2 })
    expect(setup.service.operations(setup.source.projectId)[0]).toMatchObject({
      stageId: "review",
      status: "failed",
      execution: { terminal: { outcome: "error" } }
    })
    const branch = await setup.service.createBranchAtStage(setup.input)
    expect(branch).toMatchObject({ stageIndex: 1, status: "active", version: 1 })
    expect(readFileSync(join(branch.workspace, "document.md"), "utf8")).toBe(
      "Actual upstream output"
    )
    expect(setup.service.get(setup.source.projectId)).toEqual(setup.source)
    expect(setup.service.operations(branch.projectId)).toEqual([])
  })

  it("requires native release of a prepared retry before branching the failed source", async () => {
    const setup = await fixture({}, false)
    const retry = setup.service.prepare({
      projectId: setup.source.projectId,
      expectedVersion: 2,
      idempotencyKey: "pending-retry"
    })
    await expect(setup.service.createBranchAtStage(setup.input)).rejects.toThrow(
      "BRANCH_SOURCE_UNSETTLED"
    )
    setup.service.cancel(retry.operationId)
    await expect(setup.service.createBranchAtStage(setup.input)).resolves.toMatchObject({
      stageIndex: 1
    })
  })

  it("does not treat an imported branch prefix as a verified source for a second branch", async () => {
    const setup = await fixture()
    const branch = await setup.service.createBranchAtStage(setup.input)
    const target = join(setup.root, "second-branch")
    mkdirSync(target)
    await expect(
      setup.service.createBranchAtStage({
        ...setup.input,
        projectId: "nested-branch",
        workspace: target,
        sourceProjectId: branch.projectId,
        expectedSourceVersion: 1
      })
    ).rejects.toThrow("BRANCH_PREFIX_UNVERIFIED")
    expect(setup.service.get("nested-branch")).toBeUndefined()
  })

  it("creates a new full-manifest branch without upstream passes and requires fresh stage approval", async () => {
    const setup = await fixture()
    writeFileSync(
      join(setup.candidateRoot, "skills/review/SKILL.md"),
      "---\nname: review\n---\nRevised target implementation"
    )
    const original = setup.service.get(setup.source.projectId)
    const branch = await setup.service.createBranchAtStage(setup.input)
    expect(branch).toMatchObject({
      projectId: "new-branch",
      version: 1,
      stageIndex: 1,
      status: "active"
    })
    expect(branch.manifest).toEqual(original!.manifest)
    expect(branch.pluginDigest).not.toBe(original!.pluginDigest)
    expect(setup.service.operations(branch.projectId)).toEqual([])
    const reopened = new HostProjectStore(join(setup.root, "projects.sqlite"))
    try {
      expect(reopened.get(branch.projectId)).toEqual(branch)
      expect(reopened.listOperations(branch.projectId)).toEqual([])
    } finally {
      reopened.close()
    }
    expect(setup.authorizeStageBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: setup.input,
        source: original,
        candidate: expect.objectContaining({ stageIndex: 1, workspace: setup.branchWorkspace })
      })
    )
    const operation = setup.service.prepare({
      projectId: branch.projectId,
      expectedVersion: 1,
      idempotencyKey: "actual-review"
    })
    expect(operation).toMatchObject({
      stageId: "review",
      approval: null,
      receipts: [],
      execution: null
    })
    await expect(setup.service.start(operation.operationId)).rejects.toThrow("APPROVAL_REQUIRED")
    setup.service.approve(operation.operationId, {
      expectedVersion: 1,
      inputFingerprint: operation.inputFingerprint,
      decision: "approved",
      actorId: "desktop-user"
    })
    expect((await setup.service.start(operation.operationId)).status).toBe("succeeded")
    const completed = setup.service.transition(operation.operationId)
    expect(completed.status).toBe("completed")
    expect(setup.service.get(setup.source.projectId)).toEqual(original)
    expect(readFileSync(join(setup.workspace, "document.md"), "utf8")).toBe("Actual revised output")
    expect(setup.service.operations(branch.projectId)).toHaveLength(1)
  })

  it.each(["upstream", "shared-hook", "new-file", "contract"])(
    "rejects %s changes rather than silently reusing incompatible upstream input",
    async (kind) => {
      const setup = await fixture()
      if (kind === "upstream")
        writeFileSync(join(setup.candidateRoot, "skills/draft/SKILL.md"), "changed")
      if (kind === "shared-hook")
        writeFileSync(join(setup.candidateRoot, "hooks/shared.py"), "changed")
      if (kind === "new-file")
        writeFileSync(join(setup.candidateRoot, "untracked.txt"), "new dependency")
      if (kind === "contract") {
        const manifest = structuredClone(setup.source.manifest)
        manifest.stages[1].approval = "none"
        writeFileSync(
          join(setup.candidateRoot, "devclaw.project-runtime.json"),
          JSON.stringify(manifest)
        )
      }
      await expect(setup.service.createBranchAtStage(setup.input)).rejects.toThrow(
        kind === "contract" ? "BRANCH_CONTRACT_CHANGED" : "BRANCH_INPUT_SOURCE_CHANGED"
      )
      expect(setup.authorizeStageBranch).not.toHaveBeenCalled()
      expect(setup.service.get(setup.input.projectId)).toBeUndefined()
    }
  )

  it("cannot receive an arbitrary stage index, reuse the original directory or invent a target", async () => {
    const setup = await fixture()
    await expect(
      setup.service.createBranchAtStage({ ...setup.input, stageIndex: 0 } as HostStageBranchInput)
    ).rejects.toThrow("SCHEMA_INVALID")
    await expect(
      setup.service.createBranchAtStage({ ...setup.input, workspace: setup.workspace })
    ).rejects.toThrow("BRANCH_WORKSPACE_INVALID")
    await expect(
      setup.service.createBranchAtStage({ ...setup.input, stageId: "invented" })
    ).rejects.toThrow("BRANCH_STAGE_MISSING")
    expect(setup.service.get(setup.input.projectId)).toBeUndefined()
  })

  it("requires a native admission callback and rejects a revoked final baseline fence", async () => {
    const setup = await fixture()
    setup.dependencies.authorizeStageBranch = undefined
    await expect(setup.service.createBranchAtStage(setup.input)).rejects.toThrow(
      "BRANCH_UNSUPPORTED"
    )
    setup.dependencies.authorizeStageBranch = async () => ({
      assertCurrent: () => {
        throw Error("NATIVE_BASELINE_CHANGED")
      }
    })
    await expect(setup.service.createBranchAtStage(setup.input)).rejects.toThrow(
      "NATIVE_BASELINE_CHANGED"
    )
    expect(setup.service.get(setup.input.projectId)).toBeUndefined()
  })

  it.each(["started", "cancel_requested", "unknown", "missing-terminal", "unknown-terminal"])(
    "rejects a completed source with %s physical evidence",
    async (kind) => {
      const setup = await fixture()
      const latest = setup.service.operations(setup.source.projectId)[0]
      const changed = structuredClone(latest)
      if (kind === "missing-terminal") changed.execution!.terminal = null
      else if (kind === "unknown-terminal") changed.execution!.terminal!.outcome = "unknown"
      else changed.status = kind as "started" | "cancel_requested" | "unknown"
      const db = new DatabaseSync(join(setup.root, "projects.sqlite"))
      try {
        db.prepare("UPDATE host_operations SET status=?,data=? WHERE id=?").run(
          changed.status,
          JSON.stringify(changed),
          changed.operationId
        )
      } finally {
        db.close()
      }
      await expect(setup.service.createBranchAtStage(setup.input)).rejects.toThrow(
        "BRANCH_SOURCE_UNSETTLED"
      )
      expect(setup.authorizeStageBranch).not.toHaveBeenCalled()
      expect(setup.service.get(setup.input.projectId)).toBeUndefined()
    }
  )

  it("rejects a changed task goal independently of a model's baseline declaration", async () => {
    const setup = await fixture()
    await expect(
      setup.service.createBranchAtStage({ ...setup.input, goal: "A different task" })
    ).rejects.toThrow("BRANCH_GOAL_CHANGED")
    expect(setup.authorizeStageBranch).not.toHaveBeenCalled()
  })

  it("rechecks source version after asynchronous native baseline approval", async () => {
    const setup = await fixture()
    setup.dependencies.authorizeStageBranch = async () => {
      const db = new DatabaseSync(join(setup.root, "projects.sqlite"))
      const changed = { ...setup.source, version: setup.source.version + 1 }
      try {
        db.prepare("UPDATE host_projects SET version=?,data=? WHERE id=?").run(
          changed.version,
          JSON.stringify(changed),
          changed.projectId
        )
      } finally {
        db.close()
      }
      return { assertCurrent: () => {} }
    }
    await expect(setup.service.createBranchAtStage(setup.input)).rejects.toThrow(
      "BRANCH_SOURCE_CHANGED"
    )
    expect(setup.service.get(setup.input.projectId)).toBeUndefined()
  })

  it("takes a pre-execution snapshot only after started and rechecks input drift before the Skill", async () => {
    const setup = await fixture()
    const branch = await setup.service.createBranchAtStage(setup.input)
    const before = vi.fn<NonNullable<HostProjectServiceDependencies["beforeExecuteStage"]>>(
      async (context) => {
        expect(setup.store.getOperation(context.operation.operationId)?.status).toBe("started")
        expect(context.inputIdentity).toBe(
          await setup.service.readDebugInputIdentity(context.project.projectId)
        )
        expect(context.inputIdentity).not.toBe(context.ticket.inputFingerprint)
        expect(context.signal.aborted).toBe(false)
        context.assertInputsCurrent!()
        setup.changeIdentity()
      }
    )
    setup.dependencies.beforeExecuteStage = before
    const operation = setup.service.prepare({
      projectId: branch.projectId,
      expectedVersion: 1,
      idempotencyKey: "guarded-review"
    })
    setup.service.approve(operation.operationId, {
      expectedVersion: 1,
      inputFingerprint: operation.inputFingerprint,
      decision: "approved",
      actorId: "user"
    })
    const calls = setup.executeSkill.mock.calls.length
    expect(await setup.service.start(operation.operationId)).toMatchObject({
      status: "unknown",
      receipts: []
    })
    expect(before).toHaveBeenCalledOnce()
    expect(setup.executeSkill).toHaveBeenCalledTimes(calls)
  })

  it("enforces native command policy on direct start and transition before providers, preserving optional compatibility", async () => {
    const setup = await fixture()
    const branch = await setup.service.createBranchAtStage(setup.input)
    const operation = setup.service.prepare({
      projectId: branch.projectId,
      expectedVersion: 1,
      idempotencyKey: "native-command-guard"
    })
    setup.service.approve(operation.operationId, {
      expectedVersion: 1,
      inputFingerprint: operation.inputFingerprint,
      decision: "approved",
      actorId: "user"
    })
    const before = setup.store.getOperation(operation.operationId)
    const prepareInputs = vi.fn(async () => {})
    const authorize = vi.fn(async () => {})
    setup.dependencies.prepareInputIdentity = prepareInputs
    setup.dependencies.authorize = authorize
    setup.dependencies.assertCommand = (_project, kind) => {
      if (kind === "start") throw Error("NATIVE_RECONFIRMATION_REQUIRED")
    }
    const calls = setup.executeSkill.mock.calls.length
    expect(() => setup.service.start(operation.operationId)).toThrow(
      "NATIVE_RECONFIRMATION_REQUIRED"
    )
    expect(prepareInputs).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
    expect(setup.executeSkill).toHaveBeenCalledTimes(calls)
    expect(setup.store.getOperation(operation.operationId)).toEqual(before)
    // Existing native producers that do not install a policy keep the original execution chain.
    setup.dependencies.assertCommand = undefined
    expect((await setup.service.start(operation.operationId)).status).toBe("succeeded")
    const succeeded = setup.store.getOperation(operation.operationId)
    setup.dependencies.assertCommand = (_project, kind) => {
      if (kind === "advance") throw Error("NATIVE_SINGLE_STAGE_ONLY")
    }
    expect(() => setup.service.transition(operation.operationId)).toThrow(
      "NATIVE_SINGLE_STAGE_ONLY"
    )
    expect(setup.service.get(branch.projectId)).toEqual(branch)
    expect(setup.store.getOperation(operation.operationId)).toEqual(succeeded)
    setup.dependencies.assertCommand = undefined
    expect(setup.service.transition(operation.operationId).status).toBe("completed")
  })

  it("checks native policy before returning an idempotent prepared operation", async () => {
    const setup = await fixture()
    const branch = await setup.service.createBranchAtStage(setup.input)
    const input = {
      projectId: branch.projectId,
      expectedVersion: 1,
      idempotencyKey: "old-preparation"
    }
    const operation = setup.service.prepare(input)
    setup.dependencies.assertCommand = (_project, kind) => {
      if (kind === "prepare") throw Error("NATIVE_RECONFIRMATION_REQUIRED")
    }
    expect(() => setup.service.prepare(input)).toThrow("NATIVE_RECONFIRMATION_REQUIRED")
    expect(setup.store.getOperation(operation.operationId)?.status).toBe("prepared")
  })
})
