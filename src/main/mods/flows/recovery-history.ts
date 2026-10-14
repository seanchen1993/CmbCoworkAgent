import type { FlowFileNamespace } from "../../../shared/mods/flows/file-recovery"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import type { FlowAttempt, FlowRun } from "../../../shared/mods/flows/types"

export interface RecoveryHistoryAttempt extends FlowAttempt {
  reusedFrom?: { runId: string; executionId: string }
}
export interface RecoveryLineage {
  schemaVersion: 1
  rootRunId: string
  parentRunId?: string
  consumedBy?: string
  resumeCount: number
  rootDeadline: number
  /** Real ancestor executions, excluding copied receipts. Recomputed before every reservation. */
  inheritedExecutions: number
}
export type RecoveryHistoryRun = Omit<FlowRun, "attempts"> & {
  recovery?: RecoveryLineage
  attempts: RecoveryHistoryAttempt[]
}
/** Host-only candidate after evidence and authorization checks. This is not an IPC input. */
export interface FlowRecoveryCandidate {
  /** Supplied only after NativeHost validates and forks the exact retained prefix root. */
  fileNamespace?: FlowFileNamespace
  schemaVersion: 1
  sourceRunId: string
  sourceDigest: string
  /** Host has fenced the old owner; never accept this assertion from renderer input. */
  hostInactive: true
  /** Exact source attempts, not caller-created replacement results or a list of step names. */
  prefix: readonly RecoveryHistoryAttempt[]
}

const MAX_ROWS = 20
const MAX_BYTES = 4 * 1024 * 1024
const MAX_RESUMES = 8
const active = new Set(["queued", "running", "waiting"])
const statuses = new Set([...active, "complete", "failed", "cancelled", "interrupted"])
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200
function fail(code: string): never {
  throw Error(code)
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
function validateRun(run: RecoveryHistoryRun): void {
  if (
    !object(run) ||
    !validId(run.id) ||
    !validId(run.threadId) ||
    typeof run.workspace !== "string" ||
    !run.workspace ||
    !statuses.has(run.status) ||
    !Number.isSafeInteger(run.startedAt) ||
    run.startedAt < 0 ||
    !Number.isSafeInteger(run.epoch) ||
    run.epoch < 0 ||
    !object(run.flow) ||
    !Array.isArray(run.attempts) ||
    run.attempts.length > 512
  )
    fail("FLOW_RECOVERY_HISTORY_INVALID")
  const definition = parseFlowDefinition(run.flow.definition)
  if (
    hash(definition) !== run.flow.digest ||
    !Number.isSafeInteger(run.flow.revision) ||
    run.flow.revision < 1
  )
    fail("FLOW_RECOVERY_HISTORY_INVALID")
  if (run.fileNamespace) {
    const namespace = run.fileNamespace
    if (definition.schemaVersion !== 2 || definition.execution.profile !== "workspace-files-v1" ||
        !object(namespace) || !exactKeys(namespace, ["schemaVersion", "treeId", "initialRoot", "originDigest"]) ||
        namespace.schemaVersion !== 1 || !validId(namespace.treeId) ||
        ![namespace.initialRoot, namespace.originDigest].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)))
      fail("FLOW_FILE_NAMESPACE_INVALID")
  }
  const ids = new Set<string>()
  for (const attempt of run.attempts) {
    if (
      !object(attempt) ||
      !validId(attempt.executionId) ||
      ids.has(attempt.executionId) ||
      !validId(attempt.stepId) ||
      !["running", "waiting", "unknown", "passed", "failed", "skipped"].includes(attempt.status) ||
      !Number.isSafeInteger(attempt.startedAt) ||
      attempt.startedAt < 0 ||
      (!attempt.reusedFrom && attempt.startedAt < run.startedAt) ||
      (attempt.finishedAt !== undefined &&
        (!Number.isSafeInteger(attempt.finishedAt) || attempt.finishedAt < attempt.startedAt)) ||
      !Number.isSafeInteger(attempt.epoch) ||
      !Number.isSafeInteger(attempt.attempt) ||
      attempt.attempt < 1 ||
      attempt.epoch < 0 ||
      (attempt.invalidated !== undefined && typeof attempt.invalidated !== "boolean")
    )
      fail("FLOW_RECOVERY_HISTORY_INVALID")
    ids.add(attempt.executionId)
    if (
      attempt.reusedFrom &&
      (!object(attempt.reusedFrom) ||
        !exactKeys(attempt.reusedFrom, ["runId", "executionId"]) ||
        !validId(attempt.reusedFrom.runId) ||
        !validId(attempt.reusedFrom.executionId))
    )
      fail("FLOW_RECOVERY_REUSE_INVALID")
  }
  if (run.recovery === undefined) {
    if (run.attempts.some((attempt) => attempt.reusedFrom)) fail("FLOW_RECOVERY_PARENT_MISSING")
    return
  }
  const lineage = run.recovery
  if (
    !object(lineage) ||
    !exactKeys(lineage, [
      "schemaVersion",
      "rootRunId",
      "parentRunId",
      "consumedBy",
      "resumeCount",
      "rootDeadline",
      "inheritedExecutions"
    ]) ||
    lineage.schemaVersion !== 1 ||
    !validId(lineage.rootRunId) ||
    (lineage.parentRunId !== undefined && !validId(lineage.parentRunId)) ||
    (lineage.consumedBy !== undefined && !validId(lineage.consumedBy)) ||
    !Number.isSafeInteger(lineage.resumeCount) ||
    lineage.resumeCount < 0 ||
    lineage.resumeCount > MAX_RESUMES ||
    !Number.isSafeInteger(lineage.rootDeadline) ||
    !Number.isSafeInteger(lineage.inheritedExecutions) ||
    lineage.inheritedExecutions < 0
  )
    fail("FLOW_RECOVERY_LINEAGE_INVALID")
}

