import { createHash } from "node:crypto"
import { types } from "node:util"
import type { FlowAttempt, FlowRun } from "../../../shared/mods/flows/types"
import { projectFileOnlyPrior } from "../../../shared/mods/flows/file-only-prior"
import type {
  FlowFileRecoveryEvidence,
  FlowFileRuntimeSettledCapture
} from "../../../shared/mods/flows/file-recovery"

function fail(): never {
  throw Error("FLOW_FILE_RECEIPT_INVALID")
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const digestValue = (value: unknown) => sha(JSON.stringify(snapshot(value)))
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const text = (value: unknown, limit = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0

/** Bounded data copy. Never run getters, toJSON, proxy traps, or caller-provided iteration. */
function snapshot(value: unknown): unknown {
  let nodes = 0
  let characters = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) fail()
    if (item === null || typeof item === "boolean") return item
    if (typeof item === "string") {
      if ((characters += item.length) > 96 * 1024) fail()
      return item
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail()
      return item
    }
    if (!item || typeof item !== "object" || types.isProxy(item)) fail()
    if (Array.isArray(item)) {
      const length = Object.getOwnPropertyDescriptor(item, "length")?.value
      if (!integer(length) || length > 128 || Reflect.ownKeys(item).length !== length + 1) fail()
      const result: unknown[] = []
      for (let index = 0; index < length; index++) {
        const field = Object.getOwnPropertyDescriptor(item, String(index))
        if (!field || !("value" in field) || !field.enumerable) fail()
        result.push(visit(field.value, depth + 1))
      }
      return result
    }
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) fail()
    const keys = Reflect.ownKeys(item)
    if (keys.length > 64 || keys.some((key) => typeof key !== "string")) fail()
    const result: Record<string, unknown> = {}
    for (const key of (keys as string[]).sort()) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail()
      const field = Object.getOwnPropertyDescriptor(item, key)
      if (!field || !("value" in field) || !field.enumerable) fail()
      // Optional fields are omitted identically before and after JSON persistence.
      if (field.value !== undefined) result[key] = visit(field.value, depth + 1)
    }
    return result
  }
  return visit(value, 0)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, required: string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== required.length || required.some((key) => !Object.hasOwn(value, key)))
    fail()
}
function versionedHash(value: unknown): void {
  const row = record(value)
  keys(row, ["version", "digest"])
  if (row.version !== 1 || !hash(row.digest)) fail()
}

/** Shape/integrity only. Actual runtime identity and current authority are checked by the host. */
function captureData(value: unknown): FlowFileRuntimeSettledCapture {
  const row = record(snapshot(value))
  keys(row, [
    "schemaVersion",
    "binding",
    "dependencies",
    "virtualTree",
    "actualCapabilitiesDigest",
    "modelRequestLedgerDigest",
    "invocationLedgerDigest",
    "structuredOutputDigest",
    "modelCalls",
    "providerUsageEvidenceIds"
  ])
  if (
    row.schemaVersion !== 1 ||
    !integer(row.modelCalls) ||
    row.modelCalls < 1 ||
    row.modelCalls > 512
  )
    fail()
  for (const key of [
    "actualCapabilitiesDigest",
    "modelRequestLedgerDigest",
    "invocationLedgerDigest",
    "structuredOutputDigest"
  ])
    if (!hash(row[key])) fail()
  if (
    !Array.isArray(row.providerUsageEvidenceIds) ||
    row.providerUsageEvidenceIds.length > 64 ||
    row.providerUsageEvidenceIds.some((id) => !text(id))
  )
    fail()
  const binding = record(row.binding)
  keys(binding, [
    "workspace",
    "parentThreadId",
    "parentThreadIncarnation",
    "runId",
    "executionId",
    "childThreadId",
    "childThreadIncarnation",
    "leaseGeneration"
  ])
  for (const [key, value] of Object.entries(binding))
    if (!text(value, key === "workspace" ? 4096 : 200)) fail()
  if (binding.childThreadId === binding.parentThreadId) fail()
  const dependencies = record(row.dependencies)
  keys(dependencies, [
    "schemaVersion",
    "coverage",
    "profile",
    "runtimeProtocol",
    "definitionDigest",
    "taskGoalDigest",
    "stepId",
    "modelRef",
    "modelConfigurationDigest",
    "mandatoryPolicyDigest",
    "systemPromptDigest",
    "rolePromptDigest",
    "stableInput",
    "context",
    "priorProjection",
    "virtualInput",
    "resultTool"
  ])
  if (
    dependencies.schemaVersion !== 1 ||
    dependencies.coverage !== "prompt-prior-and-virtual-root" ||
    dependencies.profile !== "workspace-files-v1" ||
    dependencies.runtimeProtocol !== "flow-files-runtime-v1" ||
    dependencies.priorProjection !== "files-prior-v1" ||
    !text(dependencies.stepId) ||
    !text(dependencies.modelRef)
  )
    fail()
  for (const key of [
    "definitionDigest",
    "taskGoalDigest",
    "modelConfigurationDigest",
    "mandatoryPolicyDigest",
    "systemPromptDigest",
    "rolePromptDigest"
  ])
    if (!hash(dependencies[key])) fail()
  versionedHash(dependencies.stableInput)
  versionedHash(dependencies.context)
  const tool = record(dependencies.resultTool)
  keys(tool, ["protocol", "name", "schemaDigest", "implementationDigest"])
  if (
    tool.protocol !== "host-workflow-structured-output-v1" ||
    tool.name !== "structured_output" ||
    !hash(tool.schemaDigest) ||
    !hash(tool.implementationDigest)
  )
    fail()
  const virtualInput = record(dependencies.virtualInput)
  keys(virtualInput, ["version", "root", "originDigest"])
  if (virtualInput.version !== 1 || !hash(virtualInput.root) || !hash(virtualInput.originDigest))
    fail()
  const tree = record(row.virtualTree)
  keys(tree, [
    "schemaVersion",
    "treeId",
    "inputRoot",
    "finalRoot",
    "originDigest",
    "readDependencyDigest",
    "effectLedgerDigest",
    "fileCallLedgerDigest",
    "fileCalls",
    "effectIds"
  ])
  if (
    tree.schemaVersion !== 1 ||
    !text(tree.treeId) ||
    !integer(tree.fileCalls) ||
    tree.fileCalls > 64
  )
    fail()
  for (const key of [
    "inputRoot",
    "finalRoot",
    "originDigest",
    "readDependencyDigest",
    "effectLedgerDigest",
    "fileCallLedgerDigest"
  ])
    if (!hash(tree[key])) fail()
  if (
    tree.inputRoot !== virtualInput.root ||
    tree.originDigest !== virtualInput.originDigest ||
    !Array.isArray(tree.effectIds) ||
    tree.effectIds.length > tree.fileCalls ||
    tree.effectIds.some((id) => !text(id)) ||
    new Set(tree.effectIds).size !== tree.effectIds.length
  )
    fail()
  if (!tree.effectIds.length && tree.inputRoot !== tree.finalRoot) fail()
  return row as unknown as FlowFileRuntimeSettledCapture
}

