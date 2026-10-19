import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../../types"
import type { DevelopmentScope } from "../v2/development-session"
import type { DerivationServiceDependencies } from "../../plugins/derivation-service"
import { CreatorProjectDeliveries } from "./creator-project-delivery"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { ProjectPreviewRegistry } from "./project-preview-registry"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import {
  parseProjectRuntimeManifest,
  wrapProjectRuntimeManifest,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL
} from "../../../shared/project-runtime"
import { renameDerivation, snapshotDerivationSource } from "../../plugins/derivation-source"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(v2 = false) {
  const root = await mkdtemp(join(tmpdir(), "creator-project-delivery-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key: string, previous: string | undefined, value: string) => {
      if (values.get(key) !== previous) return false
      values.set(key, value)
      return true
    }
  }
  const sessions = new ProjectAuthoringSessions(async () => [])
  sessions.configurePersistence(settings, join(root, "source"))
  let token = "first-incarnation"
  const scope: DevelopmentScope = {
    threadId: "creator-delivery",
    workspace: "creator-workspace",
    incarnation: { token, legacyCreatedAt: 1 }
  }
  let occupied = false
  const plugins: PluginMetadata[] = []
  let installFailure = false
  let installBarrier: Promise<void> | undefined
  const installed = vi.fn<DerivationServiceDependencies["install"]>(
    async (source, name, id, guard, verify) => {
      if (installBarrier) await installBarrier
      guard()
      if (installFailure) throw Error("original native installer uncertain")
      const directory = join(root, "installed", id)
      await cp(source, directory, { recursive: true })
      await verify(directory)
      guard()
      plugins.push({ id, name, version: "1.2.3", enabled: true, path: directory } as PluginMetadata)
      return { success: true }
    }
  )
  const invalidated = vi.fn()
  const changed = vi.fn()
  const create = () =>
    new CreatorProjectDeliveries({
      root: join(root, "delivery"),
      settings,
      sessions,
      context: () => {
        const captured = token
        return {
          scope: { ...scope, incarnation: { ...scope.incarnation, token } },
          assertCurrent: () => {
            if (token !== captured) throw Error("DELIVERY_SCOPE_CHANGED")
          }
        } as never
      },
      occupied: () => occupied,
      plugins: () => plugins,
      install: installed,
      invalidate: invalidated,
      changed,
      actions: async () => []
    })
  const delivery = create()
  const initial = await sessions.scaffold(
    scope,
    "original-draft",
    "Original document project",
    () => {}
  )
  const resources = [
    { path: "knowledge/policy.txt", text: "Preserve exact original knowledge\r\n${POLICY_ROOT}\n" },
    { path: "hooks/original.py", text: "# Original Hook source; never execute while packing\n" }
  ]
  const draft = await sessions.save(
    scope,
    {
      id: initial.id,
      name: initial.name,
      revision: initial.revision,
      files: [
        ...initial.source.files.map((file) =>
          v2 && file.path === "devclaw.project-runtime.json"
            ? {
                ...file,
                text:
                  JSON.stringify(
                    wrapProjectRuntimeManifest(parseProjectRuntimeManifest(JSON.parse(file.text)), {
                      apiVersion: "devclaw.extension-contract/v1",
                      requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
                    }),
                    null,
                    2
                  ) + "\n"
              }
            : file
        ),
        ...resources
      ]
    },
    () => {},
    ["knowledge/policy.txt"]
  )
  const requested = await sessions.requestTrial(
    scope,
    draft.id,
    draft.revision,
    "Create a checked document",
    () => {},
    []
  )
  async function prepare(name = "independent-delivery") {
    return delivery.prepare(scope.threadId, scope.workspace, {
      requestId: requested.request.id,
      digest: requested.request.digest,
      name,
      version: "1.2.3"
    })
  }
  async function bindNativeTrial() {
    const store = new HostProjectStore(join(root, `projects-${randomUUID()}.sqlite`))
    cleanup.push(async () => {
      store.close()
    })
    const snapshots = new HostPackageSnapshots(join(root, "project-snapshots"))
    const registry = new ProjectPreviewRegistry()
    const lease = sessions.acquireDevelopment(scope, draft.id, draft.revision, () => {})
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
      executeSkill: async () => {
        throw Error("This regression must not execute a stage")
      }
    })
    const projectId = randomUUID()
    const plugin = await registry.register({
      projectId,
      scope,
      snapshot: lease.snapshot,
      guard: () => {},
      release: lease.release,
      actions: []
    })
    const project = await service.localCreate({
      projectId,
      name: draft.name,
      workspace: lease.snapshot.workspace,
      installedPluginId: plugin.id,
      goal: requested.request.goal
    })
    await registry.bind(project, snapshots.read(project.pluginDigest).root)
    sessions.configureTrialObservation((id) => ({
      project: service.get(id),
      operations: service.operations(id, 100)
    }))
    sessions.bindTrialProject(scope, draft.id, project, () => {})
    return project
  }
  const saveNewRevision = () =>
    sessions.save(
      scope,
      {
        id: draft.id,
        name: draft.name,
        revision: draft.revision,
        files: draft.source.files.map((file) =>
          file.path.startsWith("skills/")
            ? { ...file, text: file.text + "\nNEW_CANDIDATE_NOT_YET_REQUESTED\n" }
            : file
        )
      },
      () => {}
    )
  return {
    root,
    delivery,
    sessions,
    scope,
    draft,
    resources,
    plugins,
    installed,
    invalidated,
    create,
    prepare,
    bindNativeTrial,
    saveNewRevision,
    request: requested.request,
    values,
    input: (status: NonNullable<Awaited<ReturnType<typeof prepare>>>) => ({
      deliveryId: status.id,
      digest: status.digest
    }),
    occupied: (value: boolean) => {
      occupied = value
    },
    changeScope: () => {
      token = "new-incarnation"
    },
    failInstall: () => {
      installFailure = true
    },
    blockInstall: (barrier: Promise<void>) => {
      installBarrier = barrier
    }
  }
}

