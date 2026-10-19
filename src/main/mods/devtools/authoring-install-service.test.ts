import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { PluginCatalogIndex } from "../../plugins/catalog-index"
import { pluginCatalogGate } from "../../plugins/catalog-gate"
import { AuthoringDraftStore } from "./authoring-store"
import { AuthoringVersionRepository } from "./authoring-version-repository"
import { AuthoringPreflightClient } from "./authoring-preflight-client"
import { createAuthoringTemplate } from "./authoring-templates"
import { AuthoringInstallService } from "./authoring-install-service"
import { AuthoringInstallJournal } from "./authoring-install-journal"

let root: string, store: ModControlStore, drafts: AuthoringDraftStore
let versions: AuthoringVersionRepository,
  index: PluginCatalogIndex,
  service: AuthoringInstallService
let busy: boolean, valid: boolean
const changed = vi.fn()
const referenced = new Set<string>()
const binding = () => ({
  workspace: "workspace",
  signal: new AbortController().signal,
  assertCurrent: () => {
    if (!valid) throw Error("SCOPE")
  }
})
const configKey = 'function-user-config:["workspace","sample"]'
function makeService() {
  return new AuthoringInstallService({
    settings: store,
    drafts,
    versions,
    index,
    versionsRoot: join(root, "versions"),
    isVersionReferenced: (directory) => referenced.has(directory),
    changed,
    assertIdle: () => {
      if (busy) throw Error("PLUGIN_CATALOG_BUSY")
    },
    inspectNames: async () => ({ names: [], assertCurrent: () => {} })
  })
}
function draft(revision = 0, instruction = "old") {
  const source = createAuthoringTemplate({
    id: "sample",
    name: "Sample",
    kind: "command",
    instruction
  })
  drafts.save({
    workspace: "workspace",
    id: "draft",
    name: "Draft",
    source,
    expectedRevision: revision,
    assertCurrent: () => {}
  })
  return { draftId: "draft", revision: revision + 1, sourceDigest: source.digest }
}
const apply = (candidate: Awaited<ReturnType<AuthoringInstallService["prepare"]>>) =>
  service.apply(
    { handle: candidate.handle, expectedCatalogDigest: candidate.catalogDigest },
    binding()
  )

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "creator-apply-"))
  store = new ModControlStore(join(root, "control.sqlite"))
  drafts = new AuthoringDraftStore(store)
  versions = new AuthoringVersionRepository(
    join(root, "versions"),
    join(root, "unused-unit-worker")
  )
  index = new PluginCatalogIndex(join(root, "plugins.json"))
  busy = false
  valid = true
  changed.mockReset()
  referenced.clear()
  // These tests isolate real FS/index/SQLite orchestration. Real Worker tests live in repository tests.
  vi.spyOn(AuthoringPreflightClient.prototype, "run").mockImplementation(async (directory) => {
    const digest = createHash("sha256")
      .update(readFileSync(join(directory, "mods/main.ts")))
      .digest("hex")
    return {
      compiled: { digest },
      sdk: { strictCompatible: true },
      typecheck: { digest, valid: true }
    } as Awaited<ReturnType<AuthoringPreflightClient["run"]>>
  })
  service = makeService()
})
afterEach(() => {
  vi.restoreAllMocks()
  store.close()
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("creator-apply-"))
    throw Error("TEST_CLEANUP_BOUNDARY")
  rmSync(root, { recursive: true, force: true })
})

