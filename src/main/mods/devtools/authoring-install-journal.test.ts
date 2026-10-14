import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionUserConfigValues } from "../v2/user-config-values"
import { FunctionUserConfigSecrets } from "../v2/user-config-secrets"
import { AuthoringInstallJournal, authoringCatalogDigest } from "./authoring-install-journal"
import {
  captureRawFunctionConfigSnapshot,
  restoreRawFunctionConfigSnapshot
} from "./authoring-config-snapshot"

const roots: string[] = [],
  stores: ModControlStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "cmb-install-journal-"))
  roots.push(root)
  const path = join(root, "control.sqlite")
  const a = new ModControlStore(path),
    b = new ModControlStore(path)
  stores.push(a, b)
  return { a, b, path, journal: new AuthoringInstallJournal(a) }
}
const binding = () => ({
  operationId: randomUUID(),
  installationId: randomUUID(),
  versionId: randomUUID(),
  workspace: "project",
  draftId: "draft",
  revision: 1,
  configuration: "unchanged" as const,
  expectedCatalogRaw: null,
  nextCatalogRaw: '[{"path":"owned-version/source"}]',
  assertCurrent: () => {}
})
const configBinding = (compiledDigest = "a".repeat(64)) => ({
  workspace: "project",
  plugin: "plugin",
  compiledDigest
})
const configKey = 'function-user-config:["project","plugin"]'
const snap = (store: ModControlStore, digest?: string) =>
  captureRawFunctionConfigSnapshot(store, configBinding(digest), () => {})

