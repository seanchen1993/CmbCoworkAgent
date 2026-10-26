import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { HostProjectStore } from "./host-store"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { ProjectCompositionStore } from "./composition-store"
import { auditProjectSnapshotReferences, projectSnapshotRoots } from "./snapshot-reference-audit"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const digest = (id: string) => createHash("sha256").update(id).digest("hex")
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "snapshot-reference-"))
  cleanup.push(() => rmSync(base, { recursive: true, force: true }))
  const roots = projectSnapshotRoots(base)
  for (const root of roots) mkdirSync(root, { recursive: true })
  const audit = () =>
    auditProjectSnapshotReferences(base, roots[0], () => ({
      complete: true,
      digests: new Set<string>(),
      blockers: []
    }))
  const db = (parts: string[]) => {
    const path = join(base, ...parts)
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    cleanup.push(() => db.close())
    return db
  }
  return { base, roots, audit, db }
}

it("enumerates every host project beyond UI pagination and retains all historical digests", () => {
  const f = fixture(),
    store = new HostProjectStore(join(f.base, "local-projects", "state.sqlite"))
  cleanup.push(() => store.close())
  const all = Array.from({ length: 251 }, (_, index) => digest(String(index)))
  for (const [index, pluginDigest] of all.entries())
    store.create({ ...hostProjectFixture(f.base), projectId: `p-${index}`, pluginDigest })
  const audit = f.audit()
  expect(audit.complete).toBe(true)
  for (const version of all) expect(audit.digests.has(version)).toBe(true)
}, 15000)

it("retains both plan versions from the original migration transaction and rejects malformed history", () => {
  const f = fixture()
  const path = join(f.base, "local-projects", "state.sqlite")
  const store = new HostProjectStore(path)
  cleanup.push(() => store.close())
  const project = store.create(hostProjectFixture(f.base))
  const candidate = { ...project, pluginDigest: digest("new-plan"), packageVersion: "1.0.1",
    manifest: { ...project.manifest, plugin: { ...project.manifest.plugin, version: "1.0.1" } } }
  const review = { projectId: project.projectId, expectedVersion: project.version,
    sourceDigest: project.pluginDigest, targetDigest: candidate.pluginDigest,
    targetVersion: candidate.packageVersion, inputFingerprint: digest("input"),
    candidateInputFingerprint: digest("candidate-input"), preservedStageIds: [],
    remainingStageIds: candidate.manifest.stages.map(stage => stage.id), contractDigest: digest("contract") }
  store.commitPlanMigration(candidate, project.version, review, () => {})
  const audit = f.audit()
  expect(audit.blockers).toEqual([])
  expect(audit.digests.has(project.pluginDigest)).toBe(true)
  expect(audit.digests.has(candidate.pluginDigest)).toBe(true)
  const db = f.db(["local-projects", "state.sqlite"])
  db.prepare("UPDATE host_plan_migrations SET data=?").run(JSON.stringify({
    review, previous: project, next: { ...candidate, version: 2 }, actor: "unrecognized"
  }))
  expect(f.audit().complete).toBe(false)
})