describe("creator installation through real index and control store", () => {
  it("retires an old terminal self-observation after later current and rollback versions exist", async () => {
    const request = draft()
    const first = await service.prepare(request, binding())
    const replace = index.replace.bind(index)
    vi.spyOn(index, "replace").mockImplementationOnce((...args) => {
      replace(...args)
      throw Error("LOST_ACK_AFTER_WRITE")
    })
    const uncertain = await apply(first)
    const observation = service.inspectUncertain({ operationId: uncertain.operationId }, binding())
    expect(observation.catalog).toBe("after")
    await service.reconcile(
      {
        operationId: uncertain.operationId,
        expectedInspectionDigest: observation.inspectionDigest
      },
      binding()
    )
    await apply(await service.prepare(request, binding()))
    await apply(await service.prepare(request, binding()))
    const inventory = service.inspectRetention(binding())
    expect(
      inventory.versions.find((version) => version.versionId === first.versionId)
    ).toMatchObject({ reason: "eligible", canRetire: true, requiredVersionIds: [first.versionId] })
    const result = await service.retireVersions(
      {
        expectedFingerprint: inventory.fingerprint,
        versionIds: [first.versionId],
        acknowledgeLostRollback: true
      },
      binding()
    )
    expect(result.usedVersions).toBe(2)
    expect(service.list(binding()).installations[0].versions).toHaveLength(2)
  })

  it("requires the complete terminal observation closure and protects external live references", async () => {
    const request = draft()
    const first = await service.prepare(request, binding())
    await apply(first)
    const observedBy = await service.prepare(request, binding())
    vi.spyOn(index, "replace").mockImplementationOnce(() => {
      throw Error("BEFORE_WRITE")
    })
    const uncertain = await apply(observedBy)
    const observation = service.inspectUncertain({ operationId: uncertain.operationId }, binding())
    expect(observation.observedVersionId).toBe(first.versionId)
    await service.reconcile(
      {
        operationId: uncertain.operationId,
        expectedInspectionDigest: observation.inspectionDigest
      },
      binding()
    )
    await apply(await service.prepare(request, binding()))
    await apply(await service.prepare(request, binding()))
    referenced.add(join(root, "versions", observedBy.versionId, "source"))
    const protectedInventory = service.inspectRetention(binding())
    expect(
      protectedInventory.versions.find((version) => version.versionId === first.versionId)
    ).toMatchObject({ reason: "uncertain", canRetire: false })
    referenced.clear()
    const inventory = service.inspectRetention(binding())
    expect(
      inventory.versions.find((version) => version.versionId === first.versionId)
        ?.requiredVersionIds
    ).toEqual([first.versionId, observedBy.versionId].sort())
    await expect(
      service.retireVersions(
        {
          expectedFingerprint: inventory.fingerprint,
          versionIds: [first.versionId],
          acknowledgeLostRollback: true
        },
        binding()
      )
    ).rejects.toThrow("CHANGED")
    expect(() =>
      new AuthoringInstallJournal(store).retireVersions(new Set([first.versionId]), () => {})
    ).toThrow("PENDING")
    expect(service.inspectRetention(binding()).pendingVersionIds).toEqual([])
    const result = await service.retireVersions(
      {
        expectedFingerprint: inventory.fingerprint,
        versionIds: [first.versionId, observedBy.versionId],
        acknowledgeLostRollback: true
      },
      binding()
    )
    expect(result.usedVersions).toBe(2)
    expect(service.list(binding()).installations[0].versions).toHaveLength(2)
  })

  it("explicitly retires old installed sources at capacity and continues beyond sixteen installs", async () => {
    const request = draft()
    const installed: string[] = []
    for (let i = 0; i < 16; i++) {
      const candidate = await service.prepare(request, binding())
      await apply(candidate)
      installed.push(candidate.versionId)
    }
    const observation = service.inspectRetention(binding())
    expect(observation.usedVersions).toBe(16)
    expect(
      observation.versions
        .filter((version) => version.reason === "current")
        .map((version) => version.versionId)
    ).toEqual([installed[15]])
    expect(
      observation.versions
        .filter((version) => version.reason === "rollback")
        .map((version) => version.versionId)
    ).toEqual([installed[14]])
    const selected = observation.versions
      .filter((version) => version.canRetire)
      .map((version) => version.versionId)
    expect(selected).toHaveLength(14)
    const retired = await service.retireVersions(
      {
        expectedFingerprint: observation.fingerprint,
        versionIds: selected,
        acknowledgeLostRollback: true
      },
      binding()
    )
    expect(retired.usedVersions).toBe(2)
    expect(retired.retiredVersions).toBe(14)
    expect(service.list(binding()).installations[0].versions).toHaveLength(2)
    await expect(
      service.rollbackPrepare(
        {
          installationId: service.list(binding()).installations[0].installationId,
          versionId: installed[0],
          restoreConfiguration: false
        },
        binding()
      )
    ).rejects.toThrow("OWNERSHIP_CHANGED")
    for (let i = 0; i < 4; i++) await apply(await service.prepare(request, binding()))
    expect(service.inspectRetention(binding()).usedVersions).toBe(6)
    const rollback = await service.rollbackPrepare(
      {
        installationId: service.list(binding()).installations[0].installationId,
        versionId: installed[14],
        restoreConfiguration: false
      },
      binding()
    )
    expect((await apply(rollback)).state).toBe("settled")
  }, 30_000)

  it("requires fresh consent and protects actual runtime source references", async () => {
    const request = draft()
    const first = await service.prepare(request, binding())
    await apply(first)
    await apply(await service.prepare(request, binding()))
    await apply(await service.prepare(request, binding()))
    const before = service.inspectRetention(binding())
    referenced.add(join(root, "versions", first.versionId, "source"))
    expect(
      service
        .inspectRetention(binding())
        .versions.find((version) => version.versionId === first.versionId)?.reason
    ).toBe("candidate")
    await expect(
      service.retireVersions(
        {
          expectedFingerprint: before.fingerprint,
          versionIds: [first.versionId],
          acknowledgeLostRollback: true
        },
        binding()
      )
    ).rejects.toThrow("CHANGED")
    expect(versions.read(first.versionId).versionId).toBe(first.versionId)
  })

  it("resumes an explicitly acknowledged partial deletion after reopening", async () => {
    const request = draft()
    const first = await service.prepare(request, binding())
    await apply(first)
    await apply(await service.prepare(request, binding()))
    await apply(await service.prepare(request, binding()))
    const initial = service.inspectRetention(binding())
    vi.spyOn(versions, "retireRecords").mockImplementationOnce(() => {
      unlinkSync(join(root, "versions", first.versionId, "source", "mods", "main.ts"))
      throw Error("TEST_PARTIAL_DELETE")
    })
    await expect(
      service.retireVersions(
        {
          expectedFingerprint: initial.fingerprint,
          versionIds: [first.versionId],
          acknowledgeLostRollback: true
        },
        binding()
      )
    ).rejects.toThrow("TEST_PARTIAL_DELETE")
    service = makeService()
    const pending = service.inspectRetention(binding())
    expect(pending.pendingVersionIds).toEqual([first.versionId])
    expect(pending.versions.find((version) => version.versionId === first.versionId)?.reason).toBe(
      "cleanup-failed"
    )
    const result = await service.retireVersions(
      {
        expectedFingerprint: pending.fingerprint,
        versionIds: pending.pendingVersionIds,
        acknowledgeLostRollback: true
      },
      binding()
    )
    expect(result.usedVersions).toBe(2)
    expect(result.pendingVersionIds).toEqual([])
    expect(service.list(binding()).installations[0].versions).toHaveLength(2)
  })

  it("compacts repeated settled journal operations without losing rollback configuration", async () => {
    const request = draft()
    const first = await service.prepare(request, binding())
    await apply(first)
    for (let i = 0; i < 66; i++) {
      const candidate = await service.rollbackPrepare(
        {
          installationId: first.installationId,
          versionId: first.versionId,
          restoreConfiguration: false
        },
        binding()
      )
      expect((await apply(candidate)).state).toBe("settled")
    }
    expect(new AuthoringInstallJournal(store).listAll().length).toBeLessThan(64)
    expect(service.list(binding()).installations[0].currentVersionId).toBe(first.versionId)
  }, 20000)

  it("restores only the exact installed draft receipt after reopening without an apply handle", async () => {
    const request = draft()
    const candidate = await service.prepare(request, binding())
    await expect(service.resolveInstalled(request, binding())).resolves.toBeNull()
    await apply(candidate)
    service = makeService()
    const receipt = await service.resolveInstalled(request, binding())
    expect(receipt).toEqual({
      installationId: candidate.installationId,
      versionId: candidate.versionId,
      name: "sample",
      sourceDigest: candidate.sourceDigest,
      compiledDigest: candidate.compiledDigest
    })
    expect(receipt).not.toHaveProperty("handle")
    await expect(
      service.resolveInstalled({ ...request, revision: 2 }, binding())
    ).resolves.toBeNull()
    await expect(
      service.resolveInstalled({ ...request, draftId: "another" }, binding())
    ).resolves.toBeNull()
    await expect(
      service.resolveInstalled({ ...request, sourceDigest: "0".repeat(64) }, binding())
    ).resolves.toBeNull()
    await expect(
      service.resolveInstalled(request, { ...binding(), workspace: "another" })
    ).resolves.toBeNull()
    const next = await service.prepare(draft(1, "new"), binding())
    await apply(next)
    await expect(service.resolveInstalled(request, binding())).resolves.toBeNull()
  })

  it("does not restore a receipt from uncertain installation or changed compiled source", async () => {
    const request = draft()
    const candidate = await service.prepare(request, binding())
    await apply(candidate)
    vi.spyOn(AuthoringPreflightClient.prototype, "run").mockResolvedValueOnce({
      compiled: { digest: "0".repeat(64) },
      sdk: { strictCompatible: true },
      typecheck: { digest: "0".repeat(64), valid: true }
    } as Awaited<ReturnType<AuthoringPreflightClient["run"]>>)
    await expect(service.resolveInstalled(request, binding())).rejects.toThrow("RECHECK_REQUIRED")
    const nextRequest = draft(1, "new")
    const next = await service.prepare(nextRequest, binding())
    vi.spyOn(index, "replace").mockImplementationOnce(() => {
      throw Error("lost-ack")
    })
    expect((await apply(next)).state).toBe("unknown")
    await expect(service.resolveInstalled(request, binding())).resolves.toBeNull()
    await expect(service.resolveInstalled(nextRequest, binding())).resolves.toBeNull()
  })

  it("reclaims canceled preparations repeatedly beyond the global quota", async () => {
    const request = draft()
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = await service.prepare(request, binding())
      await service.discardPrepared(candidate.handle)
      expect(readdirSync(join(root, "versions"))).toEqual([])
      await expect(apply(candidate)).rejects.toThrow("STALE")
    }
    expect(service.list(binding()).installations).toEqual([])
  })

  it("reclaims old complete orphans across workspaces when the service opens the shared library", async () => {
    const request = draft()
    const source = drafts.list("workspace")[0].versions[0].source
    for (let attempt = 0; attempt < 16; attempt++) {
      await versions.prepare({
        installationId: "12345678-1234-4234-8234-123456789abc",
        workspace: "old-workspace",
        draftId: "old-draft",
        revision: 1,
        source,
        signal: new AbortController().signal,
        assertCurrent: () => {}
      })
    }
    service = makeService()
    const candidate = await service.prepare(request, binding())
    expect(readdirSync(join(root, "versions"))).toEqual([candidate.versionId])
  })

  it("defers busy cancellation cleanup until a later idle preparation", async () => {
    const request = draft()
    const candidate = await service.prepare(request, binding())
    busy = true
    await service.discardPrepared(candidate.handle)
    expect(versions.read(candidate.versionId).versionId).toBe(candidate.versionId)
    busy = false
    const next = await service.prepare(request, binding())
    expect(readdirSync(join(root, "versions"))).toEqual([next.versionId])
  })

  it("keeps candidates owned by another service and applied rollback history", async () => {
    const request = draft()
    const candidate = await service.prepare(request, binding())
    const other = makeService()
    const temporary = await other.prepare(request, binding())
    await other.discardPrepared(temporary.handle)
    expect(versions.read(candidate.versionId).versionId).toBe(candidate.versionId)
    await apply(candidate)
    const second = await service.prepare(draft(1, "new"), binding())
    await apply(second)
    const rollback = await service.rollbackPrepare(
      {
        installationId: candidate.installationId,
        versionId: candidate.versionId,
        restoreConfiguration: false
      },
      binding()
    )
    await service.discardPrepared(rollback.handle)
    expect(versions.read(candidate.versionId).versionId).toBe(candidate.versionId)
    expect(versions.read(second.versionId).versionId).toBe(second.versionId)
  })

  it("keeps a catalog-referenced directory even when no creator journal exists", async () => {
    const candidate = await service.prepare(draft(), binding())
    index.replace(
      index.capture(),
      JSON.stringify([
        {
          id: candidate.installationId,
          name: candidate.name,
          path: join(root, "versions", candidate.versionId, "source")
        }
      ])
    )
    await service.discardPrepared(candidate.handle)
    expect(new AuthoringInstallJournal(store).listAll()).toEqual([])
    expect(versions.read(candidate.versionId).versionId).toBe(candidate.versionId)
  })

  it("protects a prepared version while its service callback is still in flight", async () => {
    const request = draft()
    const old = await service.prepare(request, binding())
    let release!: () => void
    let completed!: () => void
    const paused = new Promise<void>((done) => {
      release = done
    })
    const prepared = new Promise<void>((done) => {
      completed = done
    })
    const original = versions.prepare.bind(versions)
    vi.spyOn(versions, "prepare").mockImplementationOnce(async (input) => {
      const result = await original(input)
      completed()
      await paused
      return result
    })
    const pending = makeService().prepare(request, binding())
    await prepared
    await service.discardPrepared(old.handle)
    expect(readdirSync(join(root, "versions"))).toHaveLength(2)
    release()
    const late = await pending
    expect(versions.read(late.versionId).versionId).toBe(late.versionId)
  })

  it("keeps unknown journal operations from another workspace during cleanup", async () => {
    const request = draft()
    const candidate = await service.prepare(request, binding())
    vi.spyOn(index, "replace").mockImplementationOnce(() => {
      throw Error("lost-ack")
    })
    expect((await apply(candidate)).state).toBe("unknown")
    const otherSource = createAuthoringTemplate({
      id: "other",
      name: "Other",
      kind: "command",
      instruction: "other"
    })
    drafts.save({
      workspace: "other",
      id: "draft",
      name: "Other",
      source: otherSource,
      expectedRevision: 0,
      assertCurrent: () => {}
    })
    const otherScope = { ...binding(), workspace: "other" }
    const temporary = await makeService().prepare(
      { draftId: "draft", revision: 1, sourceDigest: otherSource.digest },
      otherScope
    )
    expect(versions.read(candidate.versionId).versionId).toBe(candidate.versionId)
    expect(versions.read(temporary.versionId).versionId).toBe(temporary.versionId)
  })

  it("prepares during activity, refuses busy apply without changes and applies explicitly when idle", async () => {
    busy = true
    const candidate = await service.prepare(draft(), binding())
    expect(candidate.review.strictCompatible).toBe(true)
    expect(candidate.review.changedFiles).toContainEqual({ path: "mods/main.ts", change: "added" })
    expect(candidate.review.configurationKeys).toEqual([])
    expect(index.capture().raw).toBeNull()
    await expect(apply(candidate)).rejects.toThrow("BUSY")
    expect(new AuthoringInstallJournal(store).list("workspace")).toEqual([])
    busy = false
    expect((await apply(candidate)).state).toBe("settled")
    const metadata = JSON.parse(index.capture().raw!)[0]
    expect(metadata.path).toBe(join(root, "versions", candidate.versionId, "source"))
    expect(store.getGrant("workspace", "function:sample")).toBeNull()
    expect(changed).toHaveBeenCalledTimes(1)
    await expect(apply(candidate)).rejects.toThrow("STALE")
  })

  it("updates without overwriting old sources and restores old config with a fresh revision", async () => {
    store.setSetting(
      configKey,
      JSON.stringify({ revision: 1, values: { theme: "old" }, sealed: { token: "opaque" } })
    )
    const first = await service.prepare(draft(), binding())
    await apply(first)
    const oldSource = readFileSync(
      join(root, "versions", first.versionId, "source/mods/main.ts"),
      "utf8"
    )
    const second = await service.prepare(draft(1, "new"), binding())
    expect(second.installationId).toBe(first.installationId)
    await apply(second)
    expect(
      readFileSync(join(root, "versions", first.versionId, "source/mods/main.ts"), "utf8")
    ).toBe(oldSource)
    store.setSetting(configKey, JSON.stringify({ revision: 2, values: { theme: "new" } }))
    const rollback = await service.rollbackPrepare(
      {
        installationId: first.installationId,
        versionId: first.versionId,
        restoreConfiguration: true
      },
      binding()
    )
    expect(rollback.configuration).toBe("restore")
    expect((await apply(rollback)).state).toBe("settled")
    expect(JSON.parse(store.getSetting(configKey))).toEqual({
      revision: 3,
      values: { theme: "old" },
      sealed: { token: "opaque" }
    })
    expect(service.list(binding()).installations[0].currentVersionId).toBe(rollback.versionId)
  })

  it("rejects stale source, catalog, config and invalidated scope before intent", async () => {
    const request = draft(),
      candidate = await service.prepare(request, binding())
    draft(1, "changed")
    await expect(apply(candidate)).rejects.toThrow("STALE")
    const current = await service.prepare(
      {
        ...request,
        revision: 2,
        sourceDigest: drafts.list("workspace")[0].versions.at(-1)!.source.digest
      },
      binding()
    )
    store.setSetting(configKey, '{"revision":1,"values":{"x":1}}')
    await expect(apply(current)).rejects.toThrow("CONFIG_CHANGED")
    const last = await service.prepare(
      {
        ...request,
        revision: 2,
        sourceDigest: drafts.list("workspace")[0].versions.at(-1)!.source.digest
      },
      binding()
    )
    writeFileSync(join(root, "plugins.json"), "[]")
    await expect(apply(last)).rejects.toThrow("CATALOG_CHANGED")
    valid = false
    await expect(apply(last)).rejects.toThrow("SCOPE")
    expect(new AuthoringInstallJournal(store).list("workspace")).toEqual([])
  })

  it("does not take over same-name third-party plugins", async () => {
    index.replace(
      index.capture(),
      JSON.stringify([{ id: "foreign", name: "sample", path: "C:/foreign" }])
    )
    await expect(service.prepare(draft(), binding())).rejects.toThrow("NAME_EXISTS")
    expect(JSON.parse(index.capture().raw!)[0].id).toBe("foreign")
  })

  it("reports an index-committed/config-failed operation as partial and blocks further updates", async () => {
    const first = await service.prepare(draft(), binding())
    await apply(first)
    const second = await service.prepare(draft(1, "new"), binding())
    await apply(second)
    const rollback = await service.rollbackPrepare(
      {
        installationId: first.installationId,
        versionId: first.versionId,
        restoreConfiguration: true
      },
      binding()
    )
    const original = store.compareAndSetSetting.bind(store)
    vi.spyOn(store, "compareAndSetSetting").mockImplementation((key, expected, value) =>
      key === configKey ? false : original(key, expected, value)
    )
    expect((await apply(rollback)).state).toBe("partial")
    expect(service.list(binding()).installations[0].pending?.state).toBe("partial")
    expect(changed).toHaveBeenCalledTimes(3)
    await expect(
      service.prepare(
        {
          draftId: "draft",
          revision: 2,
          sourceDigest: drafts.list("workspace")[0].versions.at(-1)!.source.digest
        },
        binding()
      )
    ).rejects.toThrow("PENDING")
  })

  it("does not renew prepared handles after restart or transfer them across scopes", async () => {
    const candidate = await service.prepare(draft(), binding())
    await expect(
      service.apply(
        { handle: candidate.handle, expectedCatalogDigest: candidate.catalogDigest },
        { ...binding(), workspace: "different" }
      )
    ).rejects.toThrow("STALE")
    service = makeService()
    await expect(apply(candidate)).rejects.toThrow("STALE")
    expect(index.capture().raw).toBeNull()
  })

  it("keeps actual activity occupancy until its release and retries the same candidate", async () => {
    const candidate = await service.prepare(draft(), binding()),
      release = pluginCatalogGate.retain()
    try {
      await expect(apply(candidate)).rejects.toThrow("BUSY")
    } finally {
      release()
    }
    expect((await apply(candidate)).state).toBe("settled")
  })
  it.each(["before", "after", "lost-ack"])(
    "explicitly reconciles %s without replaying catalog/config writes",
    async (point) => {
      const first = await service.prepare(draft(), binding())
      await apply(first)
      const second = await service.prepare(draft(1, "new"), binding())
      const replace = index.replace.bind(index)
      const spy = vi.spyOn(index, "replace")
      if (point === "before")
        spy.mockImplementationOnce(() => {
          throw Error("before-write")
        })
      if (point === "lost-ack")
        spy.mockImplementationOnce((...args) => {
          replace(...args)
          throw Error("lost-ack")
        })
      if (point === "after")
        changed.mockImplementationOnce(() => {
          throw Error("after-write")
        })
      const uncertain = await apply(second)
      expect(["partial", "unknown"]).toContain(uncertain.state)
      const writes = spy.mock.calls.length,
        raw = index.capture().raw
      const before = new AuthoringInstallJournal(store).list("workspace")
      service = makeService()
      const observation = service.inspectUncertain(
        { operationId: uncertain.operationId },
        binding()
      )
      expect(observation.catalog).toBe(point === "before" ? "before" : "after")
      expect(observation.observedVersionId).toBe(
        point === "before" ? first.versionId : second.versionId
      )
      expect(new AuthoringInstallJournal(store).list("workspace")).toEqual(before)
      busy = true
      await expect(
        service.reconcile(
          {
            operationId: uncertain.operationId,
            expectedInspectionDigest: observation.inspectionDigest
          },
          binding()
        )
      ).rejects.toThrow("BUSY")
      busy = false
      expect(
        await service.reconcile(
          {
            operationId: uncertain.operationId,
            expectedInspectionDigest: observation.inspectionDigest
          },
          binding()
        )
      ).toMatchObject({ state: "reconciled" })
      expect(index.capture().raw).toBe(raw)
      expect(spy).toHaveBeenCalledTimes(writes)
      const journal = new AuthoringInstallJournal(store).list("workspace").at(-1)!
      expect(journal.phase).toBe("reconciled")
      expect(journal.reason).toBe(before.at(-1)!.reason)
      expect(journal.reconciliation?.originalPhase).toBe(before.at(-1)!.phase)
      expect(service.list(binding()).installations[0].currentVersionId).toBe(
        observation.observedVersionId
      )
      expect(service.list(binding()).installations[0].pending).toBeUndefined()
      await expect(
        service.reconcile(
          {
            operationId: uncertain.operationId,
            expectedInspectionDigest: observation.inspectionDigest
          },
          binding()
        )
      ).rejects.toThrow("STALE")
      await expect(service.prepare(draft(2, "third"), binding())).resolves.toMatchObject({
        installationId: first.installationId
      })
    }
  )

  it("keeps changed configuration only after fresh explicit inspection and exposes no raw values", async () => {
    const first = await service.prepare(draft(), binding())
    changed.mockImplementationOnce(() => {
      throw Error("lost-settlement")
    })
    const outcome = await apply(first)
    const old = service.inspectUncertain({ operationId: outcome.operationId }, binding())
    store.setSetting(
      configKey,
      JSON.stringify({
        revision: 1,
        values: { label: "do-not-return" },
        sealed: { token: "opaque-secret" }
      })
    )
    await expect(
      service.reconcile(
        { operationId: outcome.operationId, expectedInspectionDigest: old.inspectionDigest },
        binding()
      )
    ).rejects.toThrow("CHANGED")
    const current = service.inspectUncertain({ operationId: outcome.operationId }, binding())
    expect(current.configuration).toBe("different")
    expect(JSON.stringify(current)).not.toMatch(/do-not-return|opaque-secret/)
    const config = store.getSetting(configKey)
    await service.reconcile(
      { operationId: outcome.operationId, expectedInspectionDigest: current.inspectionDigest },
      binding()
    )
    expect(store.getSetting(configKey)).toBe(config)
    expect(store.getGrant("workspace", "function:sample")).toBeNull()
  })

  it("refuses an unrelated catalog change and never uses an abandoned version as current", async () => {
    const candidate = await service.prepare(draft(), binding())
    vi.spyOn(index, "replace").mockImplementationOnce(() => {
      throw Error("before-write")
    })
    const outcome = await apply(candidate)
    writeFileSync(join(root, "plugins.json"), "[]")
    const inspection = service.inspectUncertain({ operationId: outcome.operationId }, binding())
    expect(inspection.catalog).toBe("different")
    expect(inspection.canAccept).toBe(false)
    await expect(
      service.reconcile(
        { operationId: outcome.operationId, expectedInspectionDigest: inspection.inspectionDigest },
        binding()
      )
    ).rejects.toThrow("CHANGED")
    expect(service.list(binding()).installations[0].currentVersionId).toBeUndefined()
  })

  it("checks actual retained source and scope again before accepting uncertainty", async () => {
    const candidate = await service.prepare(draft(), binding())
    changed.mockImplementationOnce(() => {
      throw Error("lost-settlement")
    })
    const outcome = await apply(candidate)
    const inspection = service.inspectUncertain({ operationId: outcome.operationId }, binding())
    writeFileSync(join(root, "versions", candidate.versionId, "source/mods/main.ts"), "modified")
    await expect(
      service.reconcile(
        { operationId: outcome.operationId, expectedInspectionDigest: inspection.inspectionDigest },
        binding()
      )
    ).rejects.toThrow()
    valid = false
    expect(() => service.inspectUncertain({ operationId: outcome.operationId }, binding())).toThrow(
      "SCOPE"
    )
  })
})


it("waits for one apply admission without writing its journal before a short activity drains", async () => {
  const candidate = await service.prepare(draft(), binding())
  const journal = vi.spyOn(AuthoringInstallJournal.prototype, "begin")
  const release = pluginCatalogGate.retain()
  const pending = apply(candidate)
  await Promise.resolve()
  await Promise.resolve()
  expect(journal).not.toHaveBeenCalled()
  release()
  await expect(pending).resolves.toMatchObject({ state: "settled" })
  expect(journal).toHaveBeenCalledTimes(1)
})

it("does not write an apply whose candidate was discarded while admission waited", async () => {
  const candidate = await service.prepare(draft(), binding())
  const journal = vi.spyOn(AuthoringInstallJournal.prototype, "begin")
  const release = pluginCatalogGate.retain()
  const pending = apply(candidate)
  const rejection = expect(pending).rejects.toThrow("AUTHORING_INSTALL_STALE")
  await Promise.resolve()
  await Promise.resolve()
  const discarded = service.discardPrepared(candidate.handle)
  release()
  await rejection
  await discarded
  expect(journal).not.toHaveBeenCalled()
})
