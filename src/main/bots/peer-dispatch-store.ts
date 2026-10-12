import { peerAdmissionFingerprint, type BotPeerAdmissionPlan } from "./peer-dispatch-admission"
import { z } from "zod"
import { BotDomainError, type BotRun } from "../../shared/bot-types"
import { type BotPeerDispatch, type BotPeerDispatchOptions } from "../../shared/bot-peer-dispatch"
import type { BotStore } from "./store"

const metadata = z.object({
  intent: z.enum(["request", "reply", "question", "status", "result", "fyi"]),
  priority: z.union([z.literal(0), z.literal(1)]),
  reply_to_run_id: z.string().nullable(),
  activation_scope_run_id: z.string().nullable(),
  manual_response_sent: z.union([z.literal(0), z.literal(1)]),
  automatic: z.union([z.literal(0), z.literal(1)])
})
const scopeRow = z.object({
  id: z.string().min(1).max(160),
  bot_id: z.string().min(1).max(160),
  status: z.enum([
    "queued",
    "running",
    "waiting_input",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "needs_review"
  ]),
  revision: z.number().int().positive()
})
export interface BotPeerRoute {
  intent: BotPeerDispatch["intent"]
  requester: BotRun | null
  originalRequest: BotRun | null
  conversationId: string
  threadRootId?: string
  activationScopeRunId: string | null
}

/** Association for the existing bot_runs queue, never a second executor or queue. */
export class BotPeerDispatchStore {
  constructor(private readonly store: BotStore) {}
  forMessage(messageId: string): BotPeerDispatch["intent"] | undefined {
    const row = this.store.db.exec(
      "SELECT d.intent FROM bot_peer_dispatch d JOIN bot_runs r ON r.id=d.run_id WHERE r.message_id=? LIMIT 1",
      [messageId]
    )[0]?.values[0]?.[0]
    if (typeof row === "string") return metadata.shape.intent.parse(row)
    const event = this.store.db.exec(
      "SELECT payload FROM bot_events WHERE entity_id=? AND kind='peer.message' ORDER BY cursor DESC LIMIT 1",
      [messageId]
    )[0]?.values[0]?.[0]
    if (typeof event !== "string") return undefined
    return metadata.shape.intent.parse(JSON.parse(event).intent)
  }
  awaiting(route: BotPeerRoute): BotRun | null {
    if (
      !route.requester ||
      !route.originalRequest ||
      route.requester.status !== "waiting_input" ||
      route.requester.conversationId !== route.conversationId
    )
      return null
    const row = this.store.db.exec("SELECT child_run_id FROM bot_peer_waits WHERE run_id=?", [
      route.requester.id
    ])[0]?.values[0]?.[0]
    return row === route.originalRequest.id ? route.requester : null
  }
  markManual(route: BotPeerRoute, senderId: string): void {
    if (route.originalRequest?.id !== senderId || !["reply", "result"].includes(route.intent))
      return
    const existing = this.read(senderId)
    if (!existing)
      this.store.db.run("INSERT INTO bot_peer_dispatch VALUES(?,?,?,?,?,?,?)", [
        senderId,
        "request",
        0,
        null,
        null,
        1,
        0
      ])
    else
      this.store.db.run("UPDATE bot_peer_dispatch SET manual_response_sent=1 WHERE run_id=?", [
        senderId
      ])
  }
  read(runId: string): BotPeerDispatch | null {
    const raw = this.store.db.exec(
      "SELECT intent,priority,reply_to_run_id,activation_scope_run_id,manual_response_sent,automatic FROM bot_peer_dispatch WHERE run_id=?",
      [runId]
    )[0]
    if (!raw?.values.length) return null
    const row = metadata.parse(
      Object.fromEntries(raw.columns.map((key, i) => [key, raw.values[0][i]]))
    )
    return {
      intent: row.intent,
      priority: row.priority === 1,
      replyToRunId: row.reply_to_run_id,
      activationScopeRunId: row.activation_scope_run_id,
      manualResponseSent: row.manual_response_sent === 1,
      automatic: row.automatic === 1
    }
  }