/** Hashes immutable receipt fields; legitimate later invalidation does not rewrite provenance. */
export function flowFileReceiptDigest(attempt: FlowAttempt): string {
  const row = record(snapshot(attempt))
  delete row.fileRecoveryEvidence
  delete row.invalidated
  delete row.reusedFrom
  // Public progress is mutable presentation data, never execution provenance.
  delete row.progress
  return digestValue(row)
}

export function flowFileStructuredOutputDigest(result: {
  passed: boolean
  summary: string
}): string {
  const value = record(snapshot(result))
  if (typeof value.passed !== "boolean" || typeof value.summary !== "string") fail()
  return digestValue({ passed: value.passed, summary: value.summary })
}

export const flowFileTaskGoalDigest = (run: FlowRun): string => digestValue(run.taskGoal ?? "")

function assertBinding(
  run: FlowRun,
  attempt: FlowAttempt,
  capture: FlowFileRuntimeSettledCapture,
  parentThreadIncarnation: string
): void {
  const definition = run.flow.definition
  const step = definition.steps.find((row) => row.id === attempt.stepId)
  if (
    definition.schemaVersion !== 2 ||
    definition.execution.profile !== "workspace-files-v1" ||
    step?.kind !== "agent" ||
    !step.enabled ||
    attempt.epoch !== 0 ||
    attempt.attempt !== 1 ||
    !["passed", "failed"].includes(attempt.status) ||
    !integer(attempt.startedAt) ||
    !integer(attempt.finishedAt) ||
    attempt.startedAt < run.startedAt ||
    attempt.finishedAt < attempt.startedAt ||
    !attempt.result ||
    attempt.result.source !== "agent" ||
    attempt.result.passed !== (attempt.status === "passed") ||
    typeof attempt.result.summary !== "string" ||
    !attempt.result.summary.trim() ||
    attempt.result.summary.length > 8000
  )
    fail()
  const binding = capture.binding,
    dependencies = capture.dependencies
  if (
    !run.fileNamespace ||
    run.fileNamespace.schemaVersion !== 1 ||
    run.fileNamespace.treeId !== capture.virtualTree.treeId ||
    run.fileNamespace.originDigest !== capture.virtualTree.originDigest ||
    attempt.inputFingerprint !== capture.virtualTree.inputRoot ||
    attempt.outputFingerprint !== capture.virtualTree.finalRoot ||
    binding.workspace !== run.workspace ||
    binding.parentThreadId !== run.threadId ||
    binding.parentThreadIncarnation !== parentThreadIncarnation ||
    binding.runId !== run.id ||
    binding.executionId !== attempt.executionId ||
    dependencies.definitionDigest !== run.flow.digest ||
    dependencies.taskGoalDigest !== flowFileTaskGoalDigest(run) ||
    dependencies.stepId !== attempt.stepId ||
    dependencies.modelRef !== attempt.result.modelId ||
    capture.structuredOutputDigest !== flowFileStructuredOutputDigest(attempt.result)
  )
    fail()
}

