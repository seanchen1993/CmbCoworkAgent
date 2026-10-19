import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { ProjectPreviewRegistry } from "./project-preview-registry"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import type { DevelopmentScope } from "../v2/development-session"

const scope: DevelopmentScope = {
  threadId: "preview-recovery",
  workspace: "creator-workspace",
  incarnation: { token: "original", legacyCreatedAt: 1 }
}
const roots: string[] = []
const stores: HostProjectStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    const path = resolve(root)
    if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith("preview-recovery-"))
      throw Error("Unsafe recovery fixture cleanup")
    await rm(path, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "preview-recovery-"))
  roots.push(root)
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key: string, expected: string | undefined, value: string) => {
      if (values.get(key) !== expected) return false
      values.set(key, value)
      return true
    }
  }
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  let executions = 0
  function process() {
    const sessions = new ProjectAuthoringSessions()
    sessions.configurePersistence(settings, join(root, "sources"))
    const registry = new ProjectPreviewRegistry()
    registry.configurePersistence(settings)
    const store = new HostProjectStore(join(root, "projects.sqlite"))
    stores.push(store)
    const service = new HostProjectService(store, snapshots, {
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
      executeSkill: async (context) => {
        executions++
        await writeFile(join(context.project.workspace, "draft.md"), "# Actual recovered output")
        return "succeeded"
      }
    })
    service.recoverInterrupted()
    const recover = async (projectId: string, guard = () => undefined) => {
      const project = service.get(projectId)!
      const saved = registry.retained(scope, "docs")!
      const draft = sessions.read(scope, "docs")
      if (
        draft.revision !== saved.snapshot.revision ||
        draft.source.digest !== saved.snapshot.digest
      )
        throw Error("PROJECT_DRAFT_REVISION_CHANGED")
      await sessions.inspect(scope, "docs", draft.revision, "dev", guard)
      const lease = sessions.acquireDevelopment(
        scope,
        "docs",
        draft.revision,
        guard,
        project.workspace
      )
      try {
        await registry.recover({
          scope,
          draftId: "docs",
          project,
          snapshot: lease.snapshot,
          retainedRoot: snapshots.read(project.pluginDigest).root,
          actions: [],
          operations: service.operations(projectId),
          guard,
          release: lease.release,
          cancelPrepared: (id) => service.cancel(id)
        })
      } catch (error) {
        lease.release()
        throw error
      }
    }
    return { sessions, registry, store, service, recover }
  }
  const first = process()
  const draft = await first.sessions.scaffold(
    scope,
    "docs",
    "Reusable document project",
    () => undefined
  )
  const files = draft.source.files.map((file) => {
    if (file.path !== "devclaw.project-runtime.json") return file
    const runtime = JSON.parse(file.text)
    runtime.stages[0].approval = "human"
    return { ...file, text: JSON.stringify(runtime) }
  })
  await first.sessions.save(
    scope,
    { id: "docs", name: draft.name, revision: 1, files },
    () => undefined
  )
  await first.sessions.inspect(scope, "docs", 2, "dev", () => undefined)
  const lease = first.sessions.acquireDevelopment(scope, "docs", 2, () => undefined)
  const projectId = randomUUID()
  const plugin = await first.registry.register({
    projectId,
    scope,
    snapshot: lease.snapshot,
    guard: () => undefined,
    release: lease.release,
    actions: []
  })
  const project = await first.service.localCreate({
    projectId,
    name: "Document trial",
    workspace: lease.snapshot.workspace,
    installedPluginId: plugin.id,
    goal: "Write a release note"
  })
  await first.registry.bind(project, snapshots.read(project.pluginDigest).root)
  const prepare = (service: HostProjectService, key: string) => {
    const operation = service.prepare({ projectId, expectedVersion: 1, idempotencyKey: key })
    service.approve(operation.operationId, {
      expectedVersion: 1,
      inputFingerprint: operation.inputFingerprint,
      actorId: "native-user",
      decision: "approved"
    })
    return service.operations(projectId).find((row) => row.operationId === operation.operationId)!
  }
  const restart = () => {
    first.store.close()
    stores.splice(stores.indexOf(first.store), 1)
    return process()
  }
  return { ...first, project, snapshots, prepare, restart, executions: () => executions }
}