  resolve(sender: BotRun, recipient: string, options: BotPeerDispatchOptions): BotPeerRoute {
    if (recipient === sender.botId)
      throw new BotDomainError("invalid_recipient", "不能向自己发送协作消息")
    const seen = new Set<string>([sender.id])
    let child = sender,
      requester: BotRun | null = null,
      originalRequest: BotRun | null = null
    while (child.parentRunId) {
      if (seen.has(child.parentRunId) || seen.size > 8)
        throw new BotDomainError("collaboration_cycle", "协作关联损坏，不能继续派发")
      seen.add(child.parentRunId)
      const ancestor = this.store.getRun(child.parentRunId)
      if (ancestor.rootRunId !== sender.rootRunId || ancestor.depth + 1 !== child.depth)
        throw new BotDomainError("collaboration_scope", "协作关联与原任务不一致")
      if (ancestor.botId === recipient) {
        requester = ancestor
        originalRequest = child
        break
      }
      child = ancestor
    }
    if (!requester && !options.reply_to_run_id) {
      // Peer updates accepted into this exact turn retain their real sender.
      // This bounded indexed inbox is not the Bot's whole private history.
      const inbound = this.store.db.exec(
        `SELECT m.run_id FROM bot_steering s
        JOIN bot_messages m ON m.id=s.message_id
        WHERE s.run_id=? AND s.accepted_at IS NOT NULL AND s.followup_run_id IS NULL
        AND m.sender='bot' AND m.bot_id=? ORDER BY m.sequence DESC LIMIT 1`,
        [sender.id, recipient]
      )[0]?.values[0]?.[0]
      if (typeof inbound === "string") {
        const source = this.store.getRun(inbound)
        if (source.rootRunId !== sender.rootRunId || source.botId !== recipient)
          throw new BotDomainError("peer_reply_scope", "已接收消息与原协作关联不一致")
        requester = source
      }
    }
    if (options.reply_to_run_id) {
      const received = this.store.getRun(options.reply_to_run_id)
      // A historical reference must be a real received trigger visible to this
      // exact task, not a run ID or private message from another branch.
      const visible = this.store
        .messagesForRun(sender.id)
        .some((message) => message.id === received.messageId)
      if (
        received.botId !== sender.botId ||
        received.source !== "peer" ||
        !received.parentRunId ||
        !visible
      )
        throw new BotDomainError("peer_reply_scope", "只能回复当前任务可见的原协作请求")
      const source = this.store.getRun(received.parentRunId)
      if (source.botId !== recipient || (requester && requester.id !== source.id))
        throw new BotDomainError("peer_reply_scope", "回复对象与原请求者不一致")
      requester = source
      originalRequest = received
    }
    if (requester && options.intent === "request")
      throw new BotDomainError("collaboration_cycle", "上级消息应作为回复或补充，不能再次循环委派")
    if (!requester && ["status", "result"].includes(options.intent ?? ""))
      throw new BotDomainError("peer_reply_scope", "进展或结果必须关联当前可见的原协作请求")
    if (requester && ["cancelled", "cancelling", "needs_review"].includes(requester.status))
      throw new BotDomainError("peer_reply_inactive", "原请求已停止或待核对，不能唤醒旧工作")
    const direct = this.store.directConversation(recipient)
    const directRequester =
      requester && this.store.getConversation(requester.conversationId).kind === "direct"
        ? requester
        : null
    const active =
      options.priority === true
        ? this.store.db.exec(
            "SELECT id FROM bot_runs WHERE bot_id=? AND status IN ('running','waiting_input','cancelling','needs_review') AND source<>'workflow-child' LIMIT 1",
            [recipient]
          )[0]?.values[0]?.[0]
        : null
    return {
      intent: options.intent ?? (requester ? "reply" : "request"),
      requester,
      originalRequest,
      conversationId: directRequester?.conversationId ?? direct.id,
      ...(directRequester?.threadRootId ? { threadRootId: directRequester.threadRootId } : {}),
      activationScopeRunId: requester?.id ?? (typeof active === "string" ? active : null)
    }
  }

  assertBudget(parent: BotRun): void {
    const count = this.store.db.exec("SELECT COUNT(*) FROM bot_runs WHERE root_run_id=?", [
      parent.rootRunId
    ])[0]?.values[0]?.[0]
    if (parent.depth >= 8 || Number(count) >= 64)
      throw new BotDomainError("collaboration_limit", "已达到本次工作的协作上限")
  }