/** Pure data binding after the caller authenticates a private sealed capture and child cleanup. */
export function bindFlowFileReceipt(input: {
  run: FlowRun
  attempt: FlowAttempt
  capture: FlowFileRuntimeSettledCapture
  parentThreadIncarnation: string
  priorReceipts: FlowFileRecoveryEvidence["priorReceipts"]
}): FlowFileRecoveryEvidence {
  const capture = captureData(input.capture)
  const attempt = snapshot(input.attempt) as FlowAttempt
  if (
    attempt.recoveryEvidence ||
    attempt.fileRecoveryEvidence ||
    attempt.invalidated ||
    (attempt as FlowAttempt & { reusedFrom?: unknown }).reusedFrom
  )
    fail()
  assertBinding(input.run, attempt, capture, input.parentThreadIncarnation)
  const prior = snapshot(input.priorReceipts)
  if (!Array.isArray(prior)) fail()
  for (const item of prior) {
    const ref = record(item)
    keys(ref, ["sourceRunId", "executionId", "receiptDigest", "projectedTextDigest"])
    if (
      !text(ref.sourceRunId) ||
      !text(ref.executionId) ||
      !hash(ref.receiptDigest) ||
      !hash(ref.projectedTextDigest)
    )
      fail()
  }
  const target = input.run.flow.definition.steps.findIndex((step) => step.id === attempt.stepId)
  const previousSteps = input.run.flow.definition.steps
    .slice(0, target)
    .filter((step) => step.enabled && step.kind === "agent")
  const previous = input.run.attempts.filter((row) =>
    previousSteps.some((step) => step.id === row.stepId)
  )
  const expectedInput =
    previous.at(-1)?.fileRecoveryEvidence?.virtualTree.finalRoot ??
    input.run.fileNamespace?.initialRoot
  if (capture.virtualTree.inputRoot !== expectedInput) fail()
  const projection = projectFileOnlyPrior(input.run.flow.definition, attempt.stepId, previous)
  if (
    capture.dependencies.context.digest !== sha(projection.text) ||
    prior.length !== previous.length
  )
    fail()
  for (let index = 0; index < previous.length; index++) {
    const receipt = previous[index],
      ref = record(prior[index])
    if (
      !receipt.fileRecoveryEvidence ||
      ref.sourceRunId !== receipt.fileRecoveryEvidence.binding.runId ||
      ref.executionId !== receipt.executionId ||
      ref.receiptDigest !== flowFileReceiptDigest(receipt) ||
      ref.projectedTextDigest !==
        digestValue({ stepId: receipt.stepId, summary: receipt.result!.summary })
    )
      fail()
  }
  return {
    ...capture,
    evidenceKind: "flow-resumable-files-execution",
    state: "settled",
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt!,
    passed: attempt.result!.passed,
    output: { version: 1, digest: capture.structuredOutputDigest },
    receiptDigest: { version: 1, digest: flowFileReceiptDigest(attempt) },
    priorReceipts: prior as unknown as FlowFileRecoveryEvidence["priorReceipts"]
  }
}

/** Original run must come from validated history provenance, never from renderer input.
 * This verifies durable data integrity only; current dependencies/authorization need a new host check.
 */
export function readFlowFileReceiptData(
  originalRun: FlowRun,
  attempt: FlowAttempt,
  parentThreadIncarnation: string
): FlowFileRecoveryEvidence {
  const row = record(snapshot(attempt.fileRecoveryEvidence))
  keys(row, [
    "schemaVersion",
    "binding",
    "dependencies",
    "virtualTree",
    "actualCapabilitiesDigest",
    "modelRequestLedgerDigest",
    "invocationLedgerDigest",
    "structuredOutputDigest",
    "modelCalls",
    "providerUsageEvidenceIds",
    "evidenceKind",
    "state",
    "startedAt",
    "finishedAt",
    "passed",
    "output",
    "receiptDigest",
    "priorReceipts"
  ])
  const {
    evidenceKind,
    state,
    startedAt,
    finishedAt,
    passed,
    output,
    receiptDigest,
    priorReceipts,
    ...rawCapture
  } = row
  if (
    evidenceKind !== "flow-resumable-files-execution" ||
    state !== "settled" ||
    startedAt !== attempt.startedAt ||
    finishedAt !== attempt.finishedAt ||
    passed !== attempt.result?.passed
  )
    fail()
  versionedHash(output)
  versionedHash(receiptDigest)
  const bare = { ...attempt }
  delete bare.fileRecoveryEvidence
  delete (bare as FlowAttempt & { reusedFrom?: unknown }).reusedFrom
  delete bare.invalidated
  // Invalidation is a later freshness fact, not a rewrite of what the original model received.
  const historicalRun = {
    ...originalRun,
    attempts: originalRun.attempts.map((item) => {
      const copy = { ...item }
      delete copy.invalidated
      return copy
    })
  }
  const expected = bindFlowFileReceipt({
    run: historicalRun,
    attempt: bare,
    capture: rawCapture as unknown as FlowFileRuntimeSettledCapture,
    parentThreadIncarnation,
    priorReceipts: priorReceipts as FlowFileRecoveryEvidence["priorReceipts"]
  })
  if (digestValue(row) !== digestValue(expected)) fail()
  return expected
}