function receipt(attempt: RecoveryHistoryAttempt) {
  const value = { ...attempt }
  delete value.reusedFrom
  // Expiration is local to each run; immutable execution/result evidence remains exact.
  delete value.invalidated
  return value
}
function isDisabledNoEffect(run: RecoveryHistoryRun, attempt: RecoveryHistoryAttempt): boolean {
  return (
    attempt.status === "skipped" &&
    run.flow.definition.steps.find((step) => step.id === attempt.stepId)?.enabled === false &&
    attempt.result === undefined &&
    attempt.inputFingerprint === undefined &&
    attempt.outputFingerprint === undefined &&
    attempt.reusedFrom === undefined &&
    !attempt.invalidated &&
    Number.isSafeInteger(attempt.finishedAt) &&
    attempt.finishedAt! >= attempt.startedAt
  )
}
function actualExecutions(run: RecoveryHistoryRun): number {
  // Unrelated historical routes may legitimately have other kinds of skipped receipts.
  // Retain them, but never let an unproved skip erase work from a shared recovery budget.
  return run.attempts.filter((attempt) => !attempt.reusedFrom && !isDisabledNoEffect(run, attempt))
    .length
}

/** Validate every retained chain, so corrupt or orphaned history cannot be trimmed into fresh budget. */
function indexHistory(rows: readonly RecoveryHistoryRun[]) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS + 1) fail("FLOW_RECOVERY_HISTORY_LIMIT")
  const byId = new Map<string, RecoveryHistoryRun>()
  const scope = rows[0]
  for (const run of rows) {
    validateRun(run)
    if (byId.has(run.id)) fail("FLOW_RECOVERY_DUPLICATE_ID")
    if (run.workspace !== scope.workspace || run.threadId !== scope.threadId)
      fail("FLOW_RECOVERY_SCOPE_CHANGED")
    byId.set(run.id, run)
  }
  const chain = (run: RecoveryHistoryRun): RecoveryHistoryRun[] => {
    const result: RecoveryHistoryRun[] = []
    const seen = new Set<string>()
    let current: RecoveryHistoryRun | undefined = run
    while (current) {
      if (seen.has(current.id)) fail("FLOW_RECOVERY_PARENT_CYCLE")
      seen.add(current.id)
      result.unshift(current)
      const parentId: string | undefined = current.recovery?.parentRunId
      if (!parentId) break
      current = byId.get(parentId)
      if (!current) fail("FLOW_RECOVERY_PARENT_MISSING")
    }
    return result
  }
  for (const run of rows) {
    const ancestors = chain(run)
    const root = ancestors[0]
    const deadline = root.startedAt + root.flow.definition.timeoutMs
    let inherited = 0
    for (let index = 0; index < ancestors.length; index++) {
      const current = ancestors[index]
      const lineage = current.recovery
      if (index > 0 && (!lineage || ancestors[index - 1].recovery?.consumedBy !== current.id))
        fail("FLOW_RECOVERY_PARENT_LINK_INVALID")
      if (
        lineage &&
        (lineage.rootRunId !== root.id ||
          lineage.resumeCount !== index ||
          lineage.rootDeadline !== deadline ||
          lineage.inheritedExecutions !== inherited)
      )
        fail("FLOW_RECOVERY_BUDGET_INVALID")
      if (
        current.flow.digest !== root.flow.digest ||
        current.taskGoal !== root.taskGoal ||
        current.flow.revision !== root.flow.revision
      )
        fail("FLOW_RECOVERY_CONFIG_CHANGED")
      if (index && current.startedAt < ancestors[index - 1].startedAt)
        fail("FLOW_RECOVERY_HISTORY_INVALID")
      let actualSeen = false
      for (const attempt of current.attempts) {
        if (!attempt.reusedFrom) {
          actualSeen = true
          continue
        }
        const step = current.flow.definition.steps.find((item) => item.id === attempt.stepId)
        if (
          actualSeen ||
          !index ||
          attempt.reusedFrom.runId !== lineage?.parentRunId ||
          step?.kind !== "agent" ||
          attempt.status !== "passed" ||
          attempt.result?.passed !== true ||
          attempt.result.source !== "agent"
        )
          fail("FLOW_RECOVERY_REUSE_INVALID")
        const origin = ancestors.slice(0, index).find((row) => row.id === attempt.reusedFrom!.runId)
        const original = origin?.attempts.find(
          (row) => row.executionId === attempt.reusedFrom!.executionId
        )
        if (
          !original ||
          (original.invalidated && !attempt.invalidated) ||
          !isDeepStrictEqual(receipt(attempt), receipt(original))
        )
          fail("FLOW_RECOVERY_REUSE_INVALID")
      }
      inherited += actualExecutions(current)
      if (lineage?.consumedBy) {
        const child = byId.get(lineage.consumedBy)
        if (!child || child.recovery?.parentRunId !== current.id)
          fail("FLOW_RECOVERY_CHILD_MISSING")
      }
    }
  }
  return { byId, chain }
}