it("keeps disabled legacy history, all composition units, internal projects, selections and baseline receipts", () => {
  const f = fixture(),
    legacy = f.db(["legacy-project-runtime", "operations.sqlite"])
  legacy.exec(`CREATE TABLE legacy_bindings(project_id TEXT,workspace TEXT,plugin_id TEXT,data TEXT);
    CREATE TABLE legacy_operations(id TEXT,project_id TEXT,request_id TEXT,workspace TEXT,plugin_id TEXT,status TEXT,data TEXT)`)
  const old = {
    schemaVersion: 1,
    operationId: "op",
    projectId: "p",
    featureId: "feature",
    workspace: f.base,
    installedPluginId: "plugin",
    packageDigest: digest("legacy"),
    threadId: "thread",
    threadIncarnation: "inc",
    requestId: "request",
    inputDigest: digest("input"),
    status: "succeeded",
    startedAt: 1,
    settledAt: 2,
    terminalCode: null,
    businessStateValidity: "unknown"
  }
  legacy
    .prepare("INSERT INTO legacy_operations VALUES(?,?,?,?,?,?,?)")
    .run("op", "p", "request", f.base, "plugin", "succeeded", JSON.stringify(old))
  const compositions = new ProjectCompositionStore(
    join(f.base, "project-compositions", "state.sqlite")
  )
  cleanup.push(() => compositions.close())
  compositions.create(
    {
      apiVersion: "devclaw.project-composition/v1",
      parentProjectId: "p",
      workspace: f.base,
      units: ["pending", "later"].map((id) => ({
        id,
        kind: "flow",
        inputs: [],
        outputs: [],
        source: { pluginId: id, capabilityId: "flow", packageDigest: digest(id) }
      }))
    },
    "request"
  )
  const internal = f.db(["project-compositions", "internal-projects.sqlite"])
  internal.exec("CREATE TABLE internal_projects(id TEXT,revision INTEGER,digest TEXT,data TEXT)")
  internal.prepare("INSERT INTO internal_projects VALUES(?,?,?,?)").run(
    "internal",
    1,
    digest("data"),
    JSON.stringify({
      packageDigest: digest("internal"),
      plugin: { path: join(f.roots[2], digest("path-reference"), "package") }
    })
  )
  const selections = f.db(["project-compositions", "capabilities.sqlite"])
  selections.exec(
    "CREATE TABLE project_capability_selections(project_id TEXT,workspace TEXT,revision TEXT,sources TEXT)"
  )
  selections
    .prepare("INSERT INTO project_capability_selections VALUES(?,?,?,?)")
    .run(
      "p",
      f.base,
      "revision",
      JSON.stringify([
        { pluginId: "independent", capabilityId: "skill", packageDigest: digest("selection") }
      ])
    )
  const checks = f.db(["project-compositions", "stage-checks.sqlite"])
  checks.exec(`CREATE TABLE contracts(run TEXT,unit TEXT,data TEXT);
    CREATE TABLE transitions(id TEXT,run TEXT,unit TEXT,status TEXT,data TEXT);
    CREATE TABLE receipts(seq INTEGER,run TEXT,unit TEXT,data TEXT);
    CREATE TABLE source_baselines(run TEXT,unit TEXT,data TEXT)`)
  checks.prepare("INSERT INTO source_baselines VALUES(?,?,?)").run(
    "run",
    "unit",
    JSON.stringify({
      apiVersion: "devclaw.source-baseline/v1",
      packageDigest: digest("baseline"),
      contractDigest: digest("contract"),
      files: []
    })
  )
  for (const root of f.roots) {
    const audit = auditProjectSnapshotReferences(f.base, root, () => ({
      complete: true,
      digests: new Set([digest("native-thread")]),
      blockers: []
    }))
    expect(audit.blockers).toEqual([])
    for (const id of [
      "legacy",
      "pending",
      "later",
      "internal",
      "path-reference",
      "selection",
      "baseline",
      "native-thread"
    ])
      expect(audit.digests.has(digest(id))).toBe(true)
  }
})

it("fails closed on unknown tables/columns and malformed native or stored records", () => {
  const f = fixture(),
    selections = f.db(["project-compositions", "capabilities.sqlite"])
  selections.exec(
    "CREATE TABLE project_capability_selections(project_id TEXT,workspace TEXT,revision TEXT,sources TEXT)"
  )
  selections
    .prepare("INSERT INTO project_capability_selections VALUES(?,?,?,?)")
    .run("p", f.base, "1", "bad-json")
  expect(f.audit().complete).toBe(false)
  selections.exec(
    "DELETE FROM project_capability_selections; CREATE TABLE future_references(data TEXT)"
  )
  expect(f.audit().blockers.join(" ")).toContain("SCHEMA_UNKNOWN")
  selections.exec(
    "DROP TABLE future_references; ALTER TABLE project_capability_selections ADD COLUMN future_digest TEXT"
  )
  expect(f.audit().complete).toBe(false)
  expect(
    auditProjectSnapshotReferences(f.base, f.roots[0], () => {
      throw Error("native DB unavailable")
    }).blockers
  ).toContain("SNAPSHOT_NATIVE_REFERENCE_AUDIT_FAILED")
})

it("does not create missing databases and rejects unregistered roots", () => {
  const f = fixture()
  expect(f.audit().complete).toBe(true)
  expect(
    auditProjectSnapshotReferences(f.base, join(f.base, "other"), () => ({
      complete: true,
      digests: new Set(),
      blockers: []
    })).complete
  ).toBe(false)
})

