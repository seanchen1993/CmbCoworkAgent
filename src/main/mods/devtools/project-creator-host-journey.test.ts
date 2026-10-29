import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { ProjectAuthoringSessions, ProjectDraftHistoryStorageLimitError } from "./project-authoring-session"
import { ProjectPreviewRegistry } from "./project-preview-registry"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import { ModControlStore } from "../control-store"
import type { DevelopmentScope } from "../v2/development-session"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(template: "harness-lite" | "harness-data", invalidReview: boolean, bind = true) {
  const root = await mkdtemp(join(tmpdir(), "creator-host-journey-"))
  const controls = new ModControlStore(join(root, "controls.sqlite"))
  const store = new HostProjectStore(join(root, "projects.sqlite"))
  cleanup.push(async () => {
    store.close()
    controls.close()
    if (dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("creator-host-journey-")) throw Error("Unsafe cleanup")
    await rm(root, { recursive: true, force: true })
  })
  const scope: DevelopmentScope = { threadId: "creator", workspace: root,
    incarnation: { token: template, legacyCreatedAt: 1 } }
  const sessions = new ProjectAuthoringSessions()
  sessions.configurePersistence(controls, join(root, "source"))
  const draft = await sessions.scaffold(scope, "sample", "真实项目样本", () => {}, template)
  const request = await sessions.requestTrial(scope, draft.id, draft.revision,
    template === "harness-data" ? "从订单口径生成转换说明并审查" : "起草并审查受控文档", () => {})
  expect(request).toMatchObject({ phase: "needs-approval", executed: false })
  const lease = sessions.acquireDevelopment(scope, draft.id, draft.revision, () => {})
  const registry = new ProjectPreviewRegistry()
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const observed: Array<{ stage: string; previous: string[]; instruction: string }> = []
  const service = new HostProjectService(store, snapshots, {
    resolveInstalledPlugin: async id => {
      const plugin = registry.resolve(id)
      return plugin && { installedPluginId: id, root: plugin.path,
        packageId: plugin.name, packageVersion: plugin.version, enabled: plugin.enabled }
    },
    authorize: async project => { registry.assertProject(project) },
    // Controlled skill provider exercises real snapshot/HostService/SQLite/validator boundaries.
    // It writes real artifacts, but deliberately does not claim remote-model or semantic quality.
    executeSkill: async context => {
      const stage = context.project.manifest.stages.find(row => row.id === context.operation.stageId)!
      const index = context.project.manifest.stages.indexOf(stage)
      const previousIds = context.project.manifest.stages.slice(0, index).flatMap(row => row.artifactIds)
      const previous: string[] = []
      for (const id of new Set(previousIds)) {
        const artifact = context.project.manifest.artifacts.find(row => row.id === id)!
        previous.push(await readFile(join(context.project.workspace, artifact.path), "utf8"))
      }
      const instruction = await readFile(join(context.snapshotRoot, context.skillPath), "utf8")
      observed.push({ stage: stage.id, previous, instruction })
      for (const id of stage.artifactIds) {
        const artifact = context.project.manifest.artifacts.find(row => row.id === id)!
        // Cumulative prior artifacts retain their original contents.
        if (previousIds.includes(id)) continue
        await mkdir(dirname(join(context.project.workspace, artifact.path)), { recursive: true })
        await writeFile(join(context.project.workspace, artifact.path), artifact.path.endsWith(".json")
          ? JSON.stringify({ summary: "受控样本已读取前序产物并审查", checked: !invalidReview })
          : `# ${stage.title}\n真实样本 ${stage.id}；已读取前序产物 ${previous.length} 项。\n`)
      }
      return "succeeded"
    }
  })
  const projectId = randomUUID()
  const plugin = await registry.register({ projectId, scope, snapshot: lease.snapshot,
    guard: () => {}, release: lease.release, actions: [] })
  const project = await service.localCreate({ projectId, name: draft.name,
    workspace: lease.snapshot.workspace, installedPluginId: plugin.id, goal: request.request.goal })
  await registry.bind(project, snapshots.read(project.pluginDigest).root)
  sessions.configureTrialObservation(id => ({ project: service.get(id), operations: service.operations(id, 100) }))
  if (bind) sessions.bindTrialProject(scope, draft.id, project, () => {})
  return { root, scope, sessions, draft, service, registry, project, observed, controls }
}

