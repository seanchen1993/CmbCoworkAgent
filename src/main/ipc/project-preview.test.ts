import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../mods/control-store"
import { HostProjectStore } from "../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { HostProjectService } from "../harness-board/project-runtime/host-service"
import type { ProjectPreviewApi } from "../../shared/project-runtime/development-preview"
import type { DevelopmentScope } from "../mods/v2/development-session"

const gate = vi.hoisted(() => ({ native: true, scope: {} as DevelopmentScope, enabled: true }))
vi.mock("../mods/devtools/development-service", () => ({
  getModDevelopmentService: () => ({
    projectAuthoringContext(threadId: string) {
      if (!gate.enabled || threadId !== gate.scope.threadId)
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
      const captured = structuredClone(gate.scope)
      return {
        scope: captured,
        assertCurrent() {
          if (!gate.enabled || JSON.stringify(captured) !== JSON.stringify(gate.scope))
            throw Error("DEVELOPMENT_SCOPE_CHANGED")
        }
      }
    }
  })
}))
const roots: string[] = []
const close: Array<() => void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of close.splice(0).reverse()) dispose()
  for (const root of roots.splice(0)) {
    const path = resolve(root)
    if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith("preview-native-"))
      throw Error("Unsafe native preview cleanup")
    await rm(path, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "preview-native-"))
  roots.push(root)
  const workspace = join(root, "creator")
  await mkdir(workspace)
  gate.scope = {
    threadId: "native-preview",
    workspace,
    incarnation: { token: randomUUID(), legacyCreatedAt: 1 }
  }
  gate.native = gate.enabled = true
  const scope = structuredClone(gate.scope)
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  let executions = 0
  async function boot() {
    vi.resetModules()
    const [
      { projectAuthoringSessions: sessions },
      { projectPreviewRegistry: registry },
      { registerProjectPreviewHandlers }
    ] = await Promise.all([
      import("../mods/devtools/project-authoring-session"),
      import("../mods/devtools/project-preview-registry"),
      import("./project-preview")
    ])
    const control = new ModControlStore(join(root, "control.sqlite"))
    const store = new HostProjectStore(join(root, "projects.sqlite"))
    const dispose = () => {
      control.close()
      store.close()
    }
    close.push(dispose)
    sessions.configurePersistence(control, join(root, "sources"))
    registry.configurePersistence(control)
    const platform = new HostProjectService(store, snapshots, {
      resolveInstalledPlugin: async (id) => {
        const plugin = registry.resolve(id)
        return (
          plugin && {
            installedPluginId: id,
            root: plugin.path,
            packageId: plugin.name,
            packageVersion: plugin.version,
            enabled: true
          }
        )
      },
      authorize: async (project) => {
        registry.assertProject(project)
      },
      executeSkill: async () => {
        executions++
        throw Error("Recovery must never execute a Skill")
      }
    })
    platform.recoverInterrupted()
    const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
    const handle: IpcMain["handle"] = (channel, callback) => {
      handlers.set(channel, callback)
    }
    registerProjectPreviewHandlers(
      { handle } as IpcMain,
      () => {
        if (!gate.native) throw Error("UNTRUSTED_NATIVE_CALL")
      },
      () => platform,
      (project) => snapshots.read(project.pluginDigest).root
    )
    const invoke = async (method: keyof ProjectPreviewApi, input: unknown): Promise<unknown> => {
      const handler = handlers.get(`project-preview:${method}`)
      if (!handler) throw Error("Missing native handler")
      return handler({} as IpcMainInvokeEvent, input)
    }
    return { sessions, registry, platform, store, control, invoke, dispose }
  }
  const first = await boot()
  const draft = await first.sessions.scaffold(scope, "docs", "Native preview", () => undefined)
  const files = draft.source.files.map((file) => {
    if (file.path !== "devclaw.project-runtime.json") return file
    const runtime = JSON.parse(file.text)
    runtime.stages[0].approval = "human"
    return { ...file, text: JSON.stringify(runtime) }
  })
  const saved = await first.sessions.save(
    scope,
    { id: draft.id, name: draft.name, revision: draft.revision, files },
    () => undefined
  )
  const projectId = (await first.invoke("create", {
    threadId: scope.threadId,
    draftId: "docs",
    revision: saved.revision,
    expectedDigest: saved.source.digest,
    goal: "Original user goal"
  })) as string
  const project = first.platform.get(projectId)!
  const operation = first.platform.prepare({
    projectId,
    expectedVersion: project.version,
    idempotencyKey: "original-prepared"
  })
  first.platform.approve(operation.operationId, {
    expectedVersion: project.version,
    inputFingerprint: operation.inputFingerprint,
    actorId: "native-user",
    decision: "approved"
  })
  const input = {
    threadId: scope.threadId,
    draftId: "docs",
    projectId,
    revision: saved.revision,
    expectedDigest: saved.source.digest,
    expectedProjectVersion: project.version
  }
  const restart = async () => {
    first.dispose()
    close.splice(close.indexOf(first.dispose), 1)
    return boot()
  }
  return {
    first,
    root,
    scope,
    saved,
    project,
    operation,
    input,
    snapshots,
    restart,
    executions: () => executions
  }
}

