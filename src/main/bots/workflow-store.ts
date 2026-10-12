import { createHash } from "node:crypto"
import { z } from "zod"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import { createWorkflowRunState } from "../agent/workflow/run-state"
import { validateWorkflowScript } from "../agent/workflow/script"
import type { WorkflowEngineStore } from "../agent/workflow/engine"
import type { PersistedWorkflowRun } from "../agent/workflow/types"
import {
  workflowAgent,
  workflowJournal,
  workflowStart,
  workflowState,
  workflowEncode,
  type WorkflowProcessInput
} from "./workflow-contract"
import { canonicalJson } from "./validation"
import type { BotStore } from "./store"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const journalFreeState = workflowState.omit({ journal: true })
export type BotWorkflowDefinition = Omit<WorkflowProcessInput, "state"> & {
  script: string
  args?: unknown
  /** Host-resolved project identity and capability snapshot; never model input. */
  authority: unknown
  /** Host-only compatibility with the previous full-snapshot authority digest.
   * Excluded from new fingerprints; never accepted from workflow tool arguments. */
  legacyAuthority?: unknown
}

export function botWorkflowDefinitionFingerprint(definition: BotWorkflowDefinition): string {
  const current = { ...definition }
  delete current.legacyAuthority
  return digest(canonicalJson(JSON.parse(workflowEncode(current))))
}

export function botWorkflowDefinitionMatchesFingerprint(
  definition: BotWorkflowDefinition,
  fingerprint: unknown
): boolean {
  return (
    fingerprint === botWorkflowDefinitionFingerprint(definition) ||
    (definition.legacyAuthority !== undefined &&
      fingerprint ===
        botWorkflowDefinitionFingerprint({
          ...definition,
          authority: definition.legacyAuthority
        }))
  )
}

/** The same engine state mutations with Bot's leased SQLite durability. Journal
 * entries are separate rows; an agent completion never rewrites the whole journal.
 * Backup/restore already snapshots this database in the Host's maintenance mode. */
export class BotWorkflowStore implements WorkflowEngineStore {
  readonly input: WorkflowProcessInput
  private readonly memory: ReturnType<typeof createWorkflowRunState>
  private poisoned = false
  private revision: number

  private constructor(
    private readonly store: BotStore,
    private readonly lease: BotRunLease,
    readonly id: string,
    private readonly generation: number,
    revision: number,
    input: WorkflowProcessInput
  ) {
    this.input = input
    this.memory = createWorkflowRunState(input.state)
    this.revision = revision
  }

