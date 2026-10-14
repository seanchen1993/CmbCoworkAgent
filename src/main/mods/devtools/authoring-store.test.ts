import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, basename, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { AuthoringDraftStore } from "./authoring-store"
import { createAuthoringSourceBundle } from "./authoring-bundle"

const stores: ModControlStore[] = []
const roots: string[] = []
const bundle = (value = "first") =>
  createAuthoringSourceBundle([
    { path: "plugin.json", text: '{"name":"demo"}' },
    { path: "hooks/main.ts", text: value }
  ])
const input = (extra = {}) => ({
  workspace: "workspace",
  id: "demo",
  name: "Example",
  source: bundle(),
  expectedRevision: 0,
  assertCurrent: () => undefined,
  ...extra
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "mods-authoring-store-"))
  roots.push(root)
  const path = join(root, "control.sqlite")
  const store = new ModControlStore(path)
  stores.push(store)
  return { root, path, store, drafts: new AuthoringDraftStore(store) }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith("mods-authoring-store-")).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

describe("authoring draft source versions", () => {
  it("captures the namespace and source before a reentrant authority check can mutate the caller", () => {
    const { drafts } = setup()
    drafts.save(input({ workspace: "A", id: "prior" }))
    let checks = 0
    const mutable = input({
      workspace: "A",
      id: "new",
      assertCurrent() {
        if (++checks === 2) {
          mutable.workspace = "B"
          mutable.id = "forged"
          mutable.source.files[0].text = "mutated after validation"
        }
      }
    })
    drafts.save(mutable)
    expect(drafts.list("A").map((row) => row.id)).toEqual(["prior", "new"])
    expect(drafts.list("A")[1].versions[0].source.digest).toBe(bundle().digest)
    expect(drafts.list("B")).toEqual([])
  })

  it("rejects accessor and proxy draft inputs without invoking them", () => {
    const { drafts } = setup()
    let reads = 0
    const getter = {
      ...input(),
      get workspace() {
        reads++
        return "workspace"
      }
    }
    const proxy = new Proxy(input(), {
      ownKeys() {
        reads++
        return []
      }
    })
    expect(() => drafts.save(getter)).toThrow("AUTHORING_DRAFT_INVALID")
    expect(() => drafts.save(proxy)).toThrow("AUTHORING_DRAFT_INVALID")
    expect(reads).toBe(0)
    expect(drafts.list("workspace")).toEqual([])
  })

  it("retains exact source versions and restores as a new revision without changing old data", () => {
    const { drafts } = setup()
    const first = drafts.save(input())
    drafts.save(input({ expectedRevision: 1, source: bundle("second") }))
    const restored = drafts.restore({
      workspace: "workspace",
      id: "demo",
      expectedRevision: 2,
      sourceRevision: 1,
      assertCurrent: () => undefined
    })
    expect(restored.currentRevision).toBe(3)
    expect(restored.versions[0]).toEqual(first.versions[0])
    expect(restored.versions.map((version) => version.source.digest)).toEqual([
      bundle().digest,
      bundle("second").digest,
      bundle().digest
    ])
    expect(restored.versions[2].restoredFrom).toBe(1)
    first.versions[0].source.files[0].text = "caller mutation"
    expect(drafts.list("workspace")[0].versions[0].source.digest).toBe(bundle().digest)
    expect(drafts.list("different workspace")).toEqual([])
  })

  it("persists across a real SQLite close/reopen and rejects stale edits", () => {
    const { store, drafts, path } = setup()
    drafts.save(input())
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = new ModControlStore(path)
    stores.push(reopened)
    const next = new AuthoringDraftStore(reopened)
    expect(next.list("workspace")[0].currentRevision).toBe(1)
    expect(() => next.save(input())).toThrow("AUTHORING_VERSION_CHANGED")
    expect(() =>
      next.restore({
        workspace: "workspace",
        id: "demo",
        expectedRevision: 1,
        sourceRevision: 12,
        assertCurrent: () => undefined
      })
    ).toThrow("AUTHORING_VERSION_MISSING")
  })

  it("fences a second actual SQLite writer between source read and CAS", () => {
    const { drafts, path } = setup()
    const secondStore = new ModControlStore(path)
    stores.push(secondStore)
    const second = new AuthoringDraftStore(secondStore)
    let checks = 0
    expect(() =>
      drafts.save(
        input({
          assertCurrent() {
            if (++checks === 2) second.save(input({ source: bundle("winner") }))
          }
        })
      )
    ).toThrow("AUTHORING_VERSION_CHANGED")
    expect(drafts.list("workspace")[0].versions).toHaveLength(1)
    expect(drafts.list("workspace")[0].versions[0].source.digest).toBe(bundle("winner").digest)
  })

  it("does not write when scope revokes and rejects corrupted saved source", () => {
    const { drafts, store } = setup()
    expect(() =>
      drafts.save(
        input({
          assertCurrent() {
            throw Error("scope gone")
          }
        })
      )
    ).toThrow("scope gone")
    expect(drafts.list("workspace")).toEqual([])
    const originalCas = store.compareAndSetSetting.bind(store)
    let key = ""
    store.compareAndSetSetting = (...args) => {
      key = args[0]
      return originalCas(...args)
    }
    drafts.save(input())
    const state = JSON.parse(store.getSetting(key))
    state.drafts[0].versions[0].source.files[0].text = "changed without a new version"
    store.setSetting(key, JSON.stringify(state))
    const before = store.getSetting(key)
    expect(() => drafts.list("workspace")).toThrow("AUTHORING_SOURCE_DIGEST_CHANGED")
    expect(store.getSetting(key)).toBe(before)
  })

  it("never silently evicts source versions that an existing task may still reference", () => {
    const { drafts } = setup()
    for (let revision = 0; revision < 16; revision++)
      drafts.save(input({ expectedRevision: revision, source: bundle(String(revision)) }))
    const before = drafts.list("workspace")
    expect(() => drafts.save(input({ expectedRevision: 16 }))).toThrow("AUTHORING_VERSION_LIMIT")
    expect(drafts.list("workspace")).toEqual(before)
  })

  it("explicitly prunes old copies while keeping monotonic revisions and restore provenance across restart", () => {
    const { drafts, store } = setup()
    for (let revision = 0; revision < 15; revision++)
      drafts.save(input({ expectedRevision: revision, source: bundle(String(revision)) }))
    drafts.restore({ workspace: "workspace", id: "demo", expectedRevision: 15,
      sourceRevision: 1, assertCurrent: () => {} })
    const request = { workspace: "workspace", id: "demo", expectedRevision: 16,
      expectedSourceDigest: bundle("0").digest, acknowledgeHistoryLoss: true, assertCurrent: () => {} }
    expect(() => drafts.prune({ ...request, acknowledgeHistoryLoss: false })).toThrow()
    expect(drafts.list("workspace")[0].versions).toHaveLength(16)
    const retained = drafts.prune(request)
    expect(retained.versions.map(row => row.revision)).toEqual([15, 16])
    const restarted = new AuthoringDraftStore(store)
    expect(restarted.list("workspace")[0]).toEqual(retained)
    expect(restarted.save(input({ expectedRevision: 16 })).currentRevision).toBe(17)
    expect(() => restarted.prune(request)).toThrow("AUTHORING_VERSION_CHANGED")
    expect(() => restarted.restore({ workspace: "workspace", id: "demo", expectedRevision: 17,
      sourceRevision: 1, assertCurrent: () => {} })).toThrow("AUTHORING_VERSION_MISSING")
    expect(restarted.restore({ workspace: "workspace", id: "demo", expectedRevision: 17,
      sourceRevision: 16, assertCurrent: () => {} }).currentRevision).toBe(18)
  })

  it("releases a full draft library only after exact explicit removal and preserves other projects", () => {
    const { drafts } = setup()
    for (let index = 0; index < 16; index++) drafts.save(input({ id: `draft-${index}` }))
    drafts.save(input({ workspace: "other", id: "draft-0" }))
    expect(() => drafts.save(input())).toThrow("AUTHORING_DRAFT_LIMIT")
    const request = { workspace: "workspace", id: "draft-0", expectedRevision: 1,
      expectedSourceDigest: bundle().digest, acknowledgeHistoryLoss: true, assertCurrent: () => {} }
    expect(() => drafts.remove({ ...request, expectedSourceDigest: "a".repeat(64) }))
      .toThrow("AUTHORING_VERSION_CHANGED")
    expect(() => drafts.remove({ ...request, assertCurrent: () => { throw Error("scope gone") } }))
      .toThrow("scope gone")
    drafts.remove(request)
    expect(drafts.save(input()).currentRevision).toBe(2)
    expect(drafts.list("workspace")).toHaveLength(16)
    expect(drafts.list("other")).toHaveLength(1)
  })

  it("retains exact host-owned development revisions plus the latest two during compaction", () => {
    const { drafts } = setup()
    for (let revision = 0; revision < 16; revision++)
      drafts.save(input({ expectedRevision: revision, source: bundle(String(revision)) }))
    drafts.compact({ workspace: "workspace", id: "demo", retainRevisions: [1, 4], assertCurrent: () => {} })
    expect(drafts.list("workspace")[0].versions.map(row => row.revision)).toEqual([1, 4, 15, 16])
    expect(drafts.save(input({ expectedRevision: 16 })).currentRevision).toBe(17)
  })

  it("fences deleted and recreated IDs across an empty library and SQLite restart", () => {
    const { drafts, store, path } = setup()
    drafts.save(input())
    drafts.save(input({ expectedRevision: 1, source: bundle("old second") }))
    drafts.remove({ workspace: "workspace", id: "demo", expectedRevision: 2,
      expectedSourceDigest: bundle("old second").digest, acknowledgeHistoryLoss: true,
      assertCurrent: () => {} })
    expect(drafts.list("workspace")).toEqual([])
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = new ModControlStore(path)
    stores.push(reopened)
    const next = new AuthoringDraftStore(reopened)
    const replacement = next.save(input({ source: bundle("replacement") }))
    expect(replacement.currentRevision).toBe(3)
    for (const expectedRevision of [1, 2]) {
      expect(() => next.save(input({ expectedRevision, source: bundle("stale editor") })))
        .toThrow("AUTHORING_VERSION_CHANGED")
      expect(() => next.restore({ workspace: "workspace", id: "demo", expectedRevision,
        sourceRevision: 3, assertCurrent: () => {} })).toThrow("AUTHORING_VERSION_CHANGED")
    }
    expect(next.list("workspace")[0]).toEqual(replacement)
    expect(next.save(input({ expectedRevision: 3 })).currentRevision).toBe(4)
  })

  it("keeps the deletion floor through other draft saves, prune and host compaction", () => {
    const { drafts, store } = setup()
    drafts.save(input({ id: "retained" }))
    for (let revision = 0; revision < 8; revision++)
      drafts.save(input({ expectedRevision: revision }))
    drafts.remove({ workspace: "workspace", id: "demo", expectedRevision: 8,
      expectedSourceDigest: bundle().digest, acknowledgeHistoryLoss: true, assertCurrent: () => {} })
    for (let revision = 1; revision < 4; revision++)
      drafts.save(input({ id: "retained", expectedRevision: revision }))
    drafts.prune({ workspace: "workspace", id: "retained", expectedRevision: 4,
      expectedSourceDigest: bundle().digest, acknowledgeHistoryLoss: true, assertCurrent: () => {} })
    drafts.save(input({ id: "retained", expectedRevision: 4 }))
    drafts.compact({ workspace: "workspace", id: "retained", retainRevisions: [],
      assertCurrent: () => {} })
    expect(new AuthoringDraftStore(store).save(input()).currentRevision).toBe(9)
    expect(drafts.list("workspace").find(row => row.id === "retained")?.currentRevision).toBe(5)
    expect(drafts.save(input({ workspace: "other" })).currentRevision).toBe(1)
  })

  it.each([1, 2])("migrates schema %s without a deletion floor and rejects corrupt floors", (schemaVersion) => {
    const { store, drafts } = setup()
    let key = ""
    const cas = store.compareAndSetSetting.bind(store)
    store.compareAndSetSetting = (...args) => { key = args[0]; return cas(...args) }
    drafts.save(input())
    const legacy = JSON.parse(store.getSetting(key))
    legacy.schemaVersion = schemaVersion
    delete legacy.revisionFloor
    store.setSetting(key, JSON.stringify(legacy))
    expect(drafts.save(input({ expectedRevision: 1 })).currentRevision).toBe(2)
    const migrated = JSON.parse(store.getSetting(key))
    expect(migrated.revisionFloor).toBe(0)
    for (const revisionFloor of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      store.setSetting(key, JSON.stringify({ ...migrated, revisionFloor }))
      expect(() => drafts.list("workspace")).toThrow("AUTHORING_STORAGE_INVALID")
    }
  })

  it("keeps the committed revision discoverable when an acknowledgement is lost", () => {
    const { drafts, store } = setup()
    const cas = store.compareAndSetSetting.bind(store)
    store.compareAndSetSetting = (...args) => {
      cas(...args)
      throw Error("reply lost")
    }
    expect(() => drafts.save(input())).toThrow("reply lost")
    store.compareAndSetSetting = cas
    expect(drafts.list("workspace")[0].versions[0].source.digest).toBe(bundle().digest)
    expect(() => drafts.save(input())).toThrow("AUTHORING_VERSION_CHANGED")
  })
})
