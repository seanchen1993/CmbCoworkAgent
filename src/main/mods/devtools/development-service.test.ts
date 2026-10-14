import { describe, expect, it, vi } from "vitest"
import { AuthoringDraftStore } from "./authoring-store"
import { createAuthoringTemplate } from "./authoring-templates"
import { ModDevelopmentService, type DevelopmentRuntime } from "./development-service"

function fixture() {
  const settings = new Map<string, string>()
  const drafts = new AuthoringDraftStore({
    getSetting: (key, fallback) => settings.get(key) ?? fallback ?? "",
    compareAndSetSetting: (key, expected, value) => {
      if (settings.get(key) !== expected) return false
      settings.set(key, value)
      return true
    }
  })
  let token = "first"
  let canRun = true
  const runtime: DevelopmentRuntime = {
    developmentRetention: vi.fn(() => ({ releasable: true, revisions: [] })),
    stageDevelopment: vi.fn(),
    developmentStatus: vi.fn(() => []),
    approveDevelopment: vi.fn(),
    stopDevelopment: vi.fn()
  }
  const analyze = vi.fn(async (source) => ({
    digest: source.digest,
    valid: true,
    runtimeVerified: false,
    diagnostics: [],
    capabilities: []
  }))
  const service = new ModDevelopmentService({
    drafts,
    runtime,
    versionsRoot: "unused",
    workerEntry: "unused",
    changed: vi.fn(),
    analyze,
    canRun: () => canRun,
    context: (threadId) => {
      const captured = token
      return {
        scope: {
          workspace: "workspace",
          threadId,
          incarnation: { token: captured, legacyCreatedAt: 1 }
        },
        assertCurrent: () => {
          if (token !== captured) throw Error("DEVELOPMENT_SCOPE_CHANGED")
        }
      }
    }
  })
  const source = createAuthoringTemplate({
    id: "demo",
    name: "Demo",
    instruction: "Demo",
    kind: "command"
  })
  const save = (revision = 0) =>
    service.save("one", {
      id: "demo",
      name: "Demo",
      expectedRevision: revision,
      files: source.files
    })
  return {
    service,
    runtime,
    drafts,
    save,
    analyze,
    changeIdentity: () => {
      token = "second"
    },
    disableMods: () => {
      canRun = false
    }
  }
}

describe("conversational authoring scope", () => {
  it("does not revive an old project-preview authority after creator mode is re-enabled", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    const authority = f.service.projectAuthoringContext("one")
    authority.assertCurrent()
    await f.service.setEnabled("one", "workspace", false)
    expect(() => authority.assertCurrent()).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    await f.service.setEnabled("one", "workspace", true)
    expect(() => authority.assertCurrent()).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(() => f.service.projectAuthoringContext("one").assertCurrent()).not.toThrow()
  })
  it("reads before enabling and closing without granting or installing anything", async () => {
    const f = fixture()
    expect(f.service.status("one").enabled).toBe(false)
    expect(() => f.save()).toThrow("DEVELOPMENT_DISABLED")
    await f.service.setEnabled("one", "workspace", true)
    expect(f.save().revision).toBe(1)
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
    await f.service.setEnabled("one", "workspace", false)
    expect(f.service.status("one")).toMatchObject({ enabled: false, drafts: [{ revision: 1 }] })
  })
  it("isolates drafts from other threads and recreated thread identities", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    f.save()
    await f.service.setEnabled("two", "workspace", true)
    expect(f.service.status("two").drafts).toEqual([])
    expect(() => f.service.read("two", "demo")).toThrow("AUTHORING_VERSION_MISSING")
    f.changeIdentity()
    expect(f.service.status("one")).toMatchObject({ enabled: false, drafts: [] })
  })
  it("keeps shared draft storage unchanged until explicit promotion", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    f.save()
    expect(f.drafts.list("workspace")).toEqual([])
    const result = f.service.promote("one", "workspace", "demo", 1)
    expect(result.id).toMatch(/^creator-/)
    expect(f.drafts.list("workspace")).toHaveLength(1)
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
    expect(() => f.service.promote("one", "other", "demo", 1)).toThrow("DEVELOPMENT_SCOPE_CHANGED")
  })
  it("checks compare-and-swap revisions without altering saved content", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    const first = f.save()
    expect(() => f.save()).toThrow("AUTHORING_VERSION_CHANGED")
    await expect(f.service.check("one", "demo", 2, new AbortController().signal)).rejects.toThrow(
      "AUTHORING_VERSION_CHANGED"
    )
    expect(f.service.read("one", "demo").source).toEqual(first.source)
  })
  it("promotes full source identities without truncation collisions or overwriting edits", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    const ids = ["a".repeat(43) + "first", "a".repeat(43) + "other"]
    for (const id of ids) {
      const source = createAuthoringTemplate({ id, name: id, instruction: id, kind: "command" })
      f.service.save("one", { id, name: id, expectedRevision: 0, files: source.files })
    }
    const one = f.service.promote("one", "workspace", ids[0], 1)
    const two = f.service.promote("one", "workspace", ids[1], 1)
    expect(one.id).not.toBe(two.id)
    expect(f.service.promote("one", "workspace", ids[0], 1).revision).toBe(1)
    f.drafts.save({
      workspace: "workspace",
      id: one.id,
      name: "User edit",
      source: two.source,
      expectedRevision: 1,
      assertCurrent: () => {}
    })
    expect(() => f.service.promote("one", "workspace", ids[0], 1)).toThrow(
      "DEVELOPMENT_PROMOTION_CHANGED"
    )
    expect(f.drafts.list("workspace").find((item) => item.id === one.id)?.currentRevision).toBe(2)
  })
  it("does not activate a draft when asking for compiler diagnostics", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    f.save()
    expect(await f.service.check("one", "demo", 1, new AbortController().signal)).toMatchObject({
      valid: true,
      runtimeVerified: false
    })
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
  })
  it("refuses stale user approval and never expands permission from supplied ids", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    await expect(
      f.service.approve("one", "workspace", "missing", 1, "a".repeat(64))
    ).rejects.toThrow("DEVELOPMENT_APPROVAL_STALE")
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
  })
  it("respects the existing Mods master switch", async () => {
    const f = fixture()
    f.disableMods()
    await expect(f.service.setEnabled("one", "workspace", true)).rejects.toThrow(
      "DEVELOPMENT_MODS_DISABLED"
    )
    expect(f.service.status("one").enabled).toBe(false)
  })
})