describe("durable authoring install journal", () => {
  it("persists intent before catalog and records an exact explicit settled sequence across connections", () => {
    const { a, b, journal } = setup(),
      request = binding()
    const intent = journal.begin(request)
    expect(new AuthoringInstallJournal(b).read(intent.operationId, "project")).toEqual(intent)
    expect(journal.read(intent.operationId, "other")).toBeUndefined()
    const committed = journal.advance({
      operationId: intent.operationId,
      workspace: "project",
      expectedRevision: 1,
      next: "catalog-committed",
      observedCatalogDigest: authoringCatalogDigest(request.nextCatalogRaw),
      assertCurrent: () => {}
    })
    const settled = new AuthoringInstallJournal(b).advance({
      operationId: intent.operationId,
      workspace: "project",
      expectedRevision: 2,
      next: "settled",
      observedCatalogDigest: committed.nextCatalogDigest,
      assertCurrent: () => {}
    })
    expect(settled.phase).toBe("settled")
    expect(settled.journalRevision).toBe(3)
    expect(journal.read(intent.operationId, "project")).toEqual(settled)
    expect(a.getSetting(configKey, "absent")).toBe("absent")
  })

  it("does not mark catalog/config effects from skipped transitions or mismatched observation", () => {
    const { journal } = setup(),
      intent = journal.begin(binding())
    for (const next of ["settled", "config-restored", "catalog-committed"] as const) {
      expect(() =>
        journal.advance({
          operationId: intent.operationId,
          workspace: "project",
          expectedRevision: 1,
          next,
          observedCatalogDigest: "f".repeat(64),
          assertCurrent: () => {}
        })
      ).toThrow("TRANSITION")
    }
    expect(journal.read(intent.operationId, "project")).toEqual(intent)
  })

  it("retains opaque before/target snapshots with intent and tracks configuration phases", () => {
    const { a, journal } = setup()
    a.setSetting(
      configKey,
      JSON.stringify({ revision: 1, values: { theme: "old" }, sealed: { token: "b3BhcXVl" } })
    )
    const target = snap(a)
    a.setSetting(configKey, JSON.stringify({ revision: 2, values: { theme: "new" } }))
    const current = snap(a, "b".repeat(64))
    let row = journal.begin({
      ...binding(),
      configuration: "restore",
      configBefore: current,
      configTarget: target
    })
    expect(row.configTarget!.raw).toBe(target.raw)
    for (const next of [
      "catalog-committed",
      "config-restoring",
      "config-restored",
      "settled"
    ] as const) {
      row = journal.advance({
        operationId: row.operationId,
        workspace: "project",
        expectedRevision: row.journalRevision,
        next,
        observedCatalogDigest: row.nextCatalogDigest,
        assertCurrent: () => {}
      })
    }
    expect(row.phase).toBe("settled")
    // Journal transitions describe host observations; they never perform the config effect.
    expect(a.getSetting(configKey)).toBe(current.raw)
  })

  it("records partial/unknown without dropping the last confirmed phase or automatically retrying", () => {
    const { journal } = setup(),
      request = binding()
    let row = journal.begin(request)
    row = journal.advance({
      operationId: row.operationId,
      workspace: "project",
      expectedRevision: 1,
      next: "catalog-committed",
      observedCatalogDigest: row.nextCatalogDigest,
      assertCurrent: () => {}
    })
    row = journal.advance({
      operationId: row.operationId,
      workspace: "project",
      expectedRevision: 2,
      next: "partial",
      reason: "config-unconfirmed",
      assertCurrent: () => {}
    })
    expect(row.lastConfirmedPhase).toBe("catalog-committed")
    expect(() => journal.begin({ ...request, operationId: randomUUID() })).toThrow("PENDING")
    expect(() =>
      journal.advance({
        operationId: row.operationId,
        workspace: "project",
        expectedRevision: 3,
        next: "settled",
        observedCatalogDigest: row.nextCatalogDigest,
        assertCurrent: () => {}
      })
    ).toThrow("TRANSITION")
  })

  it("CAS permits one winner and prevents a stale revision from advancing twice", () => {
    const { b, journal } = setup(),
      intent = journal.begin(binding())
    const request = {
      operationId: intent.operationId,
      workspace: "project",
      expectedRevision: 1,
      next: "catalog-committed" as const,
      observedCatalogDigest: intent.nextCatalogDigest,
      assertCurrent: () => {}
    }
    journal.advance(request)
    expect(() => new AuthoringInstallJournal(b).advance(request)).toThrow("CHANGED")
  })

  it("an external writer between read and CAS leaves its complete row intact", () => {
    const { a, b } = setup(),
      other = new AuthoringInstallJournal(b),
      request = binding()
    let external: ReturnType<AuthoringInstallJournal["begin"]> | undefined
    const raced = new AuthoringInstallJournal({
      getSetting: a.getSetting.bind(a),
      compareAndSetSetting: (key, raw, next) => {
        external = other.begin({ ...binding(), installationId: request.installationId })
        return a.compareAndSetSetting(key, raw, next)
      }
    })
    expect(() => raced.begin(request)).toThrow("CHANGED")
    expect(other.read(request.operationId, "project")).toBeUndefined()
    expect(other.read(external!.operationId, "project")).toEqual(external)
  })

  it("write failure and pre-CAS scope loss create no partial journal row", () => {
    const { a, journal } = setup(),
      request = binding()
    const failed = new AuthoringInstallJournal({
      getSetting: a.getSetting.bind(a),
      compareAndSetSetting: () => {
        throw Error("disk")
      }
    })
    expect(() => failed.begin(request)).toThrow("disk")
    let calls = 0
    expect(() =>
      journal.begin({
        ...request,
        assertCurrent: () => {
          if (++calls === 2) throw Error("scope")
        }
      })
    ).toThrow("scope")
    expect(journal.read(request.operationId, "project")).toBeUndefined()
  })

  it("reopens durable unresolved state and refuses duplicate operation IDs", () => {
    const { path, journal } = setup(),
      request = binding(),
      row = journal.begin(request)
    const reopened = new ModControlStore(path)
    stores.push(reopened)
    const next = new AuthoringInstallJournal(reopened)
    expect(next.read(row.operationId, "project")).toEqual(row)
    expect(() => next.begin(request)).toThrow("PENDING")
  })

  it("captures caller identity before guard mutation and rejects snapshot scope mismatch", () => {
    const { a, journal } = setup(),
      request = binding()
    request.assertCurrent = () => {
      request.workspace = "other"
    }
    const row = journal.begin(request)
    expect(row.workspace).toBe("project")
    const config = snap(a)
    expect(() =>
      journal.begin({
        ...binding(),
        workspace: "other",
        configuration: "restore",
        configBefore: config,
        configTarget: config
      })
    ).toThrow("SNAPSHOT_BINDING")
  })

  it("bounds retained journal rows without trimming unresolved intent", () => {
    const { journal } = setup()
    const first = journal.begin(binding())
    for (let i = 1; i < 64; i++) journal.begin(binding())
    expect(() => journal.begin(binding())).toThrow("LIMIT")
    expect(journal.read(first.operationId, "project")).toEqual(first)
  })

  it("hashes exact catalog representation and distinguishes missing from empty", () => {
    expect(authoringCatalogDigest(null)).not.toBe(authoringCatalogDigest(""))
    expect(authoringCatalogDigest("[]")).not.toBe(authoringCatalogDigest("[ ]"))
  })

  it("lists detached validated host records only within the exact workspace", () => {
    const { journal } = setup(),
      row = journal.begin(binding())
    journal.begin({ ...binding(), workspace: "other" })
    const rows = journal.list("project")
    expect(rows).toEqual([row])
    rows[0]!.phase = "settled"
    expect(journal.list("project")[0]!.phase).toBe("intent")
  })

  it("rejects a corrupted settled row that never recorded its required predecessor", () => {
    const { a, journal } = setup(),
      row = journal.begin(binding())
    a.setSetting(
      "mods-authoring-install-journal-v1",
      JSON.stringify([{ ...row, phase: "settled", journalRevision: 3 }])
    )
    expect(() => journal.read(row.operationId, "project")).toThrow("JOURNAL_INVALID")
  })
})

