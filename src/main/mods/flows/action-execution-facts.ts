import { createHash } from "node:crypto"
import { isModObject } from "../../../shared/mods/v2/contracts"
import { parseClawActionIdentity, type ClawActionIdentity } from "../../../shared/mods/claw-actions"
import type { ModObject } from "../../../shared/mods/types"
import type {
  FlowAttempt,
  FlowRun,
  FlowStepResult,
  SavedFlow
} from "../../../shared/mods/flows/types"

/** Main-only facts, stored inside the existing attempt ledger and removed from all public reads. */
export interface FlowActionExecutionFacts {
  schemaVersion: 1
  runId: string
  threadId: string
  workspace: string
  definitionDigest: string
  executionId: string
  stepId: string
  provider: ClawActionIdentity
  passed: boolean
  text: string
  contextText?: string
  output?: ModObject
  outputDigest: string
  resultDigest: string
}
type PrivateAttempt = FlowAttempt & { __nativeActionFacts?: FlowActionExecutionFacts }
type OriginalActionResult = FlowStepResult & { __nativeContextText?: string }
const originals = new WeakMap<FlowStepResult, OriginalActionResult>()
const mandatoryFlows = new WeakSet<SavedFlow>()
/** Main-only custody opt-in for declared project consumers; serialized fields grant nothing. */
export function captureNativeFlowActionFacts<T extends SavedFlow>(saved: T): T {
  mandatoryFlows.add(saved)
  return saved
}
export function requiresNativeFlowActionFacts(saved: SavedFlow): boolean {
  return mandatoryFlows.has(saved)
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Capture before result publication; a public passed/output field cannot manufacture this custody. */
export async function publishOriginalFlowActionResult(
  original: FlowStepResult,
  publish: (result: FlowStepResult) => Promise<FlowStepResult>,
  contextText?: string
): Promise<FlowStepResult> {
  const captured: OriginalActionResult = structuredClone(original)
  if (contextText !== undefined) captured.__nativeContextText = contextText
  const published = await publish(original)
  // Optional custody must not turn a large ordinary display result into a failed action.
  // Mandatory consumers explicitly reject missing bounded original facts.
  if (Buffer.byteLength(JSON.stringify(captured)) <= 60 * 1024) originals.set(published, captured)
  return published
}
export function originalFlowActionResult(result: FlowStepResult): FlowStepResult | undefined {
  const original = originals.get(result)
  return original && structuredClone(original)
}

export function bindFlowActionExecutionFacts(
  run: FlowRun,
  attempt: FlowAttempt,
  result: FlowStepResult
): FlowActionExecutionFacts {
  const step = run.flow.definition.steps.find((item) => item.id === attempt.stepId)
  if (
    !step ||
    step.kind !== "plugin-action" ||
    result.source !== "plugin-action" ||
    !result.provider ||
    typeof result.passed !== "boolean" ||
    typeof result.summary !== "string" ||
    ((result as OriginalActionResult).__nativeContextText !== undefined &&
      typeof (result as OriginalActionResult).__nativeContextText !== "string") ||
    (result.output !== undefined && !isModObject(result.output))
  )
    throw Error("FLOW_ACTION_FACTS_INVALID")
  const provider = parseClawActionIdentity(result.provider)
  if (
    provider.pluginId !== step.pluginId ||
    provider.plugin !== step.plugin ||
    provider.digest !== step.digest ||
    provider.actionId !== step.actionId ||
    run.flow.digest !== digest(run.flow.definition)
  )
    throw Error("FLOW_ACTION_FACTS_SCOPE_CHANGED")
  const facts: FlowActionExecutionFacts = {
    schemaVersion: 1,
    runId: run.id,
    threadId: run.threadId,
    workspace: run.workspace,
    definitionDigest: run.flow.digest,
    executionId: attempt.executionId,
    stepId: step.id,
    provider,
    passed: result.passed,
    text: result.summary,
    ...((result as OriginalActionResult).__nativeContextText === undefined
      ? {}
      : { contextText: (result as OriginalActionResult).__nativeContextText }),
    ...(result.output === undefined ? {} : { output: structuredClone(result.output) }),
    outputDigest: digest(result.output ?? null),
    resultDigest: digest({
      passed: result.passed,
      text: result.summary,
      contextText: (result as OriginalActionResult).__nativeContextText ?? null,
      output: result.output ?? null
    })
  }
  if (Buffer.byteLength(JSON.stringify(facts)) > 64 * 1024) throw Error("FLOW_ACTION_FACTS_LIMIT")
  return facts
}

export function attachFlowActionExecutionFacts(
  run: FlowRun,
  executionId: string,
  facts: FlowActionExecutionFacts
): void {
  const attempt = run.attempts.find((item) => item.executionId === executionId)
  if (
    !attempt ||
    attempt.status !== "running" ||
    facts.executionId !== executionId ||
    facts.runId !== run.id ||
    facts.threadId !== run.threadId ||
    facts.workspace !== run.workspace
  )
    throw Error("FLOW_ACTION_FACTS_SCOPE_CHANGED")
  const target = attempt as PrivateAttempt
  target.__nativeActionFacts = structuredClone(facts)
}

export function readFlowActionExecutionFacts(
  run: FlowRun,
  executionId: string
): FlowActionExecutionFacts | undefined {
  const attempt = run.attempts.find((item) => item.executionId === executionId) as
    | PrivateAttempt
    | undefined
  const facts = attempt?.__nativeActionFacts
  if (!facts) return undefined
  const checked = bindFlowActionExecutionFacts(run, attempt!, {
    passed: facts.passed,
    summary: facts.text,
    source: "plugin-action",
    provider: facts.provider,
    ...(facts.output === undefined ? {} : { output: facts.output }),
    ...(facts.contextText === undefined ? {} : { __nativeContextText: facts.contextText })
  } as OriginalActionResult)
  if (JSON.stringify(facts) !== JSON.stringify(checked))
    throw Error("FLOW_ACTION_FACTS_SCOPE_CHANGED")
  return structuredClone(checked)
}
export function publicFlowActionRun(run: FlowRun): FlowRun {
  const clean = structuredClone(run)
  for (const attempt of clean.attempts) delete (attempt as PrivateAttempt).__nativeActionFacts
  return clean
}
/** Ordinary Flow updates cannot overwrite or manufacture host-held original action facts. */
export function retainFlowActionExecutionFacts(
  previous: FlowRun | undefined,
  next: FlowRun
): FlowRun {
  const retained = publicFlowActionRun(next)
  for (const attempt of retained.attempts) {
    const old = previous?.attempts.find((item) => item.executionId === attempt.executionId) as
      | PrivateAttempt
      | undefined
    if (old?.__nativeActionFacts)
      (attempt as PrivateAttempt).__nativeActionFacts = structuredClone(old.__nativeActionFacts)
  }
  return retained
}