function preparedComposition(configurationPending = true) {
  const f = fixture()
  const store = new ProjectCompositionStore(join(f.base, "project-compositions", "state.sqlite"))
  cleanup.push(() => store.close())
  const run = store.create({
    apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "project",
    workspace: f.base,
    units: [{
      id: "unit",
      kind: "flow",
      inputs: [],
      outputs: [],
      source: { pluginId: "plugin", capabilityId: "flow", packageDigest: digest("prepared") }
    }]
  }, "request", configurationPending).run
  return { ...f, store, run }
}

it("retains prepared composition sources before and after native configuration confirmation", () => {
  const f = preparedComposition()
  expect(f.run.configurationPending).toBe(true)
  expect(f.audit()).toMatchObject({ complete: true, blockers: [] })
  expect(f.audit().digests.has(digest("prepared"))).toBe(true)
  const confirmed = f.store.confirmConfiguration(f.run.id, f.run.version)
  expect(confirmed.configurationPending).toBe(false)
  expect(f.audit()).toMatchObject({ complete: true, blockers: [] })
  expect(f.audit().digests.has(digest("prepared"))).toBe(true)
})

it("validates frozen unit context without mistaking its knowledge fingerprint for a package reference", () => {
  const f = preparedComposition()
  const fingerprint = digest("knowledge-inputs")
  const updated = f.store.saveUnitContext(f.run.id, f.run.version, "unit", {
    deployUnitIds: ["UNIT.ONE"], contextFingerprint: fingerprint
  })
  expect(f.audit()).toMatchObject({ complete: true, blockers: [] })
  expect(f.audit().digests.has(digest("prepared"))).toBe(true)
  expect(f.audit().digests.has(fingerprint)).toBe(false)
  f.store.confirmConfiguration(updated.id, updated.version)
  expect(f.audit().complete).toBe(true)
})

it.each([
  { other: { deployUnitIds: ["UNIT.ONE"], contextFingerprint: "e".repeat(64) } },
  { unit: { deployUnitIds: ["UNIT.ONE", "UNIT.ONE"], contextFingerprint: "e".repeat(64) } },
  { unit: { deployUnitIds: ["UNIT.ONE"], contextFingerprint: "invalid" } },
  { unit: { deployUnitIds: ["UNIT.ONE"], contextFingerprint: "e".repeat(64), localRepoPath: "C:/untrusted" } }
])("rejects malformed or cross-unit frozen context %j", unitContexts => {
  const f = preparedComposition()
  f.db(["project-compositions", "state.sqlite"]).prepare("UPDATE composition_runs SET data=? WHERE id=?")
    .run(JSON.stringify({ ...f.run, unitContexts }), f.run.id)
  expect(() => f.store.get(f.run.id)).toThrow("COMPOSITION_UNIT_CONTEXT_INVALID")
  expect(f.audit().complete).toBe(false)
})

it("accepts cancelled configuration preparation and original records without the optional flag", () => {
  const pending = preparedComposition()
  const cancelled = pending.store.cancel(pending.run.id)
  expect(cancelled).toMatchObject({ status: "cancelled", configurationPending: false })
  expect(pending.audit()).toMatchObject({ complete: true, blockers: [] })
  const original = preparedComposition(false)
  expect(Object.hasOwn(original.run, "configurationPending")).toBe(false)
  expect(original.audit()).toMatchObject({ complete: true, blockers: [] })
})

it.each([
  ["non-boolean flag", { configurationPending: "true" }],
  ["null flag", { configurationPending: null }],
  ["pending configuration outside running", { status: "unknown" }],
  ["already active unit", { units: [{ id: "unit", status: "running" }] }],
  ["unit with attempt", { units: [{ id: "unit", status: "pending", attemptId: "attempt" }] }],
  ["unit with engine", { units: [{ id: "unit", status: "pending", engineRunId: "engine" }] }],
  ["unknown field", { futureConfiguration: true }]
] as const)("keeps composition reference auditing closed for %s", (label, patch) => {
  const f = preparedComposition()
  const db = f.db(["project-compositions", "state.sqlite"])
  db.prepare("UPDATE composition_runs SET data=? WHERE id=?")
    .run(JSON.stringify({ ...f.run, ...patch }), f.run.id)
  const audit = f.audit()
  expect(audit.complete).toBe(false)
  expect(audit.blockers.join(" ")).toContain(label === "unknown field"
    ? "SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN" : "SNAPSHOT_REFERENCE_RECORD_INVALID")
})