it.each(["harness-lite", "harness-data"] as const)(
  "%s: creates the original isolated preview and executes every real stage with pinned source and receipts",
  async template => {
    const f = await fixture(template, false)
    const requested = f.sessions.trialRequest(f.scope)!
    const reopened = await f.sessions.requestTrial(f.scope, f.draft.id, f.draft.revision,
      requested.goal, () => {})
    expect(reopened.request.id).toBe(requested.id)
    await expect(f.sessions.requestTrial(f.scope, f.draft.id, f.draft.revision,
      "another goal must not detach this trial", () => {})).rejects.toThrow("PROJECT_DEV_RUNNING")
    expect(f.sessions.trialRequest(f.scope)?.id).toBe(requested.id)
    const changed = f.draft.source.files.map(file => file.path.startsWith("skills/")
      ? { ...file, text: file.text + "\nNEW_VERSION_MUST_WAIT\n" } : file)
    await f.sessions.save(f.scope, { id: f.draft.id, name: f.draft.name,
      revision: f.draft.revision, files: changed }, () => {})
    expect(f.sessions.developmentStatus(f.scope, f.draft.id)).toMatchObject({ activeRuns: 1,
      currentRevision: 1, pendingRevision: 2 })
    let project = f.project
    for (const stage of project.manifest.stages) {
      const operation = f.service.prepare({ projectId: project.projectId,
        expectedVersion: project.version, idempotencyKey: stage.id })
      if (stage.approval === "human") f.service.approve(operation.operationId, {
        expectedVersion: project.version, inputFingerprint: operation.inputFingerprint,
        decision: "approved", actorId: "native-user" })
      const result = await f.service.start(operation.operationId)
      expect(result.status).toBe("succeeded")
      expect(result.receipts.length).toBeGreaterThan(0)
      expect(result.receipts.every(receipt => receipt.result === "passed")).toBe(true)
      project = f.service.transition(operation.operationId)
    }
    expect(project.status).toBe("completed")
    expect(f.observed).toHaveLength(project.manifest.stages.length)
    expect(f.observed.at(-1)!.previous.length).toBeGreaterThan(0)
    expect(f.observed.some(row => row.instruction.includes("NEW_VERSION_MUST_WAIT"))).toBe(false)
    expect(f.sessions.trialRequest(f.scope)?.journey).toMatchObject({
      projectId: project.projectId, phase: "passed", canDeliver: false
    })
    f.registry.finish(project, f.scope, f.service.operations(project.projectId))
    expect(f.sessions.developmentStatus(f.scope, f.draft.id)).toMatchObject({ activeRuns: 0,
      currentRevision: 2, pendingRevision: null })
    // Finishing removes execution authority; the independently scoped observation remains
    // readable after restart, including when the author has already edited the next version.
    const restored = new ProjectAuthoringSessions()
    restored.configurePersistence(f.controls, join(f.root, "source"))
    restored.configureTrialObservation(id => ({ project: f.service.get(id),
      operations: f.service.operations(id, 100) }))
    expect(restored.trialRequest(f.scope)?.journey).toMatchObject({ phase: "passed", canDeliver: false })
    expect(restored.developmentStatus(f.scope, f.draft.id)).toBeUndefined()
    restored.setChanged(() => { throw Error("window closed") })
    expect(() => restored.notifyTrialProject(project.projectId)).not.toThrow()
    expect(f.observed).toHaveLength(project.manifest.stages.length)
    expect(restored.trialRequest({ ...f.scope, incarnation: { token: "other-chat", legacyCreatedAt: 1 } }))
      .toBeUndefined()
  }
)

