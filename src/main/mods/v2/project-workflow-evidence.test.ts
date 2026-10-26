import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { hostProjectFixture } from "../../harness-board/project-runtime/host-fixtures.test-helper"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
import type { WorkflowEvidenceReadScope } from "../../agent/workflow/deterministic-action-native"
import type { PersistedWorkflowRun } from "../../agent/workflow/types"
import { captureProjectWorkflowEvidence } from "./project-workflow-evidence"
import { withProjectActionScope, type SettledProjectSkillBinding } from "../../harness-board/project-action-scope"

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-workflow-evidence-"))
  const workspace = join(root, "workspace"), installed = join(root, "installed")
  mkdirSync(workspace); mkdirSync(installed)
  const manifest = hostProjectFixture(workspace).manifest
  for (const stage of manifest.stages) {
    stage.approval = "none"
    mkdirSync(join(installed, "skills", stage.id), { recursive: true })
    writeFileSync(join(installed, stage.skill!), `---\nname: ${stage.id}\n---\nCreate the document`)
  }
  writeFileSync(join(installed, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  writeFileSync(join(installed, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  const store = new HostProjectStore(join(root, "state.sqlite"))
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const reviewEntered = Promise.withResolvers<void>(), finishReview = Promise.withResolvers<void>()
  const service = new HostProjectService(store, new HostPackageSnapshots(join(root, "snapshots")), {
    resolveInstalledPlugin: async () => ({ installedPluginId: "installed", root: installed,
      packageId: "docs", packageVersion: "1.0.0", enabled: true }),
    authorize: async () => {},
    executeSkill: async context => {
      context.bindThread(context.operation.stageId + "-thread")
      if (context.operation.stageId === "draft") writeFileSync(join(workspace, "document.md"), "accepted original")
      else { reviewEntered.resolve(); await finishReview.promise }
      context.recordTerminal({ outcome: "success", code: "deterministic-fixture-settled" })
      return "succeeded"
    }
  })
  const project = await service.localCreate({ projectId: "project", name: "Project", workspace,
    installedPluginId: "installed", goal: "Independent two-stage documents" })
  const draft = service.prepare({ projectId: project.projectId, expectedVersion: 1, idempotencyKey: "draft" })
  await service.start(draft.operationId)
  const transitioned = service.transition(draft.operationId)
  const review = service.prepare({ projectId: project.projectId, expectedVersion: transitioned.version,
    idempotencyKey: "review" })
  const running = service.start(review.operationId)
  await reviewEntered.promise
  const selected = service.captureWorkflowEvidenceStage(project.projectId, review.operationId, "draft")
  const row = { created_at: 1, metadata: JSON.stringify({ workspacePath: workspace,
    cmb_thread_incarnation: "original", hostProjectRuntime: { projectId: project.projectId,
      operationId: draft.operationId, stageId: "draft", pluginDigest: project.pluginDigest } }) }
  const original: PersistedWorkflowRun = {
    version: 1, runId: "original-run", threadId: "draft-thread", workflowName: "original",
    script: "private source", scriptSha256: "a".repeat(64), status: "completed", phases: [],
    currentPhase: null, agents: [], logs: [], journal: [], worktrees: [],
    result: { actual: true }, startedAt: "start", updatedAt: "end", completedAt: "end",
    stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 1 },
    hostExecution: { projectId: project.projectId, operationId: draft.operationId, stageId: "draft",
      packageDigest: project.pluginDigest, inputFingerprint: selected.operation.inputFingerprint,
      threadId: "draft-thread", incarnationKey: JSON.stringify(captureThreadIncarnation(row)) }
  }
  const readers = { thread: vi.fn((id: string) => id === "draft-thread" ? row : undefined),
    assertSettled: vi.fn(), load: vi.fn(async () => original),
    actions: vi.fn((scope: WorkflowEvidenceReadScope) => {
      scope.assertCurrent()
      return { deterministicActions: [], actionCount: 0, nextActionOffset: null }
    }) }
  const read = () => captureProjectWorkflowEvidence(selected, { runId: original.runId, stageId: "draft" }, readers)
  return { service, selected, project, draft, review, workspace, row, original, readers, read,
    async close() { finishReview.resolve(); await running } }
}

it("reads original accepted producer facts across two actual Host operation threads", async () => {
  const f = await fixture()
  try {
    const value = await f.read()
    expect(value.value).toMatchObject({ found: true, run: { runId: "original-run", result: { actual: true } },
      evidence: { operationId: f.draft.operationId } })
    expect(f.readers.load).toHaveBeenCalledWith(f.workspace, "draft-thread", "original-run")
    expect(f.readers.actions.mock.calls[0][0]).toMatchObject({ threadId: "draft-thread" })
    expect(f.service.operations(f.project.projectId).find(op => op.operationId === f.review.operationId)?.execution?.threadId)
      .toBe("review-thread")
    expect(JSON.stringify(value.value)).not.toContain("private source")
  } finally { await f.close() }
})

it.each(["project", "operation", "incarnation", "missing-owner", "active", "changed-artifact"])(
  "refuses cross-stage evidence after %s changes", async mode => {
    const f = await fixture()
    try {
      if (mode === "project") f.original.hostExecution!.projectId = "other-project"
      if (mode === "operation") f.original.hostExecution!.operationId = "another-operation"
      if (mode === "incarnation") f.row.metadata = f.row.metadata.replace('"original"', '"recreated"')
      if (mode === "missing-owner") delete f.original.hostExecution
      if (mode === "active") f.readers.assertSettled.mockImplementation(() => { throw Error("WORKFLOW_UNSETTLED") })
      if (mode === "changed-artifact") writeFileSync(join(f.workspace, "document.md"), "changed after acceptance")
      await expect(f.read()).rejects.toThrow()
      expect(f.readers.actions).not.toHaveBeenCalled()
    } finally { await f.close() }
  }
)

it("rechecks caller/producer after the original asynchronous run read", async () => {
  const f = await fixture()
  try {
    f.readers.load.mockImplementation(async () => {
      f.row.metadata = f.row.metadata.replace('"original"', '"recreated"')
      return f.original
    })
    await expect(f.read()).rejects.toThrow("THREAD_CHANGED")
    expect(f.readers.actions).not.toHaveBeenCalled()
  } finally { await f.close() }
})


function currentStage(f: Awaited<ReturnType<typeof fixture>>) {
  const operation = f.service.operations(f.project.projectId).find(item =>
    item.operationId === f.review.operationId)!
  const binding: SettledProjectSkillBinding = {
    projectId: operation.projectId, operationId: operation.operationId,
    stageId: operation.stageId, threadId: operation.execution!.threadId,
    pluginDigest: operation.pluginDigest, inputFingerprint: operation.inputFingerprint
  }
  const metadataBinding = { projectId: binding.projectId, operationId: binding.operationId,
    stageId: binding.stageId, pluginDigest: binding.pluginDigest }
  const row = { created_at: 2, metadata: JSON.stringify({ workspacePath: f.workspace,
    cmb_thread_incarnation: "current", hostProjectRuntime: metadataBinding }) }
  f.readers.thread.mockImplementation(id => id === binding.threadId ? row : undefined)
  f.original.threadId = binding.threadId
  f.original.hostExecution = { projectId: binding.projectId, operationId: binding.operationId,
    stageId: binding.stageId, packageDigest: binding.pluginDigest,
    inputFingerprint: binding.inputFingerprint, threadId: binding.threadId,
    incarnationKey: JSON.stringify(captureThreadIncarnation(row)) }
  const select = () => f.service.captureWorkflowEvidenceStage(binding.projectId,
    binding.operationId, binding.stageId)
  const read = (selected: ReturnType<typeof select>) => captureProjectWorkflowEvidence(selected,
    { runId: f.original.runId, stageId: binding.stageId }, f.readers)
  return { binding, metadataBinding, select, read }
}

it("reads the exact current physically settled Skill without prematurely publishing stage success", async () => {
  const f = await fixture()
  try {
    const current = currentStage(f)
    expect(current.select).toThrow("WORKFLOW_EVIDENCE_UNSETTLED")
    let held!: ReturnType<typeof current.select>
    await withProjectActionScope(current.binding.threadId, current.metadataBinding, () => {}, async () => {
      held = current.select()
      const result = await current.read(held)
      expect(result.value).toMatchObject({ found: true, evidence: {
        operationId: f.review.operationId, stageId: current.binding.stageId
      } })
      expect(f.service.operations(f.project.projectId).find(op =>
        op.operationId === f.review.operationId)?.execution?.terminal).toBeNull()
      expect(JSON.stringify(result.value)).not.toContain(held.settlementIdentity)
      f.readers.assertSettled.mockImplementationOnce(() => { throw Error("WORKFLOW_ACTIVE") })
      await expect(current.read(held)).rejects.toThrow("WORKFLOW_ACTIVE")
    }, undefined, current.binding)
    expect(held.assertCurrent).toThrow()
    expect(current.select).toThrow("WORKFLOW_EVIDENCE_UNSETTLED")
  } finally { await f.close() }
})

it("rejects wrong input proof and revocation during the original asynchronous workflow read", async () => {
  const f = await fixture()
  try {
    const current = currentStage(f)
    await withProjectActionScope(current.binding.threadId, current.metadataBinding, () => {}, async () => {
      expect(current.select).toThrow("WORKFLOW_EVIDENCE_UNSETTLED")
    }, undefined, { ...current.binding, inputFingerprint: "other-input" })
    let authorized = true
    await withProjectActionScope(current.binding.threadId, current.metadataBinding, () => {
      if (!authorized) throw Error("ORIGINAL_AUTHORITY_REVOKED")
    }, async () => {
      const selected = current.select()
      f.readers.load.mockImplementation(async () => {
        authorized = false
        return f.original
      })
      await expect(current.read(selected)).rejects.toThrow("ORIGINAL_AUTHORITY_REVOKED")
      expect(f.readers.actions).not.toHaveBeenCalled()
    }, undefined, current.binding)
  } finally { await f.close() }
})

it("assigns different main-only cache identities to distinct live scopes for the same operation", async () => {
  const f = await fixture()
  try {
    const current = currentStage(f)
    const identities: string[] = []
    const values: unknown[] = []
    for (let i = 0; i < 2; i++) {
      await withProjectActionScope(current.binding.threadId, current.metadataBinding, () => {}, async () => {
        const selected = current.select()
        identities.push(selected.settlementIdentity)
        values.push((await current.read(selected)).value)
      }, undefined, current.binding)
    }
    expect(identities[0]).not.toBe(identities[1])
    expect(identities).not.toContain("durable")
    expect(values[0]).toEqual(values[1])
    expect(f.service.operations(f.project.projectId).find(op =>
      op.operationId === f.review.operationId)?.execution?.terminal).toBeNull()
  } finally { await f.close() }
})


it.each(["input", "upstream-artifact", "authority"])(
  "rechecks full evidence at the actual workflow read await after %s changes", async mode => {
    const f = await fixture()
    try {
      if (mode === "upstream-artifact") {
        f.readers.load.mockImplementation(async () => {
          writeFileSync(join(f.workspace, "document.md"), "changed during original workflow read")
          return f.original
        })
        await expect(f.read()).rejects.toThrow()
        expect(f.readers.actions).not.toHaveBeenCalled()
        return
      }
      const current = currentStage(f)
      let valid = true
      const checkAuthority = () => {
        if (!valid && mode === "authority") throw Error("APPROVAL_REVOKED")
      }
      await withProjectActionScope(current.binding.threadId, current.metadataBinding,
        checkAuthority, async () => {
          const selected = current.select()
          f.readers.load.mockImplementation(async () => { valid = false; return f.original })
          await expect(current.read(selected)).rejects.toThrow(
            mode === "authority" ? "APPROVAL_REVOKED" : "INPUT_BYTES_CHANGED")
          expect(f.readers.actions).not.toHaveBeenCalled()
        }, () => { if (!valid) throw Error("INPUT_BYTES_CHANGED") }, current.binding)
    } finally { await f.close() }
  }
)
