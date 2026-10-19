import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { FlowAttempt, FlowRun } from "../../../shared/mods/flows/types"
import type { FlowFileRuntimeSettledCapture } from "../../../shared/mods/flows/file-recovery"
import {
  bindFlowFileReceipt,
  flowFileReceiptDigest,
  flowFileStructuredOutputDigest,
  flowFileTaskGoalDigest,
  readFlowFileReceiptData
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

describe("prompt recovery receipt data binding, not runtime authority", () => {
  it("keeps receipt bytes stable across progress changes and removal, but rejects changed results", () => {
    const f = fixture()
    const original = f.bind()
    f.attempt.progress = { phase: "model", text: "observed", updatedAt: 1 }
    expect(f.bind()).toEqual(original)
    f.attempt.fileRecoveryEvidence = f.bind()
    f.attempt.progress = { phase: "tool", toolName: "read_file", updatedAt: 2 }
    expect(readFlowFileReceiptData(f.run, f.attempt, "inc")).toEqual(original)
    delete f.attempt.progress
    expect(readFlowFileReceiptData(f.run, f.attempt, "inc")).toEqual(original)
    f.attempt.result!.summary = "changed actual result"
    expect(() => readFlowFileReceiptData(f.run, f.attempt, "inc")).toThrow("FLOW_FILE_RECEIPT_INVALID")
  })
  it("never repairs an already mismatched historical receipt digest", () => {
    const f = fixture()
    f.attempt.fileRecoveryEvidence = f.bind()
    f.attempt.fileRecoveryEvidence.receiptDigest.digest = "f".repeat(64)
    expect(() => readFlowFileReceiptData(f.run, f.attempt, "inc")).toThrow("FLOW_FILE_RECEIPT_INVALID")
  })
  it("roundtrips the settled data while preserving historical fingerprints and unknown usage", () => {
    const f = fixture()
    const evidence = f.bind()
    f.attempt.fileRecoveryEvidence = evidence
    const persisted = JSON.parse(JSON.stringify(f.run)) as FlowRun
    expect(readFlowFileReceiptData(persisted, persisted.attempts[0], "inc")).toEqual(evidence)
    expect(f.attempt.outputFingerprint).toBe(h)
    expect(evidence.providerUsageEvidenceIds).toEqual([])
    expect(evidence.modelCalls).toBe(2)
  })
  it("excludes only provenance/freshness metadata from the immutable receipt digest", () => {
    const f = fixture(),
      original = flowFileReceiptDigest(f.attempt)
    f.attempt.fileRecoveryEvidence = f.bind()
    f.attempt.invalidated = true
    Object.assign(f.attempt, { reusedFrom: { runId: "root", executionId: "exec1" } })
    expect(flowFileReceiptDigest(f.attempt)).toBe(original)
    expect(readFlowFileReceiptData(f.run, f.attempt, "inc").receiptDigest.digest).toBe(original)
    f.attempt.outputFingerprint = "replacement"
    expect(() => readFlowFileReceiptData(f.run, f.attempt, "inc")).toThrow(
      "FLOW_FILE_RECEIPT_INVALID"
    )
  })
  it.each([
    "workspace",
    "parentThreadId",
    "parentThreadIncarnation",
    "runId",
    "executionId"
  ] as const)("rejects cross-scope %s", (key) => {
    const f = fixture()
    f.capture.binding[key] = "other"
    expect(f.bind).toThrow("FLOW_FILE_RECEIPT_INVALID")
  })
  it("rejects model/definition/task/output mismatches", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.capture.dependencies.modelRef = "other"
      },
      (f: ReturnType<typeof fixture>) => {
        f.capture.dependencies.definitionDigest = sha("other")
      },
      (f: ReturnType<typeof fixture>) => {
        f.run.taskGoal = "new task"
      },
      (f: ReturnType<typeof fixture>) => {
        f.attempt.result!.summary = "forged"
      }
    ]) {
      const f = fixture()
      mutate(f)
      expect(f.bind).toThrow("FLOW_FILE_RECEIPT_INVALID")
    }
  })
  it("does not mint new evidence for copied, invalidated, or unfinished receipts", () => {
    for (const patch of [
      { reusedFrom: { runId: "old", executionId: "exec1" } },
      { invalidated: true },
      { status: "running" },
      { finishedAt: undefined }
    ]) {
      const f = fixture()
      Object.assign(f.attempt, patch)
      expect(f.bind).toThrow("FLOW_FILE_RECEIPT_INVALID")
    }
  })
  it("distinguishes a settled failed result from a passed result", () => {
    const f = fixture()
    f.attempt.status = "failed"
    f.attempt.result!.passed = false
    f.capture.structuredOutputDigest = flowFileStructuredOutputDigest(f.attempt.result!)
    expect(f.bind().passed).toBe(false)
  })
  it("binds exact prior text and provenance rather than accepting an invented context", () => {
    const f = fixture()
    f.attempt.fileRecoveryEvidence = f.bind()
    const next: FlowAttempt = {
      ...f.attempt,
      executionId: "exec2",
      stepId: "review",
      startedAt: 1003,
      finishedAt: 1004,
      fileRecoveryEvidence: undefined,
      result: { ...f.attempt.result!, summary: "reviewed" }
    }
    f.run.attempts.push(next)
    const capture = structuredClone(f.capture)
    capture.binding.executionId = next.executionId
    capture.dependencies.stepId = next.stepId
    const projected = { stepId: f.attempt.stepId, summary: f.attempt.result!.summary }
    capture.dependencies.context.digest = sha(JSON.stringify([projected]))
    capture.structuredOutputDigest = flowFileStructuredOutputDigest(next.result!)
    const refs = [
      {
        sourceRunId: "root",
        executionId: "exec1",
        receiptDigest: flowFileReceiptDigest(f.attempt),
        projectedTextDigest: sha(JSON.stringify(projected))
      }
    ]
    const bind = () =>
      bindFlowFileReceipt({
        run: f.run,
        attempt: next,
        capture,
        parentThreadIncarnation: "inc",
        priorReceipts: refs
      })
    next.fileRecoveryEvidence = bind()
    expect(readFlowFileReceiptData(f.run, next, "inc")).toEqual(next.fileRecoveryEvidence)
    delete next.fileRecoveryEvidence
    refs[0].sourceRunId = "invented"
    expect(bind).toThrow("FLOW_FILE_RECEIPT_INVALID")
    refs[0].sourceRunId = "root"
    capture.dependencies.context.digest = sha("different context")
    expect(bind).toThrow("FLOW_FILE_RECEIPT_INVALID")
  })
  it("rejects getters/proxies without executing them and bounds data before hashing", () => {
    const f = fixture()
    let reads = 0
    Object.defineProperty(f.capture, "dependencies", {
      enumerable: true,
      get() {
        reads++
        throw Error("getter")
      }
    })
    expect(f.bind).toThrow("FLOW_FILE_RECEIPT_INVALID")
    expect(reads).toBe(0)
    const g = fixture()
    g.capture.dependencies = new Proxy(g.capture.dependencies, {
      ownKeys() {
        throw Error("trap")
      }
    })
    expect(g.bind).toThrow("FLOW_FILE_RECEIPT_INVALID")
    const large = fixture()
    large.capture.providerUsageEvidenceIds = Array(129).fill("id")
    expect(large.bind).toThrow("FLOW_FILE_RECEIPT_INVALID")
  })
})

it("rejects virtual namespace, root, operation-count and mixed-profile mismatches", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.capture.virtualTree.treeId = "other"
    },
    (f: ReturnType<typeof fixture>) => {
      f.capture.virtualTree.finalRoot = sha("other")
    },
    (f: ReturnType<typeof fixture>) => {
      f.capture.virtualTree.effectIds = ["a", "b"]
    },
    (f: ReturnType<typeof fixture>) => {
      f.capture.dependencies.virtualInput.originDigest = sha("other")
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.fileNamespace!.initialRoot = sha("other")
    },
    (f: ReturnType<typeof fixture>) => {
      f.attempt.recoveryEvidence = {} as never
    }
  ]) {
    const f = fixture()
    mutate(f)
    expect(f.bind).toThrow("FLOW_FILE_RECEIPT_INVALID")
  }
})