it.each(["harness-lite", "harness-data"] as const)(
  "%s: rejects invalid real review artifacts without automatic advance or replay",
  async template => {
    const f = await fixture(template, true)
    let project = f.project
    for (const stage of project.manifest.stages) {
      const operation = f.service.prepare({ projectId: project.projectId,
        expectedVersion: project.version, idempotencyKey: stage.id })
      if (stage.approval === "human") f.service.approve(operation.operationId, {
        expectedVersion: project.version, inputFingerprint: operation.inputFingerprint,
        decision: "approved", actorId: "native-user" })
      const result = await f.service.start(operation.operationId)
      if (stage.id !== "review") project = f.service.transition(operation.operationId)
      else {
        expect(result.status).not.toBe("succeeded")
        expect(() => f.service.transition(operation.operationId)).toThrow()
        expect(() => f.sessions.acquireDevelopment(f.scope, f.draft.id, 1, () => {}))
          .toThrow("PROJECT_DEV_RUNNING")
        expect(f.sessions.developmentStatus(f.scope, f.draft.id)?.activeRuns).toBe(1)
        // A known validation failure may be explicitly finished; it is not an unknown action.
        expect(result.status).toBe("failed")
        expect(f.sessions.trialRequest(f.scope)?.journey).toMatchObject({
          phase: "failed", canDeliver: false, stages: expect.arrayContaining([
            expect.objectContaining({ id: "review", status: "failed" })
          ])
        })
        f.registry.finish(project, f.scope, f.service.operations(project.projectId))
        expect(f.sessions.developmentStatus(f.scope, f.draft.id)?.activeRuns).toBe(0)
      }
    }
    expect(f.service.get(project.projectId)?.status).not.toBe("completed")
    expect(f.observed).toHaveLength(project.manifest.stages.length)
  }
)

it("archives only fully settled original journals and never clears a live or unknown preview", async () => {
  const f = await fixture("harness-lite", false)
  let project = f.project
  for (const stage of project.manifest.stages) {
    const operation = f.service.prepare({ projectId: project.projectId,
      expectedVersion: project.version, idempotencyKey: stage.id })
    if (stage.approval === "human") f.service.approve(operation.operationId, {
      expectedVersion: project.version, inputFingerprint: operation.inputFingerprint,
      decision: "approved", actorId: "native-user" })
    expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
    project = f.service.transition(operation.operationId)
  }
  const originalOperations = f.service.operations(project.projectId)
  const archive = () => f.sessions.archive(f.scope, { id: f.draft.id, revision: f.draft.revision,
    sourceDigest: f.draft.source.digest }, () => {})
  expect(archive).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  expect(f.sessions.developmentStatus(f.scope, f.draft.id)?.activeRuns).toBe(1)
  f.registry.finish(project, f.scope, originalOperations)
  const unknown = originalOperations.map((operation, index) => index === 0
    ? { ...operation, status: "unknown" as const } : operation)
  f.sessions.configureTrialObservation(() => ({ project, operations: unknown }))
  expect(archive).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  f.sessions.configureTrialObservation(() => ({ operations: [] }))
  expect(archive).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  f.sessions.configureTrialObservation(() => ({ project,
    operations: Array.from({ length: 100 }, () => originalOperations[0]) }))
  expect(archive).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  f.sessions.configureTrialObservation(() => ({ project: { ...project, pluginDigest: "c".repeat(64) },
    operations: originalOperations }))
  expect(archive).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  expect(f.sessions.read(f.scope, f.draft.id).source).toEqual(f.draft.source)
  expect(f.service.operations(project.projectId)).toEqual(originalOperations)
  f.sessions.configureTrialObservation(() => ({ project, operations: originalOperations }))
  // An old completed project must not conceal a newer native trial awaiting confirmation.
  await f.sessions.requestTrial(f.scope, f.draft.id, f.draft.revision, "新的未执行目标", () => {})
  expect(archive).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  expect(f.sessions.read(f.scope, f.draft.id).source).toEqual(f.draft.source)
})