describe("Creator checked project delivery", () => {
  it("does not deliver new source B under an old bound native trial request A", async () => {
    const f = await fixture()
    const project = await f.bindNativeTrial()
    const updated = await f.saveNewRevision()
    expect(updated.revision).toBe(f.request.revision + 1)
    expect(updated.source.digest).not.toBe(f.request.digest)
    // The real native association must retain A for historical inspection. It is not B's admission.
    expect(f.sessions.trialRequest(f.scope)).toMatchObject({
      id: f.request.id,
      digest: f.request.digest,
      revision: f.request.revision,
      journey: { projectId: project.projectId, candidateCurrent: false, canDeliver: false }
    })
    await expect(f.prepare()).rejects.toThrow("PROJECT_DELIVERY_CANDIDATE_CHANGED")
    expect(f.delivery.status(f.scope.threadId)).toBeUndefined()
    expect(f.installed).not.toHaveBeenCalled()
  })

  it("invalidates prepared delivery A when source B is saved without requesting a new trial", async () => {
    const f = await fixture()
    await f.bindNativeTrial()
    const prepared = await f.prepare()
    await f.saveNewRevision()
    expect(f.sessions.trialRequest(f.scope)).toMatchObject({
      id: f.request.id,
      digest: f.request.digest
    })
    expect(f.delivery.status(f.scope.threadId)).toMatchObject({
      canInstall: false,
      canExport: false
    })
    await expect(
      f.delivery.install(f.scope.threadId, f.scope.workspace, f.input(prepared!))
    ).rejects.toThrow()
    const output = join(f.root, "old-bound-request-must-not-export.zip")
    await expect(
      f.delivery.export(f.scope.threadId, f.scope.workspace, f.input(prepared!), output)
    ).rejects.toThrow()
    expect(existsSync(output)).toBe(false)
    expect(f.installed).not.toHaveBeenCalled()
  })

  it("renames independently, checks and really exports a ZIP with all source resources intact", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    expect(prepared).toMatchObject({
      phase: "needs-confirmation",
      name: "independent-delivery",
      version: "1.2.3",
      canInstall: true,
      canExport: true
    })
    expect(f.installed).not.toHaveBeenCalled()
    const originalManifest = JSON.parse(
      await readFile(join(f.draft.directory, "plugin.json"), "utf8")
    )
    expect(originalManifest.name).toBe("original-draft")
    const output = join(f.root, "checked-delivery.zip")
    const exported = await f.delivery.export(
      f.scope.threadId,
      f.scope.workspace,
      f.input(prepared!),
      output
    )
    expect(exported).toMatchObject({ phase: "exported", output })
    const archive = new AdmZip(output)
    expect(JSON.parse(archive.readAsText("plugin.json"))).toMatchObject({
      name: "independent-delivery",
      version: "1.2.3"
    })
    expect(JSON.parse(archive.readAsText("devclaw.project-runtime.json")).plugin).toEqual({
      id: "independent-delivery",
      version: "1.2.3"
    })
    for (const resource of f.resources)
      expect(archive.readAsText(resource.path)).toBe(resource.text)
    expect(JSON.parse(archive.readAsText("devclaw.package-report.json")).tests.valid).toBe(true)
    expect(f.installed).not.toHaveBeenCalled()
  })

  it("retains the complete v2 extension contract when deriving, installing and exporting a Host candidate", async () => {
    const f = await fixture(true)
    const sourceFile = join(f.draft.directory, "devclaw.project-runtime.json")
    const originalBytes = await readFile(sourceFile)
    const original = JSON.parse(originalBytes.toString("utf8"))
    const snapshot = await snapshotDerivationSource(f.draft.directory)
    const renamed = renameDerivation(snapshot, "ordinary-v2-copy")
    const ordinary = JSON.parse(
      renamed.find((file) => file.path === "devclaw.project-runtime.json")!.bytes.toString("utf8")
    )
    expect(ordinary).toEqual({
      ...original,
      runtime: {
        ...original.runtime,
        plugin: { ...original.runtime.plugin, id: "ordinary-v2-copy" }
      }
    })
    const prepared = await f.prepare()
    const input = f.input(prepared!)
    await f.delivery.install(f.scope.threadId, f.scope.workspace, input)
    const output = join(f.root, "v2-delivery.zip")
    await f.delivery.export(f.scope.threadId, f.scope.workspace, input, output)
    const archive = new AdmZip(output)
    const expected = {
      ...original,
      runtime: {
        ...original.runtime,
        plugin: { id: "independent-delivery", version: "1.2.3" }
      }
    }
    expect(JSON.parse(archive.readAsText("devclaw.project-runtime.json"))).toEqual(expected)
    expect(
      JSON.parse(await readFile(join(f.plugins[0].path, "devclaw.project-runtime.json"), "utf8"))
    ).toEqual(expected)
    expect(await readFile(sourceFile)).toEqual(originalBytes)
    for (const resource of f.resources)
      expect(archive.readAsText(resource.path)).toBe(resource.text)
    expect(f.installed).toHaveBeenCalledOnce()
  })

  it("installs only through the explicit original dependency, and exporting does not allow a second install", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    const input = f.input(prepared!)
    const installed = await f.delivery.install(f.scope.threadId, f.scope.workspace, input)
    expect(installed).toMatchObject({
      phase: "installed",
      canInstall: false,
      pluginId: expect.any(String)
    })
    expect(f.installed).toHaveBeenCalledOnce()
    expect(f.invalidated).toHaveBeenCalledOnce()
    await f.delivery.export(
      f.scope.threadId,
      f.scope.workspace,
      input,
      join(f.root, "installed-export.zip")
    )
    expect(f.delivery.status(f.scope.threadId)?.canInstall).toBe(false)
    await expect(f.delivery.install(f.scope.threadId, f.scope.workspace, input)).rejects.toThrow()
    expect(f.installed).toHaveBeenCalledOnce()
  })

  it("rejects a duplicate installed name at preparation and a name taken after preparation", async () => {
    const f = await fixture()
    f.plugins.push({ id: "other", name: "INDEPENDENT-DELIVERY" } as PluginMetadata)
    await expect(f.prepare()).rejects.toThrow("NAME_ALREADY_INSTALLED")
    f.plugins.splice(0)
    const prepared = await f.prepare()
    f.plugins.push({ id: "late", name: "independent-delivery" } as PluginMetadata)
    await expect(
      f.delivery.install(f.scope.threadId, f.scope.workspace, f.input(prepared!))
    ).rejects.toThrow()
    expect(f.installed).not.toHaveBeenCalled()
  })

  it("rejects direct source mutation before preparing and after a checked delivery was prepared", async () => {
    const f = await fixture()
    await writeFile(join(f.draft.directory, "knowledge/policy.txt"), "Changed original knowledge\n")
    await expect(f.prepare()).rejects.toThrow()
    expect(f.installed).not.toHaveBeenCalled()
    const g = await fixture()
    const prepared = await g.prepare()
    await writeFile(join(g.draft.directory, "hooks/original.py"), "# Changed source hook\n")
    await expect(
      g.delivery.install(g.scope.threadId, g.scope.workspace, g.input(prepared!))
    ).rejects.toThrow()
    expect(g.installed).not.toHaveBeenCalled()
  })

  it("rejects a tampered materialized package before install or export", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await writeFile(
      join(f.root, "delivery", prepared!.id, "knowledge/policy.txt"),
      "Tampered checked package\n"
    )
    const input = f.input(prepared!)
    await expect(f.delivery.install(f.scope.threadId, f.scope.workspace, input)).rejects.toThrow(
      "PACKAGE_CHANGED"
    )
    const output = join(f.root, "must-not-export.zip")
    await expect(
      f.delivery.export(f.scope.threadId, f.scope.workspace, input, output)
    ).rejects.toThrow("PACKAGE_CHANGED")
    expect(existsSync(output)).toBe(false)
    expect(f.installed).not.toHaveBeenCalled()
  })

  it("blocks stale trial revisions, cross-workspace and cross-incarnation delivery", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await expect(
      f.delivery.install(f.scope.threadId, "other-workspace", f.input(prepared!))
    ).rejects.toThrow()
    f.changeScope()
    expect(f.delivery.status(f.scope.threadId)).toBeUndefined()
    await expect(
      f.delivery.export(
        f.scope.threadId,
        f.scope.workspace,
        f.input(prepared!),
        join(f.root, "wrong-scope.zip")
      )
    ).rejects.toThrow()
    const g = await fixture()
    const before = await g.prepare()
    await g.sessions.save(
      g.scope,
      {
        id: g.draft.id,
        name: g.draft.name,
        revision: g.draft.revision,
        files: g.draft.source.files.map((file) =>
          file.path === "hooks/original.py" ? { ...file, text: "# New revision\n" } : file
        )
      },
      () => {}
    )
    await expect(
      g.delivery.install(g.scope.threadId, g.scope.workspace, g.input(before!))
    ).rejects.toThrow()
    expect(g.installed).not.toHaveBeenCalled()
  })

  it("does not recover confirmation after restart or replay an uncertain installation", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    const restarted = f.create()
    expect(restarted.status(f.scope.threadId)).toMatchObject({
      phase: "unknown",
      canInstall: false,
      canExport: false
    })
    await expect(
      restarted.install(f.scope.threadId, f.scope.workspace, f.input(prepared!))
    ).rejects.toThrow("REVIEW_REQUIRED")
    f.failInstall()
    await expect(
      f.delivery.install(f.scope.threadId, f.scope.workspace, f.input(prepared!))
    ).rejects.toThrow()
    expect(f.delivery.status(f.scope.threadId)?.phase).toBe("unknown")
    await expect(
      f.delivery.install(f.scope.threadId, f.scope.workspace, f.input(prepared!))
    ).rejects.toThrow()
    await expect(f.prepare("another-delivery")).rejects.toThrow("OUTCOME_UNCONFIRMED")
    expect(f.installed).toHaveBeenCalledOnce()
  })

  it("serializes concurrent install/export attempts and honors conversation occupancy", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    const input = f.input(prepared!)
    f.occupied(true)
    await expect(f.delivery.install(f.scope.threadId, f.scope.workspace, input)).rejects.toThrow()
    f.occupied(false)
    let release!: () => void
    f.blockInstall(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const first = f.delivery.install(f.scope.threadId, f.scope.workspace, input)
    const second = f.delivery.export(
      f.scope.threadId,
      f.scope.workspace,
      input,
      join(f.root, "concurrent.zip")
    )
    const observed = [first, second].map((promise) =>
      promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
    )
    // Let both real snapshot validations cross their awaits, then release only the native installer.
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    release()
    const results = await Promise.all(observed)
    expect(results.filter((result) => "error" in result)).toHaveLength(1)
    expect(f.installed.mock.calls.length).toBeLessThanOrEqual(1)
    expect(f.delivery.status(f.scope.threadId)?.phase).not.toBe("unknown")
  })

  it("preserves an existing ZIP and allows a new export filename after an EEXIST rejection", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    const output = join(f.root, "already-exists.zip")
    await writeFile(output, "Existing user archive; do not overwrite\n")
    await expect(
      f.delivery.export(f.scope.threadId, f.scope.workspace, f.input(prepared!), output)
    ).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(output, "utf8")).toBe("Existing user archive; do not overwrite\n")
    expect(f.delivery.status(f.scope.threadId)).toMatchObject({
      phase: "needs-confirmation",
      canExport: true
    })
    const corrected = join(f.root, "new-output.zip")
    await f.delivery.export(f.scope.threadId, f.scope.workspace, f.input(prepared!), corrected)
    expect(new AdmZip(corrected).getEntry("devclaw.package-report.json")).not.toBeNull()
    expect(f.installed).not.toHaveBeenCalled()
  })
})