it("restores the original project only after a new native review and invalidates unexecuted approvals", async () => {
  const first = await fixture()
  const old = first.prepare(first.service, "before-restart")
  const next = first.restart()
  expect(next.registry.projectFor(scope, "docs")).toBeUndefined()
  expect(() => next.registry.resolve(first.project.installedPluginId)).toThrow(
    "PROJECT_PREVIEW_EXPIRED"
  )
  expect(next.registry.retained(scope, "docs")?.projectId).toBe(first.project.projectId)
  await next.recover(first.project.projectId)
  expect(first.executions()).toBe(0)
  expect(next.registry.projectFor(scope, "docs")).toBe(first.project.projectId)
  expect(
    next.service
      .operations(first.project.projectId)
      .find((row) => row.operationId === old.operationId)?.status
  ).toBe("cancelled")
  expect(next.registry.assertProject(first.project).path).toBe(
    first.snapshots.read(first.project.pluginDigest).root
  )
  const fresh = next.service.prepare({
    projectId: first.project.projectId,
    expectedVersion: 1,
    idempotencyKey: "after-native-review"
  })
  await expect(next.service.start(fresh.operationId)).rejects.toThrow("APPROVAL_REQUIRED")
  expect(first.executions()).toBe(0)
  next.service.approve(fresh.operationId, {
    expectedVersion: 1,
    inputFingerprint: fresh.inputFingerprint,
    decision: "approved",
    actorId: "native-user"
  })
  expect((await next.service.start(fresh.operationId)).status).toBe("succeeded")
  expect(first.executions()).toBe(1)
  const advanced = next.service.transition(fresh.operationId)
  expect(advanced.version).toBe(2)
  expect(next.registry.assertProject(advanced).id).toBe(first.project.installedPluginId)
  expect(await readFile(join(advanced.workspace, "draft.md"), "utf8")).toContain(
    "Actual recovered output"
  )
})

it("retains uncertain operations and their workspace ownership without executing or releasing them", async () => {
  const first = await fixture()
  const operation = first.prepare(first.service, "interrupted")
  first.store.start(operation.operationId, operation.inputFingerprint)
  const next = first.restart()
  expect(next.service.operations(first.project.projectId)[0].status).toBe("unknown")
  await next.recover(first.project.projectId)
  expect(first.executions()).toBe(0)
  expect(next.service.operations(first.project.projectId)[0].status).toBe("unknown")
  expect(() =>
    next.registry.finish(
      first.project,
      scope,
      next.service.operations(first.project.projectId),
      (id) => next.service.cancel(id)
    )
  ).toThrow("PROJECT_PREVIEW_UNSETTLED")
  expect(next.sessions.developmentStatus(scope, "docs")?.activeRuns).toBe(1)
})

it("rejects changed retained source and changed draft without restoring approval or losing the receipt", async () => {
  const first = await fixture()
  const operation = first.prepare(first.service, "not-started")
  const next = first.restart()
  const retained = first.snapshots.read(first.project.pluginDigest).root
  await writeFile(join(retained, "skills/draft/SKILL.md"), "Tampered source")
  await expect(next.recover(first.project.projectId)).rejects.toThrow()
  expect(next.registry.retained(scope, "docs")?.projectId).toBe(first.project.projectId)
  expect(next.registry.projectFor(scope, "docs")).toBeUndefined()
  expect(
    next.service
      .operations(first.project.projectId)
      .find((row) => row.operationId === operation.operationId)?.status
  ).toBe("prepared")
  const draft = next.sessions.read(scope, "docs")
  await next.sessions.save(
    scope,
    { id: draft.id, name: draft.name, revision: draft.revision, files: draft.source.files },
    () => undefined
  )
  await expect(next.recover(first.project.projectId)).rejects.toThrow(
    "PROJECT_DRAFT_REVISION_CHANGED"
  )
  expect(next.registry.retained({ ...scope, threadId: "foreign" }, "docs")).toBeUndefined()
  next.registry.finishRetained(
    scope,
    "docs",
    first.project,
    next.service.operations(first.project.projectId),
    (id) => next.service.cancel(id)
  )
  expect(next.registry.retained(scope, "docs")).toBeUndefined()
  expect(first.executions()).toBe(0)
})
