import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { getDb, getThreadCore } from "../../db"
import type { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
import type { ModGrant } from "../control-store"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type {
  AgentTaskStatus,
  AgentTaskMessages,
  AgentViewIntent
} from "../../../shared/mods/v2/agent-tasks"
import type { FunctionTurnComplete } from "../../../shared/mods/v2/turn"
import { readColdFunctionSessionPage } from "./session-cold-read"
import { registerOwnedAgentCancellation } from "../../db/owned-agent-cleanup"

interface RecordData extends AgentTaskStatus {
  parent: string
  parentIncarnation: string
  child: string
  childIncarnation: string
  source: string
  digest: string
  epoch: number
  runId: string
}
function incarnation(id: string): string {
  const row = getThreadCore(id)
  if (!row) throw new ModFunctionError("MODS_AGENT_OWNER_CHANGED")
  return JSON.stringify(captureThreadIncarnation(row))
}
function rows(db: NativeSqliteAdapter, sql: string, params: unknown[]) {
  const statement = db.prepare(sql)
  try {
    statement.bind(params)
    const result: Record<string, unknown>[] = []
    while (statement.step()) result.push(statement.getAsObject())
    return result
  } finally {
    statement.free()
  }
}
/** Trusted ownership is stored separately from renderer-editable thread metadata. */
export class OwnedAgentTasks {
  private readonly cursorKey = randomBytes(32)
  private live = new Map<
    string,
    { controller: AbortController; db: NativeSqliteAdapter; epoch: number }
  >()
  private initialized = new WeakSet<NativeSqliteAdapter>()
  private views = new Map<
    string,
    {
      value: AgentViewIntent
      grant: ModGrant
      db: NativeSqliteAdapter
      expires: number
      claimed: boolean
      sourceCurrent(): void
      retainedGrant?: () => void
    }
  >()
  private database() {
    const db = getDb()
    if (!this.initialized.has(db)) {
      db.run(
        "CREATE TABLE IF NOT EXISTS mods_owned_agents (agent_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, child_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL)"
      )
      db.run("CREATE INDEX IF NOT EXISTS mods_owned_agents_parent ON mods_owned_agents(parent_id)")
      this.initialized.add(db)
    }
    return db
  }
  private write(record: RecordData, db = this.database()) {
    if (getDb() !== db) throw new ModFunctionError("MODS_AGENT_OWNER_CHANGED")
    db.run(
      "INSERT INTO mods_owned_agents VALUES (?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET data=excluded.data",
      [record.agentId, record.parent, record.child, JSON.stringify(record)]
    )
  }
  assertCapacity(parent: string) {
    if (
      rows(this.database(), "SELECT agent_id FROM mods_owned_agents WHERE parent_id=?", [parent])
        .length >= 100
    )
      throw new ModFunctionError("MODS_AGENT_HISTORY_LIMIT")
  }
  start(
    input: AgentTaskStatus & { parent: string; child: string; runId: string },
    grant: ModGrant,
    controller: AbortController
  ) {
    const db = this.database()
    this.assertCapacity(input.parent)
    const record: RecordData = {
      ...input,
      parentIncarnation: incarnation(input.parent),
      childIncarnation: incarnation(input.child),
      source: grant.modId,
      digest: grant.digest,
      epoch: grant.epoch
    }
    this.write(record, db)
    this.live.set(record.agentId, { controller, db, epoch: grant.epoch })
    const releaseCancellation = registerOwnedAgentCancellation(db, record.child, controller)
    return (outcome?: FunctionTurnComplete) => {
      releaseCancellation()
      this.live.delete(record.agentId)
      if (
        getDb() !== db ||
        !getThreadCore(record.parent) ||
        incarnation(record.parent) !== record.parentIncarnation
      )
        return
      record.finishedAt = Date.now()
      record.status =
        !outcome || outcome.reason === "aborted"
          ? "unknown"
          : outcome.reason === "answer"
            ? "completed"
            : "failed"
      if (outcome)
        record.outcome = {
          answer: outcome.answer,
          reason: outcome.reason,
          durationMs: outcome.durationMs,
          isAborted: outcome.isAborted
        }
      if (record.status === "unknown")
        record.diagnostic = "执行已停止或清理未确认，请核对实际结果；不会自动重跑。"
      this.write(record, db)
    }
  }
  private owned(parent: string, workspace: string, grant: ModGrant, id: string): RecordData {
    const record = rows(this.database(), "SELECT data FROM mods_owned_agents WHERE agent_id=?", [
      id
    ])[0]
    if (!record) throw new ModFunctionError("MODS_AGENT_TASK_NOT_FOUND")
    const value = JSON.parse(String(record.data)) as RecordData
    if (
      value.parent !== parent ||
      value.scope.workspace !== workspace ||
      value.source !== grant.modId ||
      value.digest !== grant.digest ||
      value.parentIncarnation !== incarnation(parent) ||
      value.childIncarnation !== incarnation(value.child)
    )
      throw new ModFunctionError("MODS_AGENT_OWNER_CHANGED")
    if (["running", "stopping"].includes(value.status) && this.live.get(id)?.db !== getDb()) {
      value.status = "unknown"
      value.diagnostic = "没有当前运行实例；保留历史记录，不自动重新执行。"
      this.write(value)
    }
    return value
  }
  status(parent: string, workspace: string, grant: ModGrant, id: string): AgentTaskStatus {
    const value = this.owned(parent, workspace, grant, id)
    return {
      agentId: value.agentId,
      status: value.status,
      model: value.model,
      description: value.description,
      startedAt: value.startedAt,
      scope: value.scope,
      ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
      ...(value.outcome ? { outcome: value.outcome } : {}),
      ...(value.diagnostic ? { diagnostic: value.diagnostic } : {})
    }
  }
  stop(parent: string, workspace: string, grant: ModGrant, id: string) {
    const record = this.owned(parent, workspace, grant, id)
    const running = this.live.get(id)
    if (!running || !["running", "stopping"].includes(record.status))
      return { agentId: id, stopRequested: false, status: record.status }
    if (running.epoch !== grant.epoch) throw new ModFunctionError("MODS_AGENT_OWNER_CHANGED")
    record.status = "stopping"
    this.write(record)
    running.controller.abort(new Error("MODS_AGENT_STOP_REQUESTED"))
    return { agentId: id, stopRequested: true, status: record.status }
  }
  async messages(
    parent: string,
    workspace: string,
    grant: ModGrant,
    id: string,
    signal: AbortSignal,
    cursor?: string,
    limit = 50
  ): Promise<AgentTaskMessages> {
    const record = this.owned(parent, workspace, grant, id)
    const db = getDb()
    const owner = JSON.stringify([
      record.agentId,
      record.parentIncarnation,
      record.childIncarnation,
      record.source,
      record.digest
    ])
    let offset = 0,
      checkpointId: string | undefined
    if (cursor !== undefined) {
      const [data, mac, extra] = cursor.split(".")
      const expected = createHmac("sha256", this.cursorKey)
        .update(owner + data)
        .digest("base64url")
      if (!data || !mac || extra !== undefined || mac !== expected)
        throw new ModFunctionError("MODS_AGENT_CURSOR_CHANGED")
      const parsed: unknown = JSON.parse(Buffer.from(data, "base64url").toString("utf8"))
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== "string" ||
        !Number.isSafeInteger(parsed[1]) ||
        parsed[1] < 0
      )
        throw new ModFunctionError("MODS_AGENT_CURSOR_CHANGED")
      ;[checkpointId, offset] = parsed as [string, number]
    }
    const result = await readColdFunctionSessionPage(record.child, signal, {
      offset,
      limit,
      checkpointId
    })
    result.assertLive()
    if (getDb() !== db) throw new ModFunctionError("MODS_AGENT_OWNER_CHANGED")
    this.owned(parent, workspace, grant, id)
    const page = result.value
    let nextCursor: string | undefined
    if (page?.nextOffset !== undefined) {
      const data = Buffer.from(JSON.stringify([page.checkpointId, page.nextOffset])).toString(
        "base64url"
      )
      nextCursor = `${data}.${createHmac("sha256", this.cursorKey)
        .update(owner + data)
        .digest("base64url")}`
    }
    return {
      agentId: id,
      messages: page?.messages ?? [],
      ...(nextCursor ? { nextCursor } : {}),
      skippedMessages: page?.skippedMessages ?? 0,
      truncated: !!nextCursor || page?.partial === true,
      history: page ? "partial" : "unavailable"
    }
  }
  requestView(
    parent: string,
    workspace: string,
    grant: ModGrant,
    agentId: string,
    sourceCurrent: () => void,
    retainedGrant?: () => void
  ) {
    sourceCurrent()
    for (const [key, entry] of this.views) {
      if (entry.db !== getDb() || (!entry.claimed && Date.now() > entry.expires))
        this.views.delete(key)
    }
    if (!this.views.has(parent) && this.views.size >= 100)
      throw new ModFunctionError("MODS_RUNTIME_CAPACITY")
    if (agentId !== "main") this.owned(parent, workspace, grant, agentId)
    const value: AgentViewIntent = {
      id: randomUUID(),
      threadId: parent,
      workspace,
      agentId,
      parentIncarnation: incarnation(parent),
      sourceDigest: grant.digest
    }
    this.views.set(parent, {
      value,
      grant,
      db: getDb(),
      expires: Date.now() + 15_000,
      claimed: false,
      sourceCurrent,
      retainedGrant
    })
    return { requested: true, agentId, readOnly: true, inputTarget: "parent" }
  }
  view(parent: string, workspace: string, assertGrant: (grant: ModGrant) => void) {
    const entry = this.views.get(parent)
    if (!entry) return null
    if (entry.claimed) return null
    if (
      entry.db !== getDb() ||
      entry.value.workspace !== workspace ||
      entry.value.parentIncarnation !== incarnation(parent) ||
      Date.now() > entry.expires
    ) {
      this.views.delete(parent)
      return null
    }
    // Trial identities authorize one SDK call only. Native viewing retains the activation's
    // resource guard; it never renews that identity for another guest capability call.
    if (entry.retainedGrant) entry.retainedGrant()
    else assertGrant(entry.grant)
    entry.sourceCurrent()
    entry.claimed = true
    return entry.value
  }
  viewRead(
    parent: string,
    workspace: string,
    intentId: string,
    assertGrant: (grant: ModGrant) => void
  ) {
    const entry = this.views.get(parent)
    if (
      !entry ||
      !entry.claimed ||
      entry.value.id !== intentId ||
      entry.db !== getDb() ||
      entry.value.workspace !== workspace ||
      entry.value.parentIncarnation !== incarnation(parent)
    )
      throw new ModFunctionError("MODS_AGENT_VIEW_CHANGED")
    if (entry.retainedGrant) entry.retainedGrant()
    else assertGrant(entry.grant)
    entry.sourceCurrent()
    return entry
  }
  closeView(parent: string, id: string) {
    if (this.views.get(parent)?.value.id === id) this.views.delete(parent)
  }
  retireViews(parent?: string) {
    if (parent === undefined) this.views.clear()
    else this.views.delete(parent)
  }
}
