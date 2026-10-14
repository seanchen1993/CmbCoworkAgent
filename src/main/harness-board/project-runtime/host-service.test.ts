import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HostProjectService, type HostProjectServiceDependencies } from "./host-service"
import { HostPackageSnapshots } from "./package-snapshots"
import { HostProjectStore } from "./host-store"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { inspectHostProjectExecution } from "./host-execution-inspector"
import { ProjectLibrary } from "./project-library"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime"
import { readRuntimeScopedFile, runtimeDigest, runtimeDirectoryIdentity } from "./safe-files"

const cleanup: Array<() => void> = []
async function fixture(
  overrides: Partial<HostProjectServiceDependencies> = {},
  configureManifest?: (manifest: ProjectRuntimeManifest) => void
) {
  const root = mkdtempSync(join(tmpdir(), "host-project-service-"))
  const workspace = join(root, "workspace")
  const plugin = join(root, "installed")
  mkdirSync(workspace)
  mkdirSync(plugin)
  const manifest = hostProjectFixture(workspace).manifest
  configureManifest?.(manifest)
  writeFileSync(join(plugin, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  for (const stage of manifest.stages) {
    mkdirSync(join(plugin, "skills", stage.id), { recursive: true })
    writeFileSync(join(plugin, stage.skill!), `---\nname: ${stage.id}\n---\nOriginal instructions`)
  }
  const store = new HostProjectStore(join(root, "projects.sqlite"))
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const dependencies: HostProjectServiceDependencies = {
    resolveInstalledPlugin: async () => ({
      installedPluginId: "installation-uuid",
      root: plugin,
      packageId: "docs",
      packageVersion: "1.0.0",
      enabled: true
    }),
    authorize: vi.fn(async () => {}),
    executeSkill: vi.fn(async (context) => {
      expect(context.snapshotRoot).not.toBe(plugin)
      expect(readFileSync(join(context.snapshotRoot, context.skillPath), "utf8")).toContain(
        "Original instructions"
      )
      if (context.operation.stageId === "draft")
        writeFileSync(join(workspace, "document.md"), "A real document")
      return "succeeded" as const
    }),
    ...overrides
  }
  const service = new HostProjectService(store, snapshots, dependencies)
  const project = await service.localCreate({
    projectId: "local-docs",
    name: "Local",
    workspace,
    installedPluginId: "installation-uuid",
    goal: "Write a document"
  })
  return { root, workspace, plugin, project, service, store, snapshots, dependencies }
}
afterEach(() => cleanup.splice(0).forEach((run) => run()))

async function prepareReview(setup: Awaited<ReturnType<typeof fixture>>) {
  const draft = setup.service.prepare({
    projectId: "local-docs",
    expectedVersion: 1,
    idempotencyKey: "draft"
  })
  expect((await setup.service.start(draft.operationId)).status).toBe("succeeded")
  setup.service.transition(draft.operationId)
  const review = setup.service.prepare({
    projectId: "local-docs",
    expectedVersion: 2,
    idempotencyKey: "review"
  })
  setup.service.approve(review.operationId, {
    expectedVersion: 2,
    inputFingerprint: review.inputFingerprint,
    decision: "approved",
    actorId: "user"
  })
  return { draft: setup.store.getOperation(draft.operationId)!, review }
}

describe("production host project adapter", () => {
  it.each([false, true])(
    "safely releases a retained old prepared fingerprint (approved=%s)",
    async (approved) => {
      const setup = await fixture()
      const draft = setup.service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: "draft"
      })
      await setup.service.start(draft.operationId)
      const project = setup.service.transition(draft.operationId)
      // Previous builds included the current editable output in the prepared input digest.
      const oldFingerprint = runtimeDigest(
        JSON.stringify({
          goal: project.goal,
          projectId: project.projectId,
          workspace: runtimeDirectoryIdentity(project.workspace),
          version: project.version,
          stage: "review",
          pluginDigest: project.pluginDigest,
          files: [
            ["document.md", readRuntimeScopedFile(project.workspace, "document.md").fingerprint]
          ]
        })
      )
      const old = setup.store.prepare({
        projectId: project.projectId,
        expectedVersion: 2,
        stageId: "review",
        idempotencyKey: "retained-old-review",
        inputFingerprint: oldFingerprint
      })
      const approval = {
        expectedVersion: 2,
        inputFingerprint: oldFingerprint,
        decision: "approved" as const,
        actorId: "user"
      }
      if (approved) {
        setup.store.decideApproval(old.operationId, approval)
        await expect(setup.service.start(old.operationId)).rejects.toThrow("INPUT_CHANGED")
        expect(setup.store.getOperation(old.operationId)?.status).toBe("failed")
      } else {
        expect(() => setup.service.approve(old.operationId, approval)).toThrow("INPUT_CHANGED")
        expect(setup.service.cancel(old.operationId).status).toBe("cancelled")
      }
      const retry = setup.service.prepare({
        projectId: project.projectId,
        expectedVersion: 2,
        idempotencyKey: "explicit-new-review"
      })
      expect(retry.status).toBe("prepared")
      expect(retry.inputFingerprint).not.toBe(oldFingerprint)
      expect(setup.service.get(project.projectId)?.version).toBe(2)
    }
  )
  it("validates review edits with new receipts without upgrading old evidence or knowledge", async () => {
    const original = "Original draft"
    const revised = "Reviewed and corrected draft"
    const setup = await fixture({
      executeSkill: async (context) => {
        writeFileSync(
          join(context.project.workspace, "document.md"),
          context.operation.stageId === "draft" ? original : revised
        )
        return "succeeded"
      }
    })
    const { draft, review } = await prepareReview(setup)
    const receiptsBeforeReview = structuredClone(draft.receipts)
    const result = await setup.service.start(review.operationId)
    expect(result.status).toBe("succeeded")
    expect(result.receipts[0].artifactFingerprint).not.toBe(draft.receipts[0].artifactFingerprint)
    expect(setup.store.getOperation(draft.operationId)?.receipts).toEqual(receiptsBeforeReview)
    const library = new ProjectLibrary(join(setup.root, "library.sqlite"))
    try {
      const project = setup.service.get("local-docs")!
      expect(() =>
        library.capture(project, draft, {
          kind: "knowledge",
          title: "Old draft",
          note: ""
        })
      ).toThrow("EVIDENCE_STALE")
      const captured = library.capture(project, result, {
        kind: "knowledge",
        title: "Corrected draft",
        note: ""
      })
      expect(library.read(project.projectId, captured.id, "document.md").text).toBe(revised)
      writeFileSync(join(setup.workspace, "document.md"), "Changed after review validation")
      expect(() => setup.service.transition(review.operationId)).toThrow("EVIDENCE_STALE")
      expect(setup.service.get("local-docs")?.version).toBe(2)
      writeFileSync(join(setup.workspace, "document.md"), revised)
      expect(setup.service.transition(review.operationId).status).toBe("completed")
      expect(setup.service.transition(review.operationId).status).toBe("completed")
      expect(() =>
        setup.service.prepare({
          projectId: project.projectId,
          expectedVersion: 3,
          idempotencyKey: "after-completion"
        })
      ).toThrow("PROJECT_COMPLETED")
      await expect(setup.service.start(review.operationId)).rejects.toThrow(
        "OPERATION_NOT_PREPARED"
      )
      await expect(setup.service.validate(review.operationId)).rejects.toThrow("PROJECT_COMPLETED")
      expect(() =>
        setup.service.approve(review.operationId, {
          expectedVersion: 2,
          inputFingerprint: review.inputFingerprint,
          decision: "approved",
          actorId: "user"
        })
      ).toThrow("INPUT_CHANGED")
      expect(setup.store.getOperation(draft.operationId)?.receipts).toEqual(receiptsBeforeReview)
    } finally {
      library.close()
    }
  })

  it("keeps changed preceding inputs unknown even when the review also has editable outputs", async () => {
    const setup = await fixture(
      {
        executeSkill: async (context) => {
          context.bindThread(`thread-${context.operation.stageId}`)
          writeFileSync(join(context.project.workspace, "document.md"), context.operation.stageId)
          writeFileSync(join(context.project.workspace, "source.md"), context.operation.stageId)
          context.recordTerminal({ outcome: "success", code: "normal" })
          return "succeeded"
        },
        inspectOperation: inspectHostProjectExecution
      },
      (manifest) => {
        manifest.artifacts.push({ id: "source", path: "source.md", required: true })
        manifest.checks.push({
          id: "source-exists",
          artifactId: "source",
          kind: "file-exists",
          sideEffect: "read"
        })
        manifest.stages[0].artifactIds.push("source")
        manifest.stages[0].checkIds.push("source-exists")
      }
    )
    const { review } = await prepareReview(setup)
    expect((await setup.service.start(review.operationId)).status).toBe("unknown")
    expect((await setup.service.reconcile(review.operationId)).status).toBe("unknown")
    expect(() => setup.service.transition(review.operationId)).toThrow()
    expect(setup.service.get("local-docs")?.version).toBe(2)
  })

  it("reconciles persisted terminal evidence for revised checked outputs without rerunning", async () => {
    const executeSkill = vi.fn<HostProjectServiceDependencies["executeSkill"]>(async (context) => {
      context.bindThread(`thread-${context.operation.stageId}`)
      writeFileSync(join(context.project.workspace, "document.md"), context.operation.stageId)
      context.recordTerminal({ outcome: "success", code: "normal" })
      if (context.operation.stageId === "review") throw Error("lost result after confirmed write")
      return "succeeded"
    })
    const setup = await fixture({ executeSkill, inspectOperation: inspectHostProjectExecution })
    const { review } = await prepareReview(setup)
    expect((await setup.service.start(review.operationId)).status).toBe("unknown")
    const reopened = new HostProjectStore(join(setup.root, "projects.sqlite"))
    try {
      const recovered = new HostProjectService(reopened, setup.snapshots, setup.dependencies)
      expect((await recovered.reconcile(review.operationId)).status).toBe("succeeded")
      expect(recovered.transition(review.operationId).status).toBe("completed")
      expect(executeSkill).toHaveBeenCalledTimes(2)
    } finally {
      reopened.close()
    }
  })
  it("cannot validate files instead of executing a required action", async () => {
    const setup = await fixture()
    const input = hostProjectFixture(setup.workspace)
    input.projectId = "action-project"
    input.manifest.stages[0].actionIds = ["publish"]
    input.manifest.actions = [
      {
        id: "publish",
        ref: {
          pluginId: "provider-install",
          plugin: "provider",
          digest: "a".repeat(64),
          actionId: "publish"
        }
      }
    ]
    const project = setup.store.create(input)
    const operation = setup.store.prepare({
      projectId: project.projectId,
      stageId: "draft",
      expectedVersion: 1,
      idempotencyKey: "file-only",
      inputFingerprint: "b".repeat(64)
    })
    writeFileSync(join(setup.workspace, "document.md"), "Already exists")
    await expect(setup.service.validate(operation.operationId)).rejects.toThrow(
      "ACTION_EXECUTION_REQUIRED"
    )
    expect(setup.store.getOperation(operation.operationId)?.startedAt).toBeNull()
  })
  it("does not release cancelled unknown writes merely because an unknown terminal exists", async () => {
    const setup = await fixture({
      executeSkill: async (context) => {
        context.bindThread("uncertain-thread")
        context.recordTerminal({ outcome: "unknown", code: "unobserved" })
        return "unknown" as const
      },
      inspectOperation: inspectHostProjectExecution
    })
    const operation = setup.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "uncertain"
    })
    await setup.service.start(operation.operationId)
    setup.service.cancel(operation.operationId)
    expect((await setup.service.reconcile(operation.operationId)).status).toBe("unknown")
    expect(() =>
      setup.service.prepare({
        projectId: "local-docs",
        expectedVersion: 1,
        idempotencyKey: "retry"
      })
    ).toThrow("OPERATION_ACTIVE")
  })
  it("reconciles a persisted original terminal after reopening without executing again", async () => {
    const setup = await fixture({
      executeSkill: vi.fn(async (context) => {
        context.bindThread("durable-thread")
        writeFileSync(join(context.project.workspace, "document.md"), "Actual output")
        context.recordTerminal({ outcome: "success", code: "normal" })
        throw Error("interrupted before result transaction")
      }),
      inspectOperation: inspectHostProjectExecution
    })
    const operation = setup.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "original"
    })
    expect((await setup.service.start(operation.operationId)).status).toBe("unknown")
    const reopened = new HostProjectStore(join(setup.root, "projects.sqlite"))
    try {
      const recovered = new HostProjectService(reopened, setup.snapshots, setup.dependencies)
      recovered.recoverInterrupted()
      expect((await recovered.reconcile(operation.operationId)).status).toBe("succeeded")
      expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(1)
      expect(recovered.get("local-docs")?.version).toBe(1)
      expect(recovered.transition(operation.operationId).version).toBe(2)
    } finally {
      reopened.close()
    }
  })

  it("keeps missing original terminal unknown even if output files exist", async () => {
    const setup = await fixture({
      executeSkill: vi.fn(async (context) => {
        context.bindThread("unsettled-thread")
        writeFileSync(join(context.project.workspace, "document.md"), "Partial output")
        return "unknown" as const
      }),
      inspectOperation: inspectHostProjectExecution
    })
    const operation = setup.service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "original"
    })
    await setup.service.start(operation.operationId)
    expect((await setup.service.reconcile(operation.operationId)).status).toBe("unknown")
    expect(setup.dependencies.executeSkill).toHaveBeenCalledTimes(1)
    expect(() => setup.service.transition(operation.operationId)).toThrow()
  })
  it("creates and prepares without a model then executes fixed Skills, validates files and completes approval", async () => {
    const { service, dependencies, plugin } = await fixture()
    const draft = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "draft"
    })
    expect(dependencies.executeSkill).not.toHaveBeenCalled()
    writeFileSync(join(plugin, "skills/draft/SKILL.md"), "Updated mutable installation")
    expect((await service.start(draft.operationId)).status).toBe("succeeded")
    const next = service.transition(draft.operationId)
    expect(next).toMatchObject({
      stageIndex: 1,
      version: 2,
      installedPluginId: "installation-uuid",
      packageId: "docs"
    })
    expect(
      service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "draft" })
        .status
    ).toBe("transitioned")
    const review = service.prepare({
      projectId: "local-docs",
      expectedVersion: 2,
      idempotencyKey: "review"
    })
    await expect(service.start(review.operationId)).rejects.toThrow("APPROVAL_REQUIRED")
    service.approve(review.operationId, {
      expectedVersion: 2,
      inputFingerprint: review.inputFingerprint,
      decision: "approved",
      actorId: "user"
    })
    expect((await service.start(review.operationId)).status).toBe("succeeded")
    expect(service.transition(review.operationId).status).toBe("completed")
    expect(dependencies.executeSkill).toHaveBeenCalledTimes(2)
  })

  it("rejects stale receipts after validation and allows explicit cancelled retry", async () => {
    const { service, workspace } = await fixture()
    const draft = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "draft"
    })
    await service.start(draft.operationId)
    writeFileSync(join(workspace, "document.md"), "Modified after validation")
    expect(() => service.transition(draft.operationId)).toThrow("EVIDENCE_STALE")
    expect(service.get("local-docs")?.version).toBe(1)
    expect(service.cancel(draft.operationId).status).toBe("cancelled")
    const retry = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "retry"
    })
    expect((await service.validate(retry.operationId)).status).toBe("succeeded")
    expect(service.transition(retry.operationId).version).toBe(2)
  })

  it("reports missing artifacts as failed without model calls or stage progress", async () => {
    const { service, dependencies } = await fixture()
    const operation = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "validate"
    })
    const result = await service.validate(operation.operationId)
    expect(result.status).toBe("failed")
    expect(result.receipts[0].result).toBe("failed")
    expect(dependencies.executeSkill).not.toHaveBeenCalled()
    expect(() => service.transition(operation.operationId)).toThrow()
  })

  it("does not turn missing reconciliation capability into an automatic retry", async () => {
    const { service } = await fixture({ executeSkill: async () => "unknown" })
    const operation = service.prepare({
      projectId: "local-docs",
      expectedVersion: 1,
      idempotencyKey: "run"
    })
    expect((await service.start(operation.operationId)).status).toBe("unknown")
    await expect(service.reconcile(operation.operationId)).rejects.toThrow("RECONCILE_UNSUPPORTED")
    expect(() =>
      service.prepare({ projectId: "local-docs", expectedVersion: 1, idempotencyKey: "retry" })
    ).toThrow("OPERATION_ACTIVE")
  })
})
