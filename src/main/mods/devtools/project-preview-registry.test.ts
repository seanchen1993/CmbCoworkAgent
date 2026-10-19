import { rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { ProjectPreviewRegistry } from "./project-preview-registry"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import type { DevelopmentScope } from "../v2/development-session"

const scope: DevelopmentScope = {
  threadId: "creator",
  workspace: "author-workspace",
  incarnation: { token: "first", legacyCreatedAt: 1 }
}
const roots = new Set<string>()
const stores: HostProjectStore[] = []
afterEach(async () => {
  for (const store of stores) store.close()
  stores.length = 0
  for (const root of roots) {
    const target = resolve(root)
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("devclaw-project-authoring-")
    )
      throw Error("Unsafe test cleanup path")
    await rm(target, { recursive: true, force: true })
  }
  roots.clear()
})
async function fixture() {
  const sessions = new ProjectAuthoringSessions()
  const draft = await sessions.scaffold(scope, "preview", "Preview", () => undefined)
  const root = dirname(draft.directory)
  roots.add(root)
  await sessions.inspect(scope, draft.id, 1, "dev", () => undefined)
  const registry = new ProjectPreviewRegistry()
  const store = new HostProjectStore(join(root, "projects.sqlite"))
  stores.push(store)
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const service = new HostProjectService(store, snapshots, {
    resolveInstalledPlugin: async (id) => {
      const plugin = registry.resolve(id)
      return (
        plugin && {
          installedPluginId: id,
          root: plugin.path,
          packageId: plugin.name,
          packageVersion: plugin.version,
          enabled: plugin.enabled
        }
      )
    },
    authorize: async (project) => {
      registry.assertProject(project)
    },
    executeSkill: async () => "failed"
  })
  let valid = true
  const guard = () => {
    if (!valid) throw Error("DEVELOPMENT_SCOPE_CHANGED")
  }
  const create = async () => {
    const lease = sessions.acquireDevelopment(scope, "preview", 1, guard)
    const projectId = randomUUID()
    const plugin = await registry.register({
      projectId,
      scope,
      snapshot: lease.snapshot,
      guard,
      release: lease.release,
      actions: []
    })
    const project = await service.localCreate({
      projectId,
      installedPluginId: plugin.id,
      name: "Preview",
      workspace: lease.snapshot.workspace,
      goal: "Make a document"
    })
    await registry.bind(project, snapshots.read(project.pluginDigest).root)
    return project
  }
  return {
    registry,
    sessions,
    service,
    create,
    revoke: () => {
      valid = false
    }
  }
}

it("binds the retained package to one real project and never resolves as a normal plugin", async () => {
  const { registry, create, revoke } = await fixture()
  const project = await create()
  expect(project.installedPluginId).toMatch(/^dev-project-preview:/)
  expect(registry.resolve("normal-installed-id")).toBeUndefined()
  expect(registry.assertProject(project).name).toBe(project.packageId)
  expect(() => registry.assertProject({ ...project, projectId: "other" })).toThrow(
    "PROJECT_PREVIEW_SCOPE_CHANGED"
  )
  expect(() => registry.assertProject({ ...project, pluginDigest: "a".repeat(64) })).toThrow(
    "PROJECT_PREVIEW_SCOPE_CHANGED"
  )
  expect(() => registry.assertProject({ ...project, workspace: "other" })).toThrow(
    "PROJECT_PREVIEW_SCOPE_CHANGED"
  )
  revoke()
  expect(registry.describe(project)).toEqual({ state: "expired" })
  expect(() => registry.assertProject(project)).toThrow("DEVELOPMENT_SCOPE_CHANGED")
  expect(new ProjectPreviewRegistry().describe(project)).toEqual({ state: "expired" })
})

it("finishes unstarted approval through the original cancellation before releasing workspace", async () => {
  const { registry, service, create, sessions } = await fixture()
  const first = await create()
  const operation = service.prepare({
    projectId: first.projectId,
    expectedVersion: 1,
    idempotencyKey: "first"
  })
  expect(() => registry.finish(first, scope, service.operations(first.projectId))).toThrow(
    "PROJECT_PREVIEW_UNSETTLED"
  )
  registry.finish(first, scope, service.operations(first.projectId), (id) => service.cancel(id))
  expect(service.operations(first.projectId)[0].status).toBe("cancelled")
  expect(sessions.developmentStatus(scope, "preview")?.activeRuns).toBe(0)
  expect(() => registry.assertProject(first)).toThrow("PROJECT_PREVIEW_EXPIRED")
  const second = await create()
  expect(second.workspace).not.toBe(first.workspace)
  const next = service.prepare({
    projectId: second.projectId,
    expectedVersion: 1,
    idempotencyKey: "next"
  })
  expect(next.operationId).not.toBe(operation.operationId)
})

it("retains creator lease for started, cancel-requested and unknown effects", async () => {
  const { registry, service, create, sessions } = await fixture()
  const project = await create()
  const operation = service.prepare({
    projectId: project.projectId,
    expectedVersion: 1,
    idempotencyKey: "first"
  })
  for (const status of ["started", "cancel_requested", "unknown"] as const) {
    expect(() =>
      registry.finish(project, scope, [{ ...operation, status }], (id) => service.cancel(id))
    ).toThrow("PROJECT_PREVIEW_UNSETTLED")
    expect(sessions.developmentStatus(scope, "preview")?.activeRuns).toBe(1)
  }
  expect(() => registry.finish(project, { ...scope, threadId: "other" }, [])).toThrow(
    "PROJECT_PREVIEW_SCOPE_CHANGED"
  )
})