  static open(
    store: BotStore,
    lease: BotRunLease,
    invocation: string,
    definition: BotWorkflowDefinition
  ): BotWorkflowStore {
    z.string().min(1).max(512).parse(invocation)
    const parsed = validateWorkflowScript(definition.script)
    const fingerprint = botWorkflowDefinitionFingerprint(definition)
    const id = `wf_${digest(canonicalJson([lease.runId, invocation])).slice(0, 32)}`
    return store.transaction(() => {
      store.assertDispatch(lease)
      const row = store.db.exec(
        "SELECT fingerprint,generation,revision,state FROM bot_workflows WHERE id=? AND run_id=?",
        [id, lease.runId]
      )[0]?.values[0]
      let state: PersistedWorkflowRun
      let generation = 1,
        revision = 0
      if (row) {
        if (!botWorkflowDefinitionMatchesFingerprint(definition, row[0]))
          throw new BotDomainError(
            "workflow_input_changed",
            "工作流脚本、输入或授权配置已变化，不能重放原调用"
          )
        generation = z.number().int().parse(row[1]) + 1
        revision = z.number().int().parse(row[2])
        const saved = journalFreeState.parse(JSON.parse(z.string().parse(row[3])))
        const journal = (
          store.db.exec(
            "SELECT payload FROM bot_workflow_journal WHERE workflow_id=? ORDER BY call_index,rowid",
            [id]
          )[0]?.values ?? []
        ).map(([payload]) => workflowJournal.parse(JSON.parse(z.string().parse(payload))))
        state = { ...saved, journal, resumed: true }
      } else {
        const count = Number(
          store.db.exec("SELECT COUNT(*) FROM bot_workflows WHERE run_id=?", [lease.runId])[0]
            ?.values[0]?.[0] ?? 0
        )
        if (count >= 32) throw new BotDomainError("workflow_limit", "当前任务的工作流数量已达上限")
        const now = new Date(store.now()).toISOString()
        state = {
          version: 1,
          runId: id,
          threadId: lease.runId,
          workflowName: parsed.meta.name,
          description: parsed.meta.description,
          script: definition.script,
          scriptSha256: digest(definition.script),
          args: definition.args,
          status: "running",
          phases: [],
          currentPhase: null,
          agents: [],
          logs: [],
          journal: [],
          stats: {
            agentsTotal: 0,
            agentsCached: 0,
            agentsFailed: 0,
            outputTokens: 0,
            durationMs: 0
          },
          startedAt: now,
          updatedAt: now
        }
      }
      const input = workflowStart.parse({
        state,
        tokenBudget: definition.tokenBudget,
        maxConcurrency: definition.maxConcurrency,
        defaultModelId: definition.defaultModelId,
        agentProfiles: definition.agentProfiles
      })
      workflowEncode(input) // Reject excessive persisted replay before changing ownership.
      const metadata = journalFreeState.strip().parse(state)
      store.db.run(
        `INSERT INTO bot_workflows(id,run_id,invocation,fingerprint,generation,revision,state,result,updated_at)
        VALUES(?,?,?,?,?,?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,fingerprint=excluded.fingerprint`,
        [
          id,
          lease.runId,
          invocation,
          fingerprint,
          generation,
          revision,
          JSON.stringify(metadata),
          store.now()
        ]
      )
      store.db.run("INSERT OR IGNORE INTO bot_workflow_limits VALUES(?,?)", [
        id,
        Math.min(definition.tokenBudget ?? 200_000, 200_000)
      ])
      return new BotWorkflowStore(store, lease, id, generation, revision, input)
    })
  }

  get state(): PersistedWorkflowRun {
    return this.memory.state
  }

  assertOwner(lease: BotRunLease): void {
    if (
      lease.runId !== this.lease.runId ||
      lease.owner !== this.lease.owner ||
      lease.fence !== this.lease.fence
    )
      throw new BotDomainError("workflow_scope", "工作流不属于当前任务执行权")
    this.check()
  }

  private check(): void {
    if (this.poisoned)
      throw new BotDomainError("workflow_storage_failed", "工作流保存失败，需重新读取持久记录")
    this.store.assertLease(this.lease, true)
    const generation = this.store.db.exec(
      "SELECT generation FROM bot_workflows WHERE id=? AND run_id=?",
      [this.id, this.lease.runId]
    )[0]?.values[0]?.[0]
    if (generation !== this.generation)
      throw new BotDomainError("workflow_stale_writer", "工作流执行权已被新的执行接替")
  }

  private commit(operation: () => void): void {
    try {
      this.store.transaction(() => {
        this.check()
        operation()
      })
    } catch (error) {
      this.poisoned = true
      throw error
    }
  }

