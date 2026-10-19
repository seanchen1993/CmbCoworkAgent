import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { ProjectPreviewRegistry } from "./project-preview-registry"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import { ModControlStore } from "../control-store"
import type { DevelopmentScope } from "../v2/development-session"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(template: "harness-lite" | "harness-data", invalidReview: boolean) {
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
  return { root, scope, sessions, draft, service, registry, project, observed }
}

it.each(["harness-lite", "harness-data"] as const)(
  "%s: creates the original isolated preview and executes every real stage with pinned source and receipts",
  async template => {
    const f = await fixture(template, false)
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
    f.registry.finish(project, f.scope, f.service.operations(project.projectId))
    expect(f.sessions.developmentStatus(f.scope, f.draft.id)).toMatchObject({ activeRuns: 0,
      currentRevision: 2, pendingRevision: null })
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
        f.registry.finish(project, f.scope, f.service.operations(project.projectId))
        expect(f.sessions.developmentStatus(f.scope, f.draft.id)?.activeRuns).toBe(0)
      }
    }
    expect(f.service.get(project.projectId)?.status).not.toBe("completed")
    expect(f.observed).toHaveLength(project.manifest.stages.length)
  }
)
