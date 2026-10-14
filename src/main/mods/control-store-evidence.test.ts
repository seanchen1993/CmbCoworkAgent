import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "./control-store"
import type { CompletionEvidenceRecord } from "./v2/completion-evidence"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-b4-evidence-"))
  const file = join(directory, "control.sqlite")
  const store = new ModControlStore(file)
  const db = new DatabaseSync(file)
  cleanups.push(() => {
    db.close()
    store.close()
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("cmb-b4-evidence-")
    )
      throw Error("bad cleanup")
    rmSync(directory, { recursive: true, force: true })
  })
  const save = (id: string, patch = {}) =>
    store.saveCompletionEvidence({
      id,
      idempotencyKey: id,
      workspace: "workspace",
      threadId: "thread",
      turnId: "run",
      runId: "run",
      phase: "check.result",
      status: "pass",
      binding: {
        workspace: "workspace",
        threadId: "thread",
        turnId: "run",
        runId: "run",
        pluginDigests: {},
        runtimeGeneration: 1,
        diffFingerprint: "diff",
        stateFingerprint: "state",
        requirementVersion: "requirement",
        configFingerprint: "config",
        files: []
      },
      at: 1,
      ...patch
    } as CompletionEvidenceRecord)
  return { store, db, save }
}

it("finds exact old IDs beyond the latest 500 without borrowing another scope", () => {
  const { store, db, save } = fixture()
  save("old")
  // Bulk fixture setup preserves the real schema while avoiding 501 filesystem flushes.
  const insert = db.prepare(`INSERT INTO mods_completion_evidence
    SELECT ?,?,workspace,thread_id,turn_id,run_id,phase,status,
    json_set(payload,'$.id',?,'$.idempotencyKey',?,'$.at',?),? FROM mods_completion_evidence WHERE id='old'`)
  db.exec("BEGIN")
  try {
    for (let i = 0; i < 501; i++)
      insert.run(`new-${i}`, `new-${i}`, `new-${i}`, `new-${i}`, i + 2, i + 2)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  save("other-workspace", { workspace: "elsewhere" })
  save("other-thread", { threadId: "elsewhere" })
  save("other-run", { runId: "elsewhere" })
  expect(store.completionEvidence("workspace", "thread", 500).some((r) => r.id === "old")).toBe(
    false
  )
  const found = store.completionEvidenceByIds("workspace", "thread", "run", [
    "old",
    "missing",
    "other-workspace",
    "other-thread",
    "other-run"
  ])
  expect(found.records.map((r) => r.id)).toEqual(["old"])
  expect(found.missingIds).toEqual(["missing", "other-workspace", "other-thread", "other-run"])
  expect(found.invalidIds).toEqual([])
})

it("bounds payload reads and distinguishes corrupt payload identity from missing data", () => {
  const { store, db, save } = fixture()
  for (const id of ["broken", "forged", "oversized"]) save(id)
  db.prepare("UPDATE mods_completion_evidence SET payload=? WHERE id=?").run("not-json", "broken")
  db.prepare(
    "UPDATE mods_completion_evidence SET payload=json_set(payload,'$.workspace','other') WHERE id=?"
  ).run("forged")
  db.prepare("UPDATE mods_completion_evidence SET payload=? WHERE id=?").run(
    "x".repeat(512 * 1024 + 1),
    "oversized"
  )
  const before = db
    .prepare("SELECT id,payload,status FROM mods_completion_evidence ORDER BY id")
    .all()
  const found = store.completionEvidenceByIds("workspace", "thread", "run", [
    "broken",
    "forged",
    "oversized"
  ])
  expect(found).toEqual({
    records: [],
    missingIds: [],
    invalidIds: ["broken", "forged"],
    limitedIds: ["oversized"]
  })
  expect(
    db.prepare("SELECT id,payload,status FROM mods_completion_evidence ORDER BY id").all()
  ).toEqual(before)
})

it("stops loading bodies at its aggregate budget and rejects oversized or duplicate requests", () => {
  const { store, save } = fixture()
  for (let i = 0; i < 5; i++) save(`large-${i}`, { detail: { diagnostic: "x".repeat(500 * 1024) } })
  const found = store.completionEvidenceByIds(
    "workspace",
    "thread",
    "run",
    Array.from({ length: 5 }, (_, i) => `large-${i}`)
  )
  expect(found.records).toHaveLength(4)
  expect(found.limitedIds).toEqual(["large-4"])
  for (const ids of [
    ["a", "a"],
    [""],
    ["x".repeat(201)],
    Array.from({ length: 129 }, (_, i) => String(i))
  ])
    expect(() => store.completionEvidenceByIds("workspace", "thread", "run", ids)).toThrow(
      "MODS_EVIDENCE_QUERY"
    )
  expect(store.completionEvidenceByIds("workspace", "thread", "run", [])).toEqual({
    records: [],
    missingIds: [],
    invalidIds: [],
    limitedIds: []
  })
})