it("frees a full creator slot after a completed real trial and retains its evidence after restart", async () => {
  const f = await fixture("harness-lite", false)
  let project = f.project
  for (const stage of project.manifest.stages) {
    const operation = f.service.prepare({ projectId: project.projectId,
      expectedVersion: project.version, idempotencyKey: stage.id })
    if (stage.approval === "human") f.service.approve(operation.operationId, {
      expectedVersion: project.version, inputFingerprint: operation.inputFingerprint,
      decision: "approved", actorId: "native-user" })
    expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
    project = f.service.transition(operation.operationId)
  }
  const operations = f.service.operations(project.projectId)
  f.registry.finish(project, f.scope, operations)
  for (const id of ["second", "third", "fourth"])
    await f.sessions.save(f.scope, { id, name: f.draft.name, revision: 0,
      files: f.draft.source.files }, () => {})
  const input = { id: f.draft.id, revision: f.draft.revision,
    sourceDigest: f.draft.source.digest, newId: "fifth" }
  await expect(f.sessions.continue(f.scope, input, () => {})).rejects.toMatchObject({
    message: "PROJECT_DRAFT_LIMIT", reason: "drafts" })
  f.sessions.archive(f.scope, input, () => {})
  expect(f.sessions.developmentStatus(f.scope, f.draft.id)?.activeRuns).toBe(0)
  expect(f.sessions.trialRequest(f.scope)?.journey).toMatchObject({ phase: "passed", canDeliver: false })
  const copy = await f.sessions.continue(f.scope, input, () => {})
  expect(copy.source).toEqual(f.draft.source)
  expect(copy.development).toBeUndefined()
  expect(f.sessions.list(f.scope)).toHaveLength(4)
  const restored = new ProjectAuthoringSessions()
  restored.configurePersistence(f.controls, join(f.root, "source"))
  restored.configureTrialObservation(id => ({ project: f.service.get(id), operations: f.service.operations(id, 100) }))
  expect(restored.versions(f.scope, f.draft.id)).toMatchObject({ archived: true,
    versions: [expect.objectContaining({ trialProjectIds: [project.projectId] })] })
  expect(restored.trialRequest(f.scope)?.journey).toMatchObject({ phase: "passed", canDeliver: false })
  expect(restored.developmentStatus(f.scope, f.draft.id)).toBeUndefined()
  expect(f.service.operations(project.projectId)).toEqual(operations)
})

it("archives a known failed trial only after its native execution lease has been explicitly finished", async () => {
  const f = await fixture("harness-lite", true)
  let project = f.project
  for (const stage of project.manifest.stages) {
    const operation = f.service.prepare({ projectId: project.projectId,
      expectedVersion: project.version, idempotencyKey: stage.id })
    if (stage.approval === "human") f.service.approve(operation.operationId, {
      expectedVersion: project.version, inputFingerprint: operation.inputFingerprint,
      decision: "approved", actorId: "native-user" })
    const result = await f.service.start(operation.operationId)
    if (result.status === "succeeded") project = f.service.transition(operation.operationId)
    else expect(result.status).toBe("failed")
  }
  const input = { id: f.draft.id, revision: f.draft.revision, sourceDigest: f.draft.source.digest }
  expect(() => f.sessions.archive(f.scope, input, () => {})).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  const operations = f.service.operations(project.projectId)
  f.registry.finish(project, f.scope, operations)
  expect(f.sessions.archive(f.scope, input, () => {})).toMatchObject({ archived: true })
  expect(f.sessions.trialRequest(f.scope)?.journey).toMatchObject({ phase: "failed", canDeliver: false })
  expect(f.service.operations(project.projectId)).toEqual(operations)
})

