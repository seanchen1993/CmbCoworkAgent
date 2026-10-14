import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { SkillOptimizationCandidate } from "../../agent/optimizer/skill-optimizer"
import type { SkillEvaluationApi, SkillEvaluationView } from "../../../shared/mods/skill-evaluation"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import { EvaluationNotStarted, type EvaluationRunner, type EvaluationScope } from "./runner"
import type { FlowStore } from "../flows/store"
import { flowDigest } from "../flows/store"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import { injectSkillSnapshot, skillTextDigest, validateSkillText } from "./skill-snapshots"
import type { SkillSnapshotFiles } from "./skill-files"

type ApiInput<K extends "prepare" | "start" | "change"> = Parameters<SkillEvaluationApi[K]>[0]
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const saved = z.custom<SavedFlow>((value) => {
  try {
    const row = value as SavedFlow
    return (
      row.digest === flowDigest(parseFlowDefinition(row.definition)) &&
      Number.isSafeInteger(row.revision) &&
      row.revision > 0
    )
  } catch {
    return false
  }
})
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    workspace: z.string().min(1).max(4096),
    threadId: z.string().min(1).max(200),
    skillId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
    name: z.string().min(1).max(200),
    candidateId: z.string().min(1).max(200),
    baseline: z.string().max(6000).nullable(),
    candidate: z.string().min(1).max(6000),
    baselineDigest: sha,
    candidateDigest: sha,
    sourceTraceIds: z.array(z.string().min(1).max(200)).max(40),
    fixture: saved,
    agentStepId: z.string().min(1).max(80),
    pair: z.object({ baseline: saved, candidate: saved }).strict(),
    state: z.enum([
      "prepared",
      "evaluating",
      "adopting",
      "adopted",
      "rolling-back",
      "rolled-back",
      "unknown"
    ]),
    evaluationId: z.string().uuid().optional(),
    recoveryDirectory: z.string().max(4096).optional()
  })
  .strict()