  record(
    runId: string,
    route: BotPeerRoute,
    options: BotPeerDispatchOptions,
    automatic = false
  ): void {
    this.store.db.run("INSERT INTO bot_peer_dispatch VALUES(?,?,?,?,?,?,?)", [
      runId,
      route.intent,
      options.priority === true ? 1 : 0,
      route.requester?.id ?? null,
      route.activationScopeRunId,
      0,
      automatic ? 1 : 0
    ])
    this.markManual(route, this.store.getRun(runId).parentRunId!)
  }

  requiresAdmission(runId: string): boolean {
    const info = this.read(runId)
    return Boolean(info && (info.priority || info.replyToRunId || info.automatic))
  }

  admissionPlan(runId: string): BotPeerAdmissionPlan | null {
    const info = this.read(runId),
      run = this.store.getRun(runId)
    if (!info || run.status !== "queued" || !this.requiresAdmission(runId)) return null
    const scopeId = info.activationScopeRunId
    const target = scopeId ? this.store.getRun(scopeId) : null
    const query = target
      ? this.store.db.exec(
          `WITH RECURSIVE owned(id) AS (
      SELECT ? UNION SELECT child.id FROM owned CROSS JOIN bot_runs child INDEXED BY bot_run_owned_children
      WHERE child.root_run_id=? AND child.parent_run_id=owned.id LIMIT 65
    ) SELECT r.id,r.bot_id,r.status,r.revision FROM owned CROSS JOIN bot_runs r ON r.id=owned.id
      WHERE r.id<>? ORDER BY r.id LIMIT 65`,
          [target.id, target.rootRunId, runId]
        )[0]
      : undefined
    const rows =
      query?.values.map((value) =>
        scopeRow.parse(Object.fromEntries(query.columns.map((key, i) => [key, value[i]])))
      ) ?? []
    const scope = rows.filter(
      (row) => (info.priority && !info.replyToRunId) || row.bot_id === run.botId
    )
    // Ordinary replies do not cancel the collaborator's unrelated active work.
    // A priority replacement includes the original cancellation subtree.
    const ids = scope.map((row) => String(row.id))
    const effects = ids.length
      ? (this.store.db.exec(
          `SELECT run_id,status,COUNT(*) AS n,MAX(updated_at) AS updated FROM bot_effects
      WHERE run_id IN (${ids.map(() => "?").join(",")}) GROUP BY run_id,status ORDER BY run_id,status`,
          ids
        )[0]?.values ?? [])
      : []
    const blocked =
      rows.length > 64 ||
      scope.some((row) =>
        ["running", "waiting_input", "cancelling", "needs_review"].includes(String(row.status))
      ) ||
      effects.some((row) => ["started", "unknown"].includes(String(row[1])))
    const coexist =
      this.store.db.exec(
        `SELECT DISTINCT j.run_id FROM bot_shell_services s JOIN bot_shell_jobs j ON j.id=s.job_id
      JOIN bot_runs r ON r.id=j.run_id JOIN bot_effects e ON e.id=j.effect_id
      WHERE r.bot_id=? AND j.status='running' AND e.status='started' AND s.lease_until>? AND s.expires_at>? ORDER BY j.run_id LIMIT 65`,
        [run.botId, this.store.now(), this.store.now()]
      )[0]?.values ?? []
    const coexistingRunIds = coexist.map((row) => String(row[0]))
    const dataEpoch = this.store.backupSchedule.epoch(),
      revision = this.store.getBot(run.botId).revision
    return {
      runId,
      botId: run.botId,
      revision: run.revision,
      dataEpoch,
      scopeRunIds: ids,
      coexistingRunIds,
      blocked: blocked || coexistingRunIds.length > 64,
      fingerprint: peerAdmissionFingerprint({
        runId,
        runRevision: run.revision,
        botId: run.botId,
        revision,
        dataEpoch,
        info,
        scope,
        effects,
        coexistingRunIds
      })
    }
  }

  expectsResponse(runId: string): boolean {
    const info = this.read(runId)
    return !info || (!info.manualResponseSent && ["request", "question"].includes(info.intent))
  }
}
