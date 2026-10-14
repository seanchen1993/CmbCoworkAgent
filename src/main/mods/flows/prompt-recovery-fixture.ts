import { createHash } from "node:crypto"
import type { FlowAttempt, FlowRun } from "../../../shared/mods/flows/types"
import type { FlowPromptRuntimeSettledCapture } from "../../../shared/mods/flows/prompt-recovery"
import {
  bindFlowPromptReceipt,
  flowPromptStructuredOutputDigest,
  flowPromptTaskGoalDigest
} from "./prompt-recovery-receipt"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const h = sha("fixed")
export function promptReceiptFixture() {
  const attempt: FlowAttempt = {
    executionId: "exec1",
    stepId: "write",
    attempt: 1,
    epoch: 0,
    status: "passed",
    startedAt: 1001,
    finishedAt: 1002,
    inputFingerprint: "old-before",
    outputFingerprint: "old-after",
    result: { passed: true, summary: "完整文本：保持原样", source: "agent", modelId: "model" }
  }
  const run: FlowRun = {
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
        execution: { kind: "host", profile: "prompt-only-v1" },
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
  const capture: FlowPromptRuntimeSettledCapture = {
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
    dependencies: {
      schemaVersion: 1,
      coverage: "prompt-and-prior-receipts",
      profile: "prompt-only-v1",
      runtimeProtocol: "flow-text-runtime-v1",
      definitionDigest: h,
      taskGoalDigest: flowPromptTaskGoalDigest(run),
      stepId: "write",
      modelRef: "model",
      modelConfigurationDigest: h,
      mandatoryPolicyDigest: h,
      systemPromptDigest: h,
      rolePromptDigest: h,
      stableInput: { version: 1, digest: h },
      context: { version: 1, digest: sha("[]") },
      priorProjection: "prompt-only-prior-v1",
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
    structuredOutputDigest: flowPromptStructuredOutputDigest(attempt.result!),
    modelCalls: 2,
    providerUsageEvidenceIds: []
  }
  const bind = () =>
    bindFlowPromptReceipt({
      run,
      attempt,
      capture,
      parentThreadIncarnation: "inc",
      priorReceipts: []
    })
  return { run, attempt, capture, bind }
}