/** Only reservation ancestors need this restricted resumable route and effect proof. */
function reusablePrefix(run: RecoveryHistoryRun): RecoveryHistoryAttempt[] {
  const definition = run.flow.definition
  if (
    definition.schemaVersion !== 2 ||
    run.epoch !== 0 ||
    definition.steps.some(
      (step) =>
        step.when ||
        step.onSuccess ||
        step.onFailure ||
        !["agent", "check", "approval"].includes(step.kind)
    )
  )
    fail("FLOW_RECOVERY_ROUTE_UNSUPPORTED")
  const prefix: RecoveryHistoryAttempt[] = []
  let boundary = false
  let position = 0
  for (const attempt of run.attempts) {
    // Copied prefixes intentionally omit disabled no-effect records. Only such receipts
    // may cross omitted disabled slots; original execution records must stay in order.
    while (
      attempt.reusedFrom &&
      definition.steps[position]?.enabled === false &&
      definition.steps[position]?.id !== attempt.stepId
    )
      position++
    const step = definition.steps[position]
    if (!step || attempt.stepId !== step.id || attempt.epoch !== 0 || attempt.attempt !== 1)
      fail("FLOW_RECOVERY_PREFIX_INVALID")
    position++
    if (!step.enabled) {
      if (
        attempt.status !== "skipped" ||
        attempt.result !== undefined ||
        attempt.inputFingerprint !== undefined ||
        attempt.outputFingerprint !== undefined ||
        attempt.reusedFrom !== undefined ||
        attempt.invalidated ||
        !Number.isSafeInteger(attempt.finishedAt)
      )
        fail("FLOW_RECOVERY_PREFIX_INVALID")
      continue
    }
    if (attempt.status === "skipped") fail("FLOW_RECOVERY_PREFIX_INVALID")
    if (step.kind === "approval") {
      boundary = true
      continue
    }
    if (["running", "waiting", "unknown"].includes(attempt.status))
      fail("FLOW_RECOVERY_UNKNOWN_EFFECT")
    if (step.kind === "check") {
      if (
        !["passed", "failed"].includes(attempt.status) ||
        attempt.result?.source !== "native-check" ||
        attempt.result.passed !== (attempt.status === "passed") ||
        !Number.isSafeInteger(attempt.finishedAt) ||
        attempt.finishedAt! < attempt.startedAt
      )
        fail("FLOW_RECOVERY_UNKNOWN_EFFECT")
      boundary = true
      continue
    }
    if (
      boundary ||
      attempt.status !== "passed" ||
      attempt.result?.passed !== true ||
      attempt.result.source !== "agent" ||
      attempt.invalidated ||
      !attempt.inputFingerprint ||
      !attempt.outputFingerprint ||
      !Number.isSafeInteger(attempt.finishedAt) ||
      attempt.finishedAt! < attempt.startedAt
    )
      fail("FLOW_RECOVERY_PREFIX_INVALID")
    prefix.push(attempt)
  }
  return prefix
}

