import { join } from "node:path"
import { tmpdir as osTmpdir } from "node:os"
import { expect, it } from "vitest"
import {
  assertCreatorBusinessTrialProofBinding,
  parseCreatorBusinessTrialRecord,
  type CreatorBusinessTrialProofBinding,
  type CreatorBusinessTrialRecord
} from "./creator-business-trial-record"

const id = "creator-business-trial:11111111-1111-4111-8111-111111111111"
const root = join(osTmpdir(), "creator-business-record-tests")
const options = { root, packagesRoot: join(root, "packages") }
const source = join(root, "installed-original")
function request(): CreatorBusinessTrialRecord {
  return {
    schemaVersion: 1,
    version: 1,
    id,
    scope: {
      threadId: "creator-thread",
      workspace: root,
      incarnation: { token: "creator-incarnation", legacyCreatedAt: 1 }
    },
    planId: "native-plan",
    candidate: {
      copyId: "native-checked-copy",
      digest: "a".repeat(64),
      name: "original-candidate",
      version: "1.0.0",
      sources: [
        {
          pluginId: "installed-original",
          directory: source,
          identity: "b".repeat(64),
          digest: "c".repeat(64)
        }
      ]
    },
    goal: "Create an actual checked result",
    phase: "needs-confirmation",
    settled: true,
    nonce: "22222222-2222-4222-8222-222222222222",
    featureId: "trial-12345678",
    feedback: []
  }
}
function prepared(): CreatorBusinessTrialRecord {
  const record = request()
  record.phase = "ready"
  record.workspace = join(root, "trial-Ab012z", "workspace")
  record.workspaceIdentity = record.workspace + ":1:1234567890"
  record.packageDigest = "d".repeat(64)
  record.plugin = {
    id,
    name: record.candidate.name,
    version: record.candidate.version,
    path: join(options.packagesRoot, record.packageDigest, "package"),
    enabled: true,
    description: "Exact original source",
    author: "",
    createdAt: "",
    updatedAt: "",
    skillCount: 0,
    mcpServerCount: 0,
    hookCount: 0
  }
  record.selection = { deployUnitIds: ["UNIT.ONE"], contextFingerprint: "e".repeat(64) }
  return record
}
function running(): CreatorBusinessTrialRecord {
  const record = prepared()
  record.phase = "running"
  record.project = {
    projectId: id,
    name: record.candidate.name,
    description: record.goal,
    projectCode: "TRIAL12345678",
    projectDir: "workspace",
    projectFromLean: false,
    workspacePath: join(root, "trial-Ab012z"),
    systemId: "CREATOR-TRIAL",
    systemName: "Trial",
    "harness-adapter": {
      id,
      name: record.plugin!.name,
      version: record.plugin!.version,
      type: "plugin"
    },
    lifecycle: { status: "active", createAt: "2026-10-18T00:00:00Z" }
  }
  record.runId = "original-managed-run"
  record.physical = [{ threadId: "actual-thread", requestId: "actual-request" }]
  return record
}
function proof(record: CreatorBusinessTrialRecord): CreatorBusinessTrialProofBinding {
  return {
    root: record.plugin!.path,
    packageDigest: record.packageDigest!,
    candidate: structuredClone(record.candidate),
    plugin: structuredClone(record.plugin!),
    workspace: record.workspace!,
    workspaceIdentity: record.workspaceIdentity!,
    featureId: record.featureId,
    scope: structuredClone(record.scope),
    planId: record.planId,
    goal: record.goal
  }
}
const parse = (value: unknown) =>
  parseCreatorBusinessTrialRecord(JSON.stringify(value), id, options)

it("parses original intent, configured source, actual project and terminal history without directory IO", () => {
  for (const record of [request(), prepared(), running()]) expect(parse(record)).toEqual(record)
  const terminal = running()
  terminal.phase = "completed"
  terminal.physical![0].confirmed = true
  expect(parse(terminal)).toEqual(terminal)
  const cancelled = request()
  cancelled.phase = "cancelled"
  cancelled.stopRequested = true
  expect(parse(cancelled)).toEqual(cancelled)
})

it.each([
  { approved: true },
  { version: 0 },
  { version: 1.5 },
  { phase: "passed" },
  { settled: "true" },
  { nonce: "forged" },
  { stopRequested: "true" },
  { id: "creator-business-trial:foreign" },
  { goal: "" },
  { feedback: [{}] },
  { physical: [{ threadId: "thread", requestId: "request", confirmed: "true" }] },
  {
    scope: {
      threadId: "creator",
      workspace: root,
      incarnation: { token: "token", legacyCreatedAt: 1 },
      approved: true
    }
  },
  { candidate: { ...request().candidate, digest: "unverified", approved: true } }
])("rejects malformed/unknown persistent fields %j", (fields) => {
  expect(() => parse({ ...request(), ...fields })).toThrow("BUSINESS_TRIAL_RECORD_INVALID")
})

