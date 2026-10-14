import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import type { FlowAttempt, FlowRun } from "../../../shared/mods/flows/types"
import type { FlowFileRuntimeSettledCapture } from "../../../shared/mods/flows/file-recovery"
import {
  bindFlowFileReceipt,
  flowFileStructuredOutputDigest,
  flowFileTaskGoalDigest,
} from "./file-recovery-receipt"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const h = sha("fixed")
function fixture() {
  const attempt: FlowAttempt = {
    executionId: "exec1",
    stepId: "write",
    attempt: 1,
    epoch: 0,
    status: "passed",
    startedAt: 1001,
    finishedAt: 1002,
    inputFingerprint: h,
    outputFingerprint: h,
    result: { passed: true, summary: "完整文本：保持原样", source: "agent", modelId: "model" }
  }
  const run: FlowRun = {
    fileNamespace: { schemaVersion: 1, treeId: "tree", initialRoot: h, originDigest: h },
    id: "root",
    workspace: "workspace",
    threadId: "parent",
    startedAt: 1000,
    status: "running",
    epoch: 0,
    attempts: [attempt],
    failureCounts: {},
    flow: {
      revision: 1,
      digest: h,
      updatedAt: 1,
      definition: {
        schemaVersion: 2,
        execution: { kind: "host", profile: "workspace-files-v1" },
        id: "flow",
        name: "Flow",
        goal: "text",
        timeoutMs: 60000,
        maxExecutions: 16,
        steps: [
          { id: "write", name: "write", kind: "agent", enabled: true, prompt: "write" },
          { id: "review", name: "review", kind: "agent", enabled: true, prompt: "review" }
        ]
      }
    }
  }
  const capture: FlowFileRuntimeSettledCapture = {
    schemaVersion: 1,
    binding: {
      workspace: "workspace",
      parentThreadId: "parent",
      parentThreadIncarnation: "inc",
      runId: "root",
      executionId: "exec1",
      childThreadId: "child",
      childThreadIncarnation: "child-inc",
      leaseGeneration: "lease"
    },
    virtualTree: {
      schemaVersion: 1,
      treeId: "tree",
      inputRoot: h,
      finalRoot: h,
      originDigest: h,
      readDependencyDigest: h,
      effectLedgerDigest: h,
      fileCallLedgerDigest: h,
      fileCalls: 1,
      effectIds: []
    },
    dependencies: {
      schemaVersion: 1,
      coverage: "prompt-prior-and-virtual-root",
      profile: "workspace-files-v1",
      runtimeProtocol: "flow-files-runtime-v1",
      definitionDigest: h,
      taskGoalDigest: flowFileTaskGoalDigest(run),
      stepId: "write",
      modelRef: "model",
      modelConfigurationDigest: h,
      mandatoryPolicyDigest: h,
      systemPromptDigest: h,
      rolePromptDigest: h,
      stableInput: { version: 1, digest: h },
      context: { version: 1, digest: sha("[]") },
      priorProjection: "files-prior-v1",
      virtualInput: { version: 1, root: h, originDigest: h },
      resultTool: {
        protocol: "host-workflow-structured-output-v1",
        name: "structured_output",
        schemaDigest: h,
        implementationDigest: h
      }
    },
    actualCapabilitiesDigest: h,
    modelRequestLedgerDigest: h,
    invocationLedgerDigest: h,
    structuredOutputDigest: flowFileStructuredOutputDigest(attempt.result!),
    modelCalls: 2,
    providerUsageEvidenceIds: []
  }
  const bind = () =>
    bindFlowFileReceipt({
      run,
      attempt,
      capture,
      parentThreadIncarnation: "inc",
      priorReceipts: []
    })
  return { run, attempt, capture, bind }
}

import { projectFlowExecutionEvidence } from "./execution-evidence"
import type { CompletionEvidenceRecord } from "../v2/completion-evidence"
it("projects a real file receipt without treating it as present-state permission", () => {
  const f = fixture(); f.attempt.fileRecoveryEvidence = f.bind()
  const store = { completionEvidenceByIds: () => ({ records: [], missingIds: [], invalidIds: [], limitedIds: [] }) }
  const view = projectFlowExecutionEvidence(f.run, [f.run], store)
  expect(view.attempts[0].receipt).toMatchObject({ state: "recorded", coverage: "prompt-prior-and-virtual-root", modelCalls: 2 })
  expect(view.currentArtifacts).toBe("not-rechecked")
  f.attempt.result!.summary = "changed-after-settlement"
  expect(projectFlowExecutionEvidence(f.run, [f.run], store).attempts[0].receipt.state).toBe("invalid")
})
function checkFixture() {
  const f = fixture()
  f.run.flow.definition.steps = [{ id: "test", name: "test", enabled: true, kind: "check", check: "unit-test" }]
  f.run.attempts = [{ executionId: "check-attempt", stepId: "test", attempt: 1, epoch: 0, status: "passed", startedAt: 1001, finishedAt: 1005, inputFingerprint: h, outputFingerprint: h, result: { source: "native-check", passed: true, summary: "private output", check: "unit-test", evidenceIds: ["check"] } }]
  const record: CompletionEvidenceRecord = { id: "check", idempotencyKey: "check", workspace: f.run.workspace, threadId: f.run.threadId, runId: f.run.id, turnId: f.run.id, at: 1003, phase: "check.result", status: "pass", binding: { workspace: f.run.workspace, threadId: f.run.threadId, runId: f.run.id, turnId: f.run.id, pluginDigests: {}, runtimeGeneration: 1, diffFingerprint: h, stateFingerprint: h, requirementVersion: h, configFingerprint: h, files: [] }, detail: { source: "host-virtual-tree-check", stepId: "test", executionId: "actual-native-process", kind: "unit-test", passed: true, virtualRoot: h, originDigest: h } }
  const store = { completionEvidenceByIds: () => ({ records: [record], missingIds: [], invalidIds: [], limitedIds: [] }) }
  return { ...f, record, read: () => projectFlowExecutionEvidence(f.run, [f.run], store) }
}
it("labels exact virtual input test evidence distinctly from physical project tests", () => {
  const f = checkFixture(), view = f.read()
  expect(view.attempts[0].checks[0]).toMatchObject({ state: "found", kind: "native-virtual-test", status: "pass", check: "unit-test" })
  expect(JSON.stringify(view)).not.toContain("private output")
})
it.each(["root", "origin", "time", "result", "reused"])("never upgrades mismatched file-check %s to a gate PASS", field => {
  const f = checkFixture()
  if (field === "root") (f.record.detail as Record<string, unknown>).virtualRoot = "b".repeat(64)
  if (field === "origin") f.record.binding!.requirementVersion = "b".repeat(64)
  if (field === "time") f.record.at = 1006
  if (field === "result") (f.record.detail as Record<string, unknown>).passed = false
  if (field === "reused") Object.assign(f.run.attempts[0], { reusedFrom: { runId: "foreign", executionId: "attempt" } })
  expect(f.read().attempts[0].checks[0]).toMatchObject({ state: "unlinked", kind: "unknown" })
})