/** Returns an indivisible replacement value. Caller must synchronously reread, plan and set once.
 * No writes occur here. A successful plan is neither durable nor permission to execute.
 */
export function planFlowRecoveryReservation(
  rows: readonly RecoveryHistoryRun[],
  candidate: FlowRecoveryCandidate,
  input: { childRunId: string; now: number }
): { rows: RecoveryHistoryRun[]; child: RecoveryHistoryRun } {
  if (
    !object(candidate) ||
    !exactKeys(candidate, [
      "fileNamespace",
      "schemaVersion",
      "sourceRunId",
      "sourceDigest",
      "hostInactive",
      "prefix"
    ]) ||
    candidate.schemaVersion !== 1 ||
    candidate.hostInactive !== true ||
    !validId(candidate.sourceRunId) ||
    typeof candidate.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.sourceDigest) ||
    !Array.isArray(candidate.prefix) ||
    candidate.prefix.length > 128 ||
    !validId(input.childRunId) ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0
  )
    fail("FLOW_RECOVERY_CANDIDATE_INVALID")
  const { byId, chain } = indexHistory(rows)
  const source = byId.get(candidate.sourceRunId)
  if (!source) fail("FLOW_RECOVERY_SOURCE_MISSING")
  if (byId.has(input.childRunId)) fail("FLOW_RECOVERY_DUPLICATE_ID")
  if (source.recovery?.consumedBy) fail("FLOW_RECOVERY_SOURCE_CONSUMED")
  if (hash(source) !== candidate.sourceDigest) fail("FLOW_RECOVERY_STALE")
  if (source.status === "cancelled" || source.status === "complete") fail("FLOW_RECOVERY_STATUS")
  const ancestors = chain(source)
  for (const ancestor of ancestors) {
    if (["cancelled", "complete"].includes(ancestor.status)) fail("FLOW_RECOVERY_STATUS")
    // A source digest is not a proof that retained ancestor receipts are still valid.
    if (ancestor !== source) reusablePrefix(ancestor)
    if (
      ancestor.attempts.some(
        (attempt) =>
          attempt.startedAt > input.now ||
          (attempt.finishedAt !== undefined && attempt.finishedAt > input.now)
      )
    )
      fail("FLOW_RECOVERY_HISTORY_INVALID")
    if (
      ancestor.attempts.some(
        (attempt) =>
          ["running", "waiting", "unknown"].includes(attempt.status) &&
          ancestor.flow.definition.steps.find((step) => step.id === attempt.stepId)?.kind !==
            "approval"
      )
    )
      fail("FLOW_RECOVERY_UNKNOWN_EFFECT")
  }
  const root = ancestors[0]
  const rootDeadline = root.startedAt + root.flow.definition.timeoutMs
  const consumed = ancestors.reduce((sum, run) => sum + actualExecutions(run), 0)
  if (
    !Number.isSafeInteger(rootDeadline) ||
    input.now < source.startedAt ||
    input.now >= rootDeadline ||
    consumed >= root.flow.definition.maxExecutions ||
    ancestors.length > MAX_RESUMES
  )
    fail("FLOW_RECOVERY_BUDGET_EXHAUSTED")
  const prefix = reusablePrefix(source)
  if (!isDeepStrictEqual(candidate.prefix, prefix)) fail("FLOW_RECOVERY_PREFIX_CHANGED")
  const child: RecoveryHistoryRun = {
    id: input.childRunId,
    workspace: source.workspace,
    threadId: source.threadId,
    flow: structuredClone(source.flow),
    ...(source.taskGoal === undefined ? {} : { taskGoal: source.taskGoal }),
    ...(source.fileNamespace ? { fileNamespace: structuredClone(candidate.fileNamespace ?? source.fileNamespace) } : {}),
    status: "queued",
    startedAt: input.now,
    epoch: 0,
    failureCounts: {},
    attempts: prefix.map((attempt) => ({
      ...structuredClone(attempt),
      reusedFrom: { runId: source.id, executionId: attempt.executionId }
    })),
    recovery: {
      schemaVersion: 1,
      rootRunId: root.id,
      parentRunId: source.id,
      rootDeadline,
      resumeCount: ancestors.length,
      inheritedExecutions: consumed
    }
  }
  if (candidate.fileNamespace) {
    if (!source.fileNamespace || child.fileNamespace?.originDigest !== source.fileNamespace.originDigest ||
        child.fileNamespace?.initialRoot !== prefix.at(-1)?.fileRecoveryEvidence?.virtualTree.finalRoot ||
        child.fileNamespace?.treeId === source.fileNamespace.treeId) fail("FLOW_FILE_NAMESPACE_INVALID")
    validateRun(child)
  }
  const updated = structuredClone(source)
  // The host must have fenced inactive ownership before planning. Consumption closes the old wait.
  updated.status = "interrupted"
  delete updated.pendingApproval
  updated.recovery = {
    schemaVersion: 1,
    rootRunId: root.id,
    rootDeadline,
    resumeCount: ancestors.length - 1,
    inheritedExecutions: consumed - actualExecutions(source),
    ...(source.recovery?.parentRunId ? { parentRunId: source.recovery.parentRunId } : {}),
    consumedBy: child.id
  }
  const next = [
    child,
    ...rows.map((row) => (row.id === source.id ? updated : structuredClone(row)))
  ]
  const retained = planRecoveryHistoryRetention(next, [child.id])
  return { rows: retained, child: structuredClone(child) }
}