  private metadata(): string {
    if (this.state.worktrees?.length)
      throw new BotDomainError(
        "workflow_worktrees_unavailable",
        "独立工作区记录需由 Bot 子任务管理"
      )
    const serialized = JSON.stringify(journalFreeState.strip().parse(this.state))
    if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024)
      throw new BotDomainError("workflow_storage_limit", "工作流状态超出保存上限")
    return serialized
  }

  update(mutator: (state: PersistedWorkflowRun) => void): void {
    this.commit(() => {
      this.memory.update(mutator)
      this.state.updatedAt = new Date(this.store.now()).toISOString()
      this.store.db.run(
        "UPDATE bot_workflows SET state=?,revision=revision+1,updated_at=? WHERE id=?",
        [this.metadata(), this.store.now(), this.id]
      )
      this.revision++
    })
  }

  appendJournal(input: Parameters<WorkflowEngineStore["appendJournal"]>[0]): void {
    const entry = workflowJournal.parse(input)
    const payload = JSON.stringify(entry)
    if (Buffer.byteLength(payload, "utf8") > 512 * 1024)
      throw new BotDomainError("workflow_storage_limit", "子任务恢复记录超出上限")
    this.commit(() => {
      const count = Number(
        this.store.db.exec("SELECT COUNT(*) FROM bot_workflow_journal WHERE workflow_id=?", [
          this.id
        ])[0]?.values[0]?.[0] ?? 0
      )
      const present = this.store.db.exec(
        "SELECT 1 FROM bot_workflow_journal WHERE workflow_id=? AND call_index=? AND hash=?",
        [this.id, entry.index, entry.hash]
      )[0]?.values.length
      if (!present && count >= 10_000)
        throw new BotDomainError("workflow_storage_limit", "工作流恢复记录数量已达上限")
      const totalBytes = Number(
        this.store.db.exec(
          "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM bot_workflow_journal WHERE workflow_id=? AND NOT(call_index=? AND hash=?)",
          [this.id, entry.index, entry.hash]
        )[0]?.values[0]?.[0] ?? 0
      )
      if (totalBytes + Buffer.byteLength(payload, "utf8") > 24 * 1024 * 1024)
        throw new BotDomainError("workflow_storage_limit", "工作流恢复记录总量超出上限")
      this.store.db.run(
        `INSERT INTO bot_workflow_journal VALUES(?,?,?,?)
        ON CONFLICT(workflow_id,call_index,hash) DO UPDATE SET payload=excluded.payload`,
        [this.id, entry.index, entry.hash, payload]
      )
      this.memory.appendJournal(entry)
    })
  }

  upsertAgent(input: Parameters<WorkflowEngineStore["upsertAgent"]>[0]): void {
    const record = workflowAgent.parse(input)
    this.update(() => {
      this.memory.upsertAgent(record)
    })
  }

  async persistFullResult(content: string | null): Promise<boolean> {
    if (content !== null && Buffer.byteLength(content, "utf8") > 8 * 1024 * 1024)
      throw new BotDomainError("workflow_storage_limit", "工作流完整输出超出上限")
    this.commit(() => {
      this.store.db.run(
        "UPDATE bot_workflows SET result=?,revision=revision+1,updated_at=? WHERE id=?",
        [content, this.store.now(), this.id]
      )
      this.revision++
    })
    return true
  }

  /** Freeze observed inputs for deterministic resume. Only Host adapters may
   * call this; the script cannot insert or choose a different receipt identity. */
  async observe<T>(invocation: string, input: unknown, operation: () => Promise<T>): Promise<T> {
    z.string().min(1).max(200).parse(invocation)
    this.check()
    const fingerprint = digest(canonicalJson(input))
    const cached = () =>
      this.store.db.exec(
        "SELECT fingerprint,payload FROM bot_workflow_io WHERE workflow_id=? AND invocation=?",
        [this.id, invocation]
      )[0]?.values[0]
    const decode = (row: unknown[]): T => {
      if (row[0] !== fingerprint)
        throw new BotDomainError("workflow_input_changed", "工作流文件调用身份已变化")
      return JSON.parse(z.string().parse(row[1])) as T
    }
    const previous = cached()
    if (previous) return decode(previous)
    const value = await operation()
    const payload = workflowEncode(value)
    let result: T = value
    this.commit(() => {
      const raced = cached()
      if (raced) {
        result = decode(raced)
        return
      }
      const totals = this.store.db.exec(
        "SELECT COUNT(*), COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM bot_workflow_io WHERE workflow_id=?",
        [this.id]
      )[0].values[0]
      if (
        Number(totals[0]) >= 10_000 ||
        Number(totals[1]) + Buffer.byteLength(payload, "utf8") > 16 * 1024 * 1024
      )
        throw new BotDomainError("workflow_storage_limit", "工作流文件观察记录已达上限")
      this.store.db.run("INSERT INTO bot_workflow_io VALUES(?,?,?,?)", [
        this.id,
        invocation,
        fingerprint,
        payload
      ])
    })
    return result
  }

  async flush(): Promise<boolean> {
    // All mutations already committed with synchronous=FULL. Verify the current
    // incarnation rather than treating an old row's existence as successful IO.
    this.check()
    const saved = this.store.db.exec("SELECT revision FROM bot_workflows WHERE id=?", [this.id])[0]
      ?.values[0]?.[0]
    if (saved !== this.revision)
      throw new BotDomainError("workflow_stale_writer", "工作流保存版本不匹配")
    return true
  }
}