it("reclaims invalid enabled scopes only when the host proves no retained runtime", async () => {
  const f = fixture()
  for (let index = 0; index < 16; index++)
    await f.service.setEnabled(`old-${index}`, "workspace", true)
  await expect(f.service.setEnabled("overflow", "workspace", true)).rejects.toThrow("SESSION_LIMIT")
  f.changeIdentity()
  await expect(f.service.setEnabled("fresh", "workspace", true)).resolves.toMatchObject({ enabled: true })
  expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
})

it.each(["active", "unknown", "draining"] as const)("does not evict stale %s ownership to make room", async (reason) => {
  const f = fixture()
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({ releasable: false, revisions: null, reason })
  for (let index = 0; index < 16; index++)
    await f.service.setEnabled(`old-${index}`, "workspace", true)
  f.changeIdentity()
  await expect(f.service.setEnabled("fresh", "workspace", true)).rejects.toThrow("SESSION_LIMIT")
  expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
})

it("releases only unreferenced prepared memory receipts, without deleting durable sources", async () => {
  const f = fixture()
  const scope = { workspace: "workspace", threadId: "one", incarnation: { token: "first", legacyCreatedAt: 1 } }
  // Cache bookkeeping has no filesystem operations; these opaque values must never be entered.
  const cache = (f.service as unknown as { prepared: Map<string, unknown> }).prepared
  const first = { scope, revision: 1 }, second = { scope, revision: 2 }, third = { scope, revision: 3 }
  cache.set("old", first); cache.set("active", second); cache.set("pending", third)
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({ releasable: false, revisions: [2, 3], reason: "active" })
  await f.service.setEnabled("one", "workspace", true)
  expect([...cache.keys()]).toEqual(["active", "pending"])
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({ releasable: false, revisions: null, reason: "unknown" })
  await f.service.setEnabled("one", "workspace", true)
  expect([...cache.keys()]).toEqual(["active", "pending"])
  expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
})


it("keeps development revision numbers monotonic beyond sixteen while retaining active source history", async () => {
  const f = fixture()
  await f.service.setEnabled("one", "workspace", true)
  f.save()
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({ releasable: false, revisions: [1], reason: "active" })
  for (let revision = 1; revision < 24; revision++) expect(f.save(revision).revision).toBe(revision + 1)
  const draft = f.service.read("one", "demo")
  expect(draft.versions.map(row => row.revision)).toEqual([1, 22, 23, 24])
  expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
})

it("unknown development ownership prevents compacting history to bypass capacity", async () => {
  const f = fixture()
  await f.service.setEnabled("one", "workspace", true)
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({ releasable: false, revisions: null, reason: "unknown" })
  for (let revision = 0; revision < 16; revision++) f.save(revision)
  expect(() => f.save(16)).toThrow("LIMIT")
  expect(f.service.read("one", "demo").versions).toHaveLength(16)
})

it("a reentrant retention change aborts draft compaction before its CAS", async () => {
  const f = fixture()
  await f.service.setEnabled("one", "workspace", true)
  f.save()
  vi.mocked(f.runtime.developmentRetention)
    .mockReturnValueOnce({ releasable: true, revisions: [] })
    .mockReturnValue({ releasable: false, revisions: null, reason: "unknown" })
  expect(() => f.save(1)).toThrow("DEVELOPMENT_RETENTION_CHANGED")
  expect(f.service.read("one", "demo").revision).toBe(1)
})

it("prepared collection protects latest snapshots, runtime revisions and physical source references", async () => {
  const f = fixture()
  await f.service.setEnabled("one", "workspace", true)
  const scope = { workspace: "workspace", threadId: "one", incarnation: { token: "first", legacyCreatedAt: 1 } }
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({ releasable: false, revisions: [1], reason: "active" })
  f.runtime.referencesSourceDirectory = path => path.includes("physical")
  const records = [
    { versionId: "active", revision: 1 }, { versionId: "unused", revision: 2 },
    { versionId: "physical", revision: 3 }, { versionId: "previous", revision: 4 },
    { versionId: "latest", revision: 5 }
  ].map(row => ({ ...row, draftId: "demo", workspace: "workspace", createdAt: row.revision }))
  const collected: string[] = []
  const repository = { listRecords: () => records,
    collectUnreferenced: (_workspace: string, retained: (row: typeof records[number]) => boolean) => {
      for (const row of records) if (!retained(row)) collected.push(row.versionId)
    } }
  const collect = (f.service as unknown as { collectPrepared(scope: unknown, repository: unknown, guard: () => void): void }).collectPrepared.bind(f.service)
  collect(scope, repository, () => {})
  expect(collected).toEqual(["unused"])
  collected.length = 0
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({ releasable: false, revisions: null, reason: "draining" })
  collect(scope, repository, () => {})
  expect(collected).toEqual([])
})