type Record = z.infer<typeof recordSchema>
const recordDigest = (row: Record) => flowDigest(recordSchema.parse(row))
interface Settings {
  getSetting(key: string, fallback?: string): string
  compareAndSetSetting?(key: string, expected: string | undefined, next: string): boolean
}
interface Dependencies {
  settings: Settings
  candidates(): SkillOptimizationCandidate[]
  files: Pick<SkillSnapshotFiles, "read" | "replace">
  flows: Pick<FlowStore, "get">
  runner: EvaluationRunner
  changed(): void
}
const KEY = "mods-skill-evaluation-bridge-v1"
/** Independent creator workflow: never changes the existing optimizer's candidate status or APIs. */
export class SkillEvaluationBridge {
  private readonly active = new Set<string>()
  constructor(private readonly deps: Dependencies) {
    deps.runner.protectReports?.((workspace, threadId, id, baselineDigest, candidateDigest) =>
      this.read().rows.some(
        (row) =>
          row.workspace === workspace &&
          row.threadId === threadId &&
          (row.evaluationId === id ||
            (!row.evaluationId &&
              row.state !== "prepared" &&
              row.pair.baseline.digest === baselineDigest &&
              row.pair.candidate.digest === candidateDigest))
      )
    )
  }
  private read() {
    const raw = this.deps.settings.getSetting(KEY, "")
    if (Buffer.byteLength(raw) > 1024 * 1024) throw Error("SKILL_EVALUATION_LIMIT")
    const rows = z
      .array(recordSchema)
      .max(16)
      .parse(JSON.parse(raw || "[]"))
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw Error("SKILL_EVALUATION_INVALID")
    for (const row of rows) {
      if (
        skillTextDigest(row.baseline) !== row.baselineDigest ||
        skillTextDigest(row.candidate) !== row.candidateDigest ||
        flowDigest(injectSkillSnapshot(row.fixture, row.agentStepId, row.baseline)) !==
          flowDigest(row.pair.baseline) ||
        flowDigest(injectSkillSnapshot(row.fixture, row.agentStepId, row.candidate)) !==
          flowDigest(row.pair.candidate)
      )
        throw Error("SKILL_EVALUATION_INVALID")
    }
    return { raw, rows }
  }
  private save(row: Record, expected?: string) {
    const { raw, rows } = this.read(),
      prior = rows.find((value) => value.id === row.id)
    if (expected ? !prior || recordDigest(prior) !== expected : !!prior)
      throw Error("SKILL_EVALUATION_STALE")
    const next = [...rows.filter((value) => value.id !== row.id), recordSchema.parse(row)]
    const encoded = JSON.stringify(next)
    if (next.length > 16 || Buffer.byteLength(encoded) > 1024 * 1024)
      throw Error("SKILL_EVALUATION_LIMIT")
    if (!this.deps.settings.compareAndSetSetting?.(KEY, raw || undefined, encoded))
      throw Error("SKILL_EVALUATION_STALE")
  }
  private guard(scope: EvaluationScope) {
    scope.signal.throwIfAborted()
    scope.assertCurrent()
    scope.signal.throwIfAborted()
  }
  private row(scope: EvaluationScope, id: string, expected?: string) {
    const row = this.read().rows.find(
      (row) => row.id === id && row.workspace === scope.workspace && row.threadId === scope.threadId
    )
    if (!row || (expected && recordDigest(row) !== expected)) throw Error("SKILL_EVALUATION_STALE")
    return row
  }
  private view(row: Record, scope: EvaluationScope): SkillEvaluationView {
    const evaluation = row.evaluationId
      ? this.deps.runner.list(scope).find((value) => value.id === row.evaluationId)
      : undefined
    if (
      evaluation &&
      (evaluation.baseline.digest !== row.pair.baseline.digest ||
        evaluation.candidate.digest !== row.pair.candidate.digest)
    )
      throw Error("SKILL_EVALUATION_STALE")
    return {
      id: row.id,
      digest: recordDigest(row),
      skillId: row.skillId,
      name: row.name,
      candidateId: row.candidateId,
      maxExecutions: row.fixture.definition.maxExecutions,
      baselineDigest: row.baselineDigest,
      candidateDigest: row.candidateDigest,
      sourceTraceIds: [...row.sourceTraceIds],
      baselineText: row.baseline,
      candidateText: row.candidate,
      state:
        (row.state === "evaluating" && !row.evaluationId) ||
        (["adopting", "rolling-back"].includes(row.state) && !this.active.has(row.skillId))
          ? "unknown"
          : row.state,
      ...(evaluation ? { evaluation } : {}),
      ...(row.recoveryDirectory ? { recoveryDirectory: row.recoveryDirectory } : {})
    }
  }
  private canDiscard(row: Record, scope: EvaluationScope): boolean {
    if (row.recoveryDirectory || this.active.has(row.skillId)) return false
    if (row.state === "prepared") return !row.evaluationId
    if (row.state !== "evaluating" || !row.evaluationId) return false
    try {
      return this.deps.runner.isSettled(
        { ...scope, workspace: row.workspace, threadId: row.threadId },
        row.evaluationId
      )
    } catch {
      // Missing or unreadable foreign history cannot authorize deletion or hide other quota entries.
      return false
    }
  }
  private canForgetHistory(row: Record, scope: EvaluationScope): boolean {
    if (
      !["adopted", "rolled-back"].includes(row.state) ||
      !row.recoveryDirectory ||
      !row.evaluationId ||
      this.active.has(row.skillId)
    )
      return false
    if (
      this.read().rows.some(
        (other) =>
          other.skillId === row.skillId &&
          (["adopting", "rolling-back", "unknown"].includes(other.state) ||
            (other.state === "evaluating" && !this.canDiscard(other, scope)))
      )
    )
      return false
    try {
      return this.deps.runner.isSettled(
        { ...scope, workspace: row.workspace, threadId: row.threadId },
        row.evaluationId
      )
    } catch {
      return false
    }
  }
  list(scope: EvaluationScope) {
    scope = { ...scope }
    this.guard(scope)
    const candidates = this.deps
      .candidates()
      .filter(
        (row) =>
          row.status === "pending" &&
          typeof row.name === "string" &&
          row.name.length <= 200 &&
          typeof row.candidateId === "string" &&
          row.candidateId.length <= 200 &&
          typeof row.skillId === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(row.skillId)
      )
      .slice(0, 100)
      .map((row) => ({
        candidateId: row.candidateId,
        skillId: row.skillId,
        name: row.name
      }))
    const records = this.read()
      .rows.filter((row) => row.workspace === scope.workspace && row.threadId === scope.threadId)
      .map((row) => this.view(row, scope))
    this.guard(scope)
    const capacity = {
      limit: 16,
      entries: this.read().rows.map((row) => ({
        id: row.id,
        digest: recordDigest(row),
        name: row.name,
        workspace: row.workspace,
        threadId: row.threadId,
        canDiscard: this.canDiscard(row, scope),
        canForgetHistory: this.canForgetHistory(row, scope),
        ...(row.recoveryDirectory ? { recoveryDirectory: row.recoveryDirectory } : {})
      }))
    }
    this.guard(scope)
    return { workspace: scope.workspace, candidates, records, capacity }
  }
  prepare(input: ApiInput<"prepare">, scope: EvaluationScope) {
    scope = { ...scope }
    const request = structuredClone(input)
    this.guard(scope)
    if (request.threadId !== scope.threadId || request.expectedWorkspace !== scope.workspace)
      throw Error("SKILL_EVALUATION_STALE")
    const candidate = structuredClone(
      this.deps
        .candidates()
        .find((row) => row.candidateId === request.candidateId && row.status === "pending")
    )
    if (!candidate) throw Error("SKILL_EVALUATION_STALE")
    const text = validateSkillText(candidate.proposedContent)
    const baseline = this.deps.files.read(candidate.skillId)
    if ((candidate.action === "create") !== (baseline === null))
      throw Error("SKILL_EVALUATION_STALE")
    const fixture = this.deps.flows.get(scope.workspace, request.fixture.id)
    if (
      !fixture ||
      fixture.revision !== request.fixture.revision ||
      fixture.digest !== request.fixture.digest
    )
      throw Error("SKILL_EVALUATION_STALE")
    const row: Record = {
      schemaVersion: 1,
      id: randomUUID(),
      revision: 1,
      workspace: scope.workspace,
      threadId: scope.threadId,
      candidateId: candidate.candidateId,
      skillId: candidate.skillId,
      name: candidate.name,
      baseline,
      candidate: text,
      baselineDigest: skillTextDigest(baseline),
      candidateDigest: skillTextDigest(text),
      sourceTraceIds: [...candidate.sourceTraceIds],
      fixture: structuredClone(fixture),
      agentStepId: request.agentStepId,
      pair: {
        baseline: injectSkillSnapshot(fixture, request.agentStepId, baseline),
        candidate: injectSkillSnapshot(fixture, request.agentStepId, text)
      },
      state: "prepared"
    }
    this.guard(scope)
    this.save(row)
    return this.view(row, scope)
  }
  async start(input: ApiInput<"start">, scope: EvaluationScope) {
    scope = { ...scope }
    const request = structuredClone(input)
    this.guard(scope)
    if (request.threadId !== scope.threadId || request.expectedWorkspace !== scope.workspace)
      throw Error("SKILL_EVALUATION_STALE")
    const row = this.row(scope, request.id, request.expectedDigest)
    if (row.state !== "prepared") throw Error("SKILL_EVALUATION_STALE")
    const original = recordDigest(row)
    row.state = "evaluating"
    row.revision++
    this.save(row, original)
    const reference = (saved: SavedFlow) => ({
      id: saved.definition.id,
      revision: saved.revision,
      digest: saved.digest
    })
    try {
      const result = await this.deps.runner.startSnapshots(
        {
          threadId: scope.threadId,
          expectedWorkspace: scope.workspace,
          baseline: reference(row.pair.baseline),
          candidate: reference(row.pair.candidate),
          tasks: request.tasks,
          budget: request.budget
        },
        scope,
        row.pair,
        { baseline: row.fixture, candidate: row.fixture }
      )
      const before = recordDigest(row)
      row.evaluationId = result.id
      row.revision++
      this.save(row, before)
      this.guard(scope)
      return this.view(row, scope)
    } catch (error) {
      if (error instanceof EvaluationNotStarted && !row.evaluationId) {
        const before = recordDigest(row)
        row.state = "prepared"
        row.revision++
        this.save(row, before)
      }
      // All other failures may have created a run; retain the marker and never replay.
      if (row.evaluationId)
        await this.deps.runner.cancel(scope, row.evaluationId).catch(() => undefined)
      throw error
    }
  }
  async wait(scope: EvaluationScope, id: string) {
    const row = this.row(scope, id)
    if (row.evaluationId)
      await this.deps.runner.wait(scope.workspace, scope.threadId, row.evaluationId)
  }
  async change(input: ApiInput<"change">, scope: EvaluationScope) {
    scope = { ...scope }
    const request = structuredClone(input)
    this.guard(scope)
    if (request.threadId !== scope.threadId || request.expectedWorkspace !== scope.workspace)
      throw Error("SKILL_EVALUATION_STALE")
    if (request.action === "discard" || request.action === "forget-history") {
      // Explicit account-local management: the current trusted scope remains fenced, while
      // exact ID/digest selects a visible global quota entry, including a deleted chat.
      const { raw, rows } = this.read()
      const target = rows.find((row) => row.id === request.id)
      if (!target || recordDigest(target) !== request.expectedDigest)
        throw Error("SKILL_EVALUATION_STALE")
      if (request.action === "forget-history") {
        if (request.acknowledgeRecoveryLoss !== true) throw Error("SKILL_EVALUATION_INVALID")
        if (!this.canForgetHistory(target, scope)) throw Error("SKILL_EVALUATION_BUSY")
      } else if (!this.canDiscard(target, scope)) throw Error("SKILL_EVALUATION_BUSY")
      const receipt = this.view(target, {
        ...scope,
        workspace: target.workspace,
        threadId: target.threadId
      })
      this.guard(scope)
      if (
        !this.deps.settings.compareAndSetSetting?.(
          KEY,
          raw,
          JSON.stringify(rows.filter((row) => row.id !== target.id))
        )
      )
        throw Error("SKILL_EVALUATION_STALE")
      if (target.evaluationId) {
        const reportScope = { ...scope, workspace: target.workspace, threadId: target.threadId }
        const report = this.deps.runner
          .list(reportScope)
          .find((row) => row.id === target.evaluationId)
        if (report?.discardDigest)
          this.deps.runner.discard(reportScope, report.id, report.discardDigest)
      }
      this.deps.changed()
      return { ...receipt, state: "discarded" as const }
    }
    let row = this.row(scope, request.id, request.expectedDigest)
    if (request.action === "cancel") {
      if (row.evaluationId) await this.deps.runner.cancel(scope, row.evaluationId)
      this.guard(scope)
      return this.view(row, scope)
    }
    if (
      this.active.has(row.skillId) ||
      this.read().rows.some(
        (other) =>
          other.skillId === row.skillId &&
          ["adopting", "rolling-back", "unknown"].includes(other.state)
      )
    )
      throw Error("SKILL_EVALUATION_BUSY")
    if (request.action === "adopt") {
      const result = this.view(row, scope).evaluation
      if (
        row.state !== "evaluating" ||
        !result ||
        result.state !== "complete" ||
        !result.comparison.comparable ||
        result.candidate.cases.length !== result.tasks.length ||
        result.candidate.cases.some((value) => value.result !== "passed")
      )
        throw Error("SKILL_EVALUATION_INVALID")
    } else if (row.state !== "adopted") throw Error("SKILL_EVALUATION_INVALID")
    this.active.add(row.skillId)
    let intent = false
    try {
      const rollback = request.action === "rollback"
      const recoveryDirectory = await this.deps.files.replace({
        skillId: row.skillId,
        expected: rollback ? row.candidate : row.baseline,
        next: rollback ? row.baseline : row.candidate,
        scope,
        beforeEffect: (directory) => {
          this.guard(scope)
          const prior = recordDigest(row)
          row = {
            ...row,
            revision: row.revision + 1,
            state: rollback ? "rolling-back" : "adopting",
            recoveryDirectory: directory
          }
          this.save(row, prior)
          intent = true
        }
      })
      const prior = recordDigest(row)
      row = {
        ...row,
        revision: row.revision + 1,
        state: rollback ? "rolled-back" : "adopted",
        recoveryDirectory
      }
      this.save(row, prior)
      this.deps.changed()
      this.guard(scope)
      return this.view(row, scope)
    } catch (error) {
      if (intent && ["adopting", "rolling-back"].includes(row.state)) {
        const prior = recordDigest(row)
        row = { ...row, revision: row.revision + 1, state: "unknown" }
        this.save(row, prior)
        this.deps.changed()
      }
      throw error
    } finally {
      this.active.delete(row.skillId)
    }
  }
}