describe("raw configuration snapshots", () => {
  it("preserves opaque encrypted fields without opening any secret and increments current revision", () => {
    const { a, b } = setup()
    const open = vi.spyOn(FunctionUserConfigSecrets.prototype, "open").mockImplementation(() => {
      throw Error("must not decrypt")
    })
    const resolve = vi
      .spyOn(FunctionUserConfigValues.prototype, "resolve")
      .mockImplementation(() => {
        throw Error("must not resolve")
      })
    a.setSetting(
      configKey,
      JSON.stringify({ revision: 3, values: { theme: "old" }, sealed: { token: "b3BhcXVl" } })
    )
    const old = snap(a)
    b.setSetting(configKey, JSON.stringify({ revision: 8, values: { theme: "new" } }))
    const current = snap(b, "b".repeat(64))
    const restored = restoreRawFunctionConfigSnapshot(a, {
      snapshot: old,
      expectedCurrent: current,
      targetCompiledDigest: old.compiledDigest,
      assertCurrent: () => {}
    })
    expect(restored.record).toEqual({
      revision: 9,
      values: { theme: "old" },
      sealed: { token: "b3BhcXVl" }
    })
    expect(new FunctionUserConfigValues(b).read("project", "plugin")).toEqual(restored.record)
    expect(open).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(() =>
      restoreRawFunctionConfigSnapshot(a, {
        snapshot: old,
        expectedCurrent: current,
        targetCompiledDigest: old.compiledDigest,
        assertCurrent: () => {}
      })
    ).toThrow("CHANGED")
  })

  it("requires the exact current bytes, including same-revision external edits", () => {
    const { a, b } = setup()
    const target = snap(a),
      current = snap(a)
    b.setSetting(configKey, '{"revision":0,"values":{"changed":true}}')
    expect(() =>
      restoreRawFunctionConfigSnapshot(a, {
        snapshot: target,
        expectedCurrent: current,
        targetCompiledDigest: target.compiledDigest,
        assertCurrent: () => {}
      })
    ).toThrow("CHANGED")
    expect(a.getSetting(configKey)).toContain("changed")
  })

  it("rejects digest and target identity tampering and leaves the actual config untouched", () => {
    const { a } = setup(),
      target = snap(a)
    expect(() =>
      restoreRawFunctionConfigSnapshot(a, {
        snapshot: { ...target, raw: '{"revision":0,"values":{"x":1}}' },
        expectedCurrent: target,
        targetCompiledDigest: target.compiledDigest,
        assertCurrent: () => {}
      })
    ).toThrow("INVALID")
    expect(() =>
      restoreRawFunctionConfigSnapshot(a, {
        snapshot: target,
        expectedCurrent: target,
        targetCompiledDigest: "f".repeat(64),
        assertCurrent: () => {}
      })
    ).toThrow("BINDING")
    expect(a.getSetting(configKey, "absent")).toBe("absent")
  })

  it("restoring an absent snapshot writes an empty record with a new revision, never deletes current data silently", () => {
    const { a } = setup(),
      target = snap(a)
    a.setSetting(configKey, '{"revision":5,"values":{"set":true}}')
    const restored = restoreRawFunctionConfigSnapshot(a, {
      snapshot: target,
      expectedCurrent: snap(a),
      targetCompiledDigest: target.compiledDigest,
      assertCurrent: () => {}
    })
    expect(restored.record).toEqual({ revision: 6, values: {} })
    expect(restored.raw).not.toBeNull()
  })

  it("scope loss before CAS preserves config; post-CAS failure stays an explicit uncertain effect", () => {
    const { a } = setup(),
      target = snap(a)
    expect(() =>
      restoreRawFunctionConfigSnapshot(a, {
        snapshot: target,
        expectedCurrent: target,
        targetCompiledDigest: target.compiledDigest,
        assertCurrent: () => {
          throw Error("scope")
        }
      })
    ).toThrow("scope")
    expect(a.getSetting(configKey, "absent")).toBe("absent")
    let calls = 0
    expect(() =>
      restoreRawFunctionConfigSnapshot(a, {
        snapshot: target,
        expectedCurrent: target,
        targetCompiledDigest: target.compiledDigest,
        assertCurrent: () => {
          if (++calls === 2) throw Error("scope")
        }
      })
    ).toThrow("scope")
    expect(snap(a).record.revision).toBe(1)
  })
})