it("native restart review preserves the original project, cancels old approvals and uses a fresh workspace for the next trial", async () => {
  const f = await fixture()
  await writeFile(join(f.project.workspace, "original.txt"), "Retain original trial output")
  const next = await f.restart()
  const listing = (await next.invoke("list", f.scope.threadId)) as Awaited<
    ReturnType<ProjectPreviewApi["list"]>
  >
  expect(listing.drafts[0].projectId).toBeUndefined()
  expect(listing.drafts[0].recovery).toMatchObject({
    projectId: f.project.projectId,
    goal: "Original user goal",
    revision: f.saved.revision,
    status: "needs-confirmation"
  })
  await expect(
    next.invoke("create", {
      threadId: f.scope.threadId,
      draftId: "docs",
      revision: f.saved.revision,
      goal: "Cannot replace the original"
    })
  ).rejects.toThrow("PROJECT_PREVIEW_RECOVERY_REQUIRED")
  expect(await next.invoke("recover", f.input)).toBe(f.project.projectId)
  expect(f.executions()).toBe(0)
  expect(next.platform.get(f.project.projectId)).toEqual(f.project)
  expect(next.platform.operations(f.project.projectId)[0].status).toBe("cancelled")
  expect(next.registry.assertProject(f.project).id).toBe(f.project.installedPluginId)
  expect(next.control.getSetting("unrelated", "untouched")).toBe("untouched")
  await next.invoke("finish", { threadId: f.scope.threadId, projectId: f.project.projectId })
  const id = (await next.invoke("create", {
    threadId: f.scope.threadId,
    draftId: "docs",
    revision: f.saved.revision,
    expectedDigest: f.saved.source.digest,
    goal: "A different user goal"
  })) as string
  const second = next.platform.get(id)!
  expect(second.projectId).not.toBe(f.project.projectId)
  expect(second.workspace).not.toBe(f.project.workspace)
  expect(await readdir(second.workspace)).toEqual([])
  expect(await readFile(join(f.project.workspace, "original.txt"), "utf8")).toBe(
    "Retain original trial output"
  )
  expect(f.executions()).toBe(0)
})

it("native recovery rejects foreign scope, stale digest/version and non-native calls without granting or cancelling anything", async () => {
  const f = await fixture()
  const next = await f.restart()
  for (const input of [
    { ...f.input, expectedDigest: "a".repeat(64) },
    { ...f.input, expectedProjectVersion: f.project.version + 1 },
    { ...f.input, revision: f.saved.revision + 1 },
    { ...f.input, projectId: randomUUID() }
  ])
    await expect(next.invoke("recover", input)).rejects.toThrow("PROJECT_PREVIEW_SCOPE_CHANGED")
  gate.native = false
  await expect(next.invoke("recover", f.input)).rejects.toThrow("UNTRUSTED_NATIVE_CALL")
  gate.native = true
  gate.scope.incarnation.token = "recreated-chat"
  await expect(next.invoke("recover", f.input)).rejects.toThrow("PROJECT_PREVIEW_SCOPE_CHANGED")
  gate.scope = structuredClone(f.scope)
  expect(next.platform.operations(f.project.projectId)[0].status).toBe("prepared")
  expect(next.registry.projectFor(f.scope, "docs")).toBeUndefined()
  expect(f.executions()).toBe(0)
})

it("native recovery keeps unknown effects owned and rejects finishing or replaying them", async () => {
  const f = await fixture()
  f.first.store.start(f.operation.operationId, f.operation.inputFingerprint)
  const next = await f.restart()
  const listing = (await next.invoke("list", f.scope.threadId)) as Awaited<
    ReturnType<ProjectPreviewApi["list"]>
  >
  expect(listing.drafts[0].recovery?.hasUnconfirmedEffects).toBe(true)
  await expect(
    next.invoke("finish", {
      threadId: f.scope.threadId,
      draftId: "docs",
      projectId: f.project.projectId
    })
  ).rejects.toThrow("PROJECT_PREVIEW_UNSETTLED")
  await next.invoke("recover", f.input)
  expect(next.platform.operations(f.project.projectId)[0].status).toBe("unknown")
  await expect(next.platform.start(f.operation.operationId)).rejects.toThrow(
    "OPERATION_NOT_PREPARED"
  )
  await expect(
    next.invoke("finish", { threadId: f.scope.threadId, projectId: f.project.projectId })
  ).rejects.toThrow("PROJECT_PREVIEW_UNSETTLED")
  expect(next.sessions.developmentStatus(f.scope, "docs")?.activeRuns).toBe(1)
  expect(f.executions()).toBe(0)
})