it("retains an already-created Host binding on typed history capacity failure and blocks incomplete archival", async () => {
  const f = await fixture("harness-lite", false, false)
  const persist = vi.spyOn(f.sessions as unknown as { persistState(...args: unknown[]): void }, "persistState")
  for (const error of [Error("permission-revoked"), Error("PROJECT_DRAFT_REVISION_CHANGED"),
    Error("PROJECT_DRAFT_HISTORY_STORAGE_LIMIT")]) {
    persist.mockImplementationOnce(() => { throw error })
    expect(() => f.sessions.bindTrialProject(f.scope, f.draft.id, f.project, () => {})).toThrow(error.message)
    expect(f.sessions.trialRequest(f.scope)?.journey).toBeUndefined()
  }
  persist.mockImplementationOnce(() => { throw new ProjectDraftHistoryStorageLimitError() })
  expect(() => f.sessions.bindTrialProject(f.scope, f.draft.id, f.project, () => {})).not.toThrow()
  persist.mockRestore()
  expect(f.sessions.trialRequest(f.scope)?.journey?.projectId).toBe(f.project.projectId)
  expect(f.sessions.versions(f.scope, f.draft.id)).toMatchObject({ trialEvidenceIncomplete: true })
  expect(f.sessions.versions(f.scope, f.draft.id).versions[0]).not.toHaveProperty("trialProjectCount")
  let project = f.project
  for (const stage of project.manifest.stages) {
    const operation = f.service.prepare({ projectId: project.projectId,
      expectedVersion: project.version, idempotencyKey: stage.id })
    if (stage.approval === "human") f.service.approve(operation.operationId, {
      expectedVersion: project.version, inputFingerprint: operation.inputFingerprint,
      decision: "approved", actorId: "native-user" })
    expect((await f.service.start(operation.operationId)).status).toBe("succeeded")
    project = f.service.transition(operation.operationId)
  }
  f.registry.finish(project, f.scope, f.service.operations(project.projectId))
  expect(f.sessions.trialRequest(f.scope)?.journey).toMatchObject({ phase: "passed", canDeliver: true })
  const input = { id: f.draft.id, revision: f.draft.revision, sourceDigest: f.draft.source.digest }
  expect(() => f.sessions.archive(f.scope, input, () => {})).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  const copied = await f.sessions.continue(f.scope, { ...input, newId: "following" }, () => {})
  await f.sessions.requestTrial(f.scope, copied.id, copied.revision, "后续目标", () => {})
  const lease = f.sessions.acquireDevelopment(f.scope, copied.id, copied.revision, () => {})
  const nextId = randomUUID()
  const plugin = await f.registry.register({ projectId: nextId, scope: f.scope,
    snapshot: lease.snapshot, guard: () => {}, release: lease.release, actions: [] })
  const next = await f.service.localCreate({ projectId: nextId, name: copied.name,
    workspace: lease.snapshot.workspace, installedPluginId: plugin.id, goal: "后续目标" })
  await f.registry.bind(next, new HostPackageSnapshots(join(f.root, "snapshots")).read(next.pluginDigest).root)
  f.sessions.bindTrialProject(f.scope, copied.id, next, () => {})
  const restored = new ProjectAuthoringSessions()
  restored.configurePersistence(f.controls, join(f.root, "source"))
  restored.configureTrialObservation(id => ({ project: f.service.get(id), operations: f.service.operations(id, 100) }))
  expect(restored.versions(f.scope, f.draft.id).trialEvidenceIncomplete).toBe(true)
  expect(() => restored.archive(f.scope, input, () => {})).toThrow("PROJECT_DRAFT_ARCHIVE_IN_USE")
  expect(restored.read(f.scope, f.draft.id).source).toEqual(f.draft.source)
  expect(f.registry.resolve(plugin.id)).toBeDefined()
  f.registry.finish(next, f.scope, [])
})