/** Trim entire terminal chains only. Never orphan receipts or discard active ancestors. */
export function planRecoveryHistoryRetention(
  rows: readonly RecoveryHistoryRun[],
  protectedIds: readonly string[] = []
): RecoveryHistoryRun[] {
  const { chain, byId } = indexHistory(rows)
  if (protectedIds.some((id) => !byId.has(id))) fail("FLOW_RECOVERY_PROTECTED_MISSING")
  const protectedSet = new Set(protectedIds)
  const groups = new Map<string, RecoveryHistoryRun[]>()
  for (const run of rows) {
    const root = chain(run)[0]
    groups.set(root.id, [...(groups.get(root.id) ?? []), run])
  }
  const removable = [...groups.values()]
    .filter((group) => group.every((run) => !active.has(run.status) && !protectedSet.has(run.id)))
    .sort(
      (left, right) =>
        Math.max(...left.map((row) => row.startedAt)) -
        Math.max(...right.map((row) => row.startedAt))
    )
  let retained = [...rows]
  while (retained.length > MAX_ROWS || Buffer.byteLength(JSON.stringify(retained)) > MAX_BYTES) {
    const group = removable.shift()
    if (!group) fail("FLOW_RECOVERY_HISTORY_LIMIT")
    const ids = new Set(group.map((run) => run.id))
    retained = retained.filter((run) => !ids.has(run.id))
  }
  return structuredClone(retained)
}