it("native recovery rejects same-version retained-byte edits before changing old approval or authority", async () => {
  const f = await fixture()
  const next = await f.restart()
  const retained = f.snapshots.read(f.project.pluginDigest).root
  await writeFile(
    join(retained, "skills/draft/SKILL.md"),
    "Changed source with the same package version"
  )
  await expect(next.invoke("recover", f.input)).rejects.toThrow()
  expect(next.platform.get(f.project.projectId)?.packageVersion).toBe(f.project.packageVersion)
  expect(next.platform.operations(f.project.projectId)[0].status).toBe("prepared")
  expect(next.platform.operations(f.project.projectId)[0].approval?.decision).toBe("approved")
  expect(next.registry.projectFor(f.scope, "docs")).toBeUndefined()
  expect(next.sessions.developmentStatus(f.scope, "docs")?.activeRuns).toBe(0)
  expect(next.registry.retained(f.scope, "docs")?.pluginDigest).toBe(f.project.pluginDigest)
  expect(f.executions()).toBe(0)
})

it("native recovery admits only one concurrent confirmation and keeps changed drafts outside the old project", async () => {
  const f = await fixture()
  const next = await f.restart()
  const results = await Promise.allSettled([
    next.invoke("recover", f.input),
    next.invoke("recover", f.input)
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: expect.objectContaining({ message: "PROJECT_DEV_BUSY" })
  })
  expect(next.sessions.developmentStatus(f.scope, "docs")?.activeRuns).toBe(1)
  const draft = next.sessions.read(f.scope, "docs")
  const newer = await next.sessions.save(
    f.scope,
    { id: draft.id, name: draft.name, revision: draft.revision, files: draft.source.files },
    () => undefined
  )
  expect(newer.development).toMatchObject({
    currentRevision: f.saved.revision,
    pendingRevision: f.saved.revision + 1,
    activeRuns: 1
  })
  expect(next.registry.assertProject(f.project).id).toBe(f.project.installedPluginId)
  await next.invoke("finish", { threadId: f.scope.threadId, projectId: f.project.projectId })
  expect(next.sessions.developmentStatus(f.scope, "docs")?.currentRevision).toBe(
    f.saved.revision + 1
  )
  expect(f.executions()).toBe(0)
})

it("native recovery refuses a newer draft and can explicitly retire the settled old trial while retaining artifacts", async () => {
  const f = await fixture()
  const next = await f.restart()
  await writeFile(join(f.project.workspace, "old.txt"), "Original trial")
  const draft = next.sessions.read(f.scope, "docs")
  await next.sessions.save(
    f.scope,
    { id: draft.id, name: draft.name, revision: draft.revision, files: draft.source.files },
    () => undefined
  )
  const listing = (await next.invoke("list", f.scope.threadId)) as Awaited<
    ReturnType<ProjectPreviewApi["list"]>
  >
  expect(listing.drafts[0].recovery?.status).toBe("draft-changed")
  await expect(next.invoke("recover", f.input)).rejects.toThrow("PROJECT_DRAFT_REVISION_CHANGED")
  await next.invoke("finish", {
    threadId: f.scope.threadId,
    projectId: f.project.projectId,
    draftId: "docs"
  })
  expect(next.registry.retained(f.scope, "docs")).toBeUndefined()
  expect(await readFile(join(f.project.workspace, "old.txt"), "utf8")).toBe("Original trial")
  expect(f.executions()).toBe(0)
})

it("native cleanup handles a crash before project creation without admitting code or deleting files", async () => {
  const f = await fixture()
  await f.first.invoke("finish", { threadId: f.scope.threadId, projectId: f.project.projectId })
  const lease = f.first.sessions.acquireDevelopment(
    f.scope,
    "docs",
    f.saved.revision,
    () => undefined
  )
  const orphanId = randomUUID()
  await f.first.registry.register({
    projectId: orphanId,
    scope: f.scope,
    snapshot: lease.snapshot,
    actions: [],
    guard: () => undefined,
    release: lease.release
  })
  await writeFile(join(lease.snapshot.workspace, "retained.txt"), "Do not delete")
  const next = await f.restart()
  const listing = (await next.invoke("list", f.scope.threadId)) as Awaited<
    ReturnType<ProjectPreviewApi["list"]>
  >
  expect(listing.drafts[0].recovery).toMatchObject({ status: "missing", projectId: orphanId })
  await next.invoke("finish", { threadId: f.scope.threadId, projectId: orphanId, draftId: "docs" })
  expect(next.registry.retained(f.scope, "docs")).toBeUndefined()
  expect(await readFile(join(lease.snapshot.workspace, "retained.txt"), "utf8")).toBe(
    "Do not delete"
  )
  expect(f.executions()).toBe(0)
})