it("rejects malformed JSON, oversized records and a foreign requested trial ID", () => {
  expect(() => parseCreatorBusinessTrialRecord("{", id, options)).toThrow("RECORD_INVALID")
  expect(() => parseCreatorBusinessTrialRecord(" ".repeat(256 * 1024 + 1), id, options)).toThrow(
    "RECORD_INVALID"
  )
  expect(() =>
    parseCreatorBusinessTrialRecord(
      JSON.stringify(request()),
      id.replace("11111111", "33333333"),
      options
    )
  ).toThrow("RECORD_INVALID")
})

it.each([
  "foreign-workspace",
  "nested-workspace",
  "missing-inode",
  "foreign-package",
  "foreign-plugin",
  "foreign-candidate"
] as const)("rejects the %s source binding before it reaches a native editor", (change) => {
  const record = prepared()
  if (change === "foreign-workspace") record.workspace = join(osTmpdir(), "another-project")
  if (change === "nested-workspace")
    record.workspace = join(root, "trial-Ab012z", "nested", "workspace")
  if (change === "missing-inode") delete record.workspaceIdentity
  if (change === "foreign-package") record.plugin!.path = join(root, "foreign-package")
  if (change === "foreign-plugin") record.plugin!.id = "another-installed-uuid"
  if (change === "foreign-candidate") record.plugin!.version = "9.9.9"
  expect(() => parse(record)).toThrow("RECORD_INVALID")
})

it.each(["project", "adapter", "workspace", "goal", "physical", "selection"] as const)(
  "rejects mismatched original %s facts",
  (change) => {
    const record = running()
    if (change === "project") record.project!.projectId = "another-project"
    if (change === "adapter") record.project!["harness-adapter"].id = "another-uuid"
    if (change === "workspace") record.project!.workspacePath = osTmpdir()
    if (change === "goal") record.project!.description = "another-goal"
    if (change === "physical") record.physical!.push(structuredClone(record.physical![0]))
    if (change === "selection") record.selection!.deployUnitIds.push("UNIT.ONE")
    expect(() => parse(record)).toThrow()
  }
)

it("does not accept a completed label without original project/run and confirmed physical facts", () => {
  expect(() => parse({ ...request(), phase: "completed" })).toThrow("RECORD_INVALID")
  const record = running()
  record.phase = "completed"
  expect(() => parse(record)).toThrow("RECORD_INVALID")
  record.physical![0].confirmed = false
  expect(() => parse(record)).toThrow("RECORD_INVALID")
})

it("preserves bounded original diagnostic text as data without admitting it as identity", () => {
  const record = request()
  record.phase = "failed"
  record.error = "\u001b[31mOriginal Python error\u001b[0m\nReview actual output"
  expect(parse(record).error).toBe(record.error)
  record.featureId = "\u001b[31mforeign-identity"
  expect(() => parse(record)).toThrow("RECORD_INVALID")
})

it("checks only captured bindings; feedback/CAS counters remain observation rather than execution identity", () => {
  const record = running(),
    admitted = proof(record)
  expect(() => assertCreatorBusinessTrialProofBinding(parse(record), admitted)).not.toThrow()
  record.version++
  record.feedback.push({ id: "actual-feedback", at: 1, message: "Refine the display" })
  record.physical![0].confirmed = true
  expect(() => assertCreatorBusinessTrialProofBinding(parse(record), admitted)).not.toThrow()
})

it("also checks the real project binding before a process-local proof can back execution", () => {
  const record = running(),
    admitted = proof(record)
  record.project!["harness-adapter"].id = "another-plugin"
  expect(() => assertCreatorBusinessTrialProofBinding(record, admitted)).toThrow("PROOF_CHANGED")
})

it.each([
  "root",
  "digest",
  "candidate",
  "source",
  "plugin",
  "workspace",
  "inode",
  "feature",
  "scope",
  "goal",
  "plan"
] as const)("cannot reuse another captured %s as a proof", (change) => {
  const record = running(),
    admitted = proof(record)
  if (change === "root") admitted.root = join(options.packagesRoot, "f".repeat(64), "package")
  if (change === "digest") admitted.packageDigest = "f".repeat(64)
  if (change === "candidate") admitted.candidate.digest = "f".repeat(64)
  if (change === "source") admitted.candidate.sources[0].pluginId = "unrelated-enabled-source"
  if (change === "plugin") admitted.plugin.id = "unrelated-plugin"
  if (change === "workspace") admitted.workspace = join(root, "trial-Ff0123", "workspace")
  if (change === "inode") admitted.workspaceIdentity += "1"
  if (change === "feature") admitted.featureId = "another-feature"
  if (change === "scope") admitted.scope.threadId = "another-creator"
  if (change === "goal") admitted.goal = "another-goal"
  if (change === "plan") admitted.planId = "another-plan"
  expect(() => assertCreatorBusinessTrialProofBinding(parse(record), admitted)).toThrow(
    "PROOF_CHANGED"
  )
})
