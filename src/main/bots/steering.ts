import { HumanMessage, type MessageContent } from "@langchain/core/messages"
import { z } from "zod"
import type { CurrentRunDurableQueue } from "../agent/current-run-message-queue"
import { BotDomainError, type BotRunLease, type BotSteeringState } from "../../shared/bot-types"
import type { NativeSqliteBindings } from "../db/native-sqlite-adapter"
import type { BotStore } from "./store"
import { prepareBotUserPrompt } from "./prompt-preparation"
import { buildBotMessageWakePrompt } from "./upstream/rakazo-bot-messages"
import { BOT_SESSION_END_KEY, BOT_STOP_FAILURE_KEY } from "./skill-hook-state"

export class BotSteeringInterrupt extends BotDomainError {
  constructor() {
    super(
      "new_instruction",
      "收到用户补充要求；本次尚未开始的操作未执行，请先处理新消息。已发出的协作任务仍保留。"
    )
  }
}

/** Durable inbox owned by a task. Acceptance never grants approval or changes
 * the original task's permissions. Call attach/settle inside the store transaction. */
export class BotSteering {
  constructor(
    private readonly store: BotStore,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}

  private rows(sql: string, values: NativeSqliteBindings = []): Record<string, unknown>[] {
    const query = this.store.db.prepare(sql, values)
    try {
      const rows: Record<string, unknown>[] = []
      while (query.step()) rows.push(query.getAsObject())
      return rows
    } finally {
      query.free()
    }
  }

  attach(
    runId: string,
    messageId: string,
    conversationId: string,
    botId: string,
    root?: string
  ): boolean {
    const run = this.store.getRun(runId)
    if (
      run.conversationId !== conversationId ||
      run.botId !== botId ||
      run.threadRootId !== root ||
      (!["user", "plugin-command"].includes(run.source) &&
        !(run.source === "skill-trial" && this.store.trialForRun(run.id)?.botId === run.botId)) ||
      this.store.getConversation(conversationId).kind !== "direct"
    )
      throw new BotDomainError("steering_scope", "只能向当前私聊或分支中的用户任务补充要求")
    if (run.source === "plugin-command") return false
    return this.enqueue(runId, messageId, conversationId)
  }

  /** Explicit task-panel input. It shares the durable queue, never the normal
   * send fallback which could start an unrelated parent task after completion. */
  attachChild(runId: string, messageId: string): boolean {
    const run = this.store.getRun(runId)
    if (run.source !== "workflow-child")
      throw new BotDomainError("steering_scope", "目标不是工作流子任务")
    this.store.workflowChildren.assertParent(runId)
    const message = this.store.message({ conversationId: run.conversationId, id: messageId })
    if (message.sender !== "user" || message.runId !== runId)
      throw new BotDomainError("steering_scope", "补充消息不属于当前子任务")
    return this.enqueue(runId, messageId, run.conversationId)
  }

  attachDelegatedChild(parentLease: BotRunLease, runId: string, messageId: string): boolean {
    const parent = this.store.assertDispatch(parentLease)
    const run = this.store.getRun(runId)
    const message = this.store.message({ conversationId: run.conversationId, id: messageId })
    if (
      run.source !== "workflow-child" ||
      run.parentRunId !== parent.id ||
      message.sender !== "bot" ||
      message.botId !== parent.botId ||
      message.runId !== runId
    )
      throw new BotDomainError("steering_scope", "补充要求不属于该子任务的主 Bot")
    this.store.workflowChildren.assertParent(runId)
    return this.enqueue(runId, messageId, run.conversationId)
  }

  /** A real descendant can update the original awaited request without
   * creating a parallel same-Bot turn or pretending to be the human. */
  attachPeer(
    senderLease: BotRunLease,
    targetId: string,
    messageId: string,
    awaitedChildId: string
  ): boolean {
    const sender = this.store.assertDispatch(senderLease),
      target = this.store.getRun(targetId)
    const message = this.store.message({
      conversationId: target.conversationId,
      id: messageId
    })
    const waiting = this.rows("SELECT child_run_id FROM bot_peer_waits WHERE run_id=?", [
      targetId
    ])[0]
    if (
      waiting?.child_run_id !== awaitedChildId ||
      message.sender !== "bot" ||
      message.botId !== sender.botId ||
      message.runId !== sender.id ||
      message.replyTo !== target.messageId ||
      message.threadRootId !== target.threadRootId ||
      target.status !== "waiting_input"
    )
      throw new BotDomainError("peer_wait_scope", "补充消息不属于该协作等待任务")
    const seen = new Set<string>(),
      expected = this.store.getRun(awaitedChildId)
    let run = sender
    while (run.id !== expected.id) {
      if (
        !run.parentRunId ||
        seen.has(run.id) ||
        seen.size >= 8 ||
        run.rootRunId !== expected.rootRunId
      )
        throw new BotDomainError("peer_wait_scope", "补充消息不属于原请求的执行分支")
      seen.add(run.id)
      run = this.store.getRun(run.parentRunId)
    }
    if (expected.parentRunId !== target.id)
      throw new BotDomainError("peer_wait_scope", "原请求者不一致")
    return this.enqueue(targetId, messageId, target.conversationId)
  }

  private enqueue(runId: string, messageId: string, conversationId: string): boolean {
    const run = this.store.getRun(runId)
    if (
      !["running", "waiting_input"].includes(run.status) ||
      (run.leaseUntil ?? 0) <= this.store.now()
    )
      return false
    // A terminal phase owns the frozen result or failure. Normal chat sends
    // become follow-up tasks; child-panel input is rejected by its existing
    // caller instead of silently modifying a result already being settled.
    if (
      this.rows("SELECT 1 FROM bot_receipts WHERE nonce IN (?,?) LIMIT 1", [
        `tool:${runId}:${BOT_SESSION_END_KEY}`,
        `tool:${runId}:${BOT_STOP_FAILURE_KEY}`
      ]).length
    )
      return false
    if (
      Number(this.rows("SELECT COUNT(*) AS n FROM bot_steering WHERE run_id=?", [runId])[0].n) >=
      100
    )
      return false
    this.store.db.run("INSERT INTO bot_steering VALUES(?,?,NULL,NULL)", [messageId, runId])
    this.event("run.instruction_queued", runId, { messageId, conversationId })
    return true
  }

  hasPending(runId: string): boolean {
    return (
      this.rows(
        "SELECT 1 FROM bot_steering WHERE run_id=? AND accepted_at IS NULL AND followup_run_id IS NULL LIMIT 1",
        [runId]
      ).length > 0
    )
  }

  /** Does not abort an already-started external action. Call at dispatch/wait boundaries only. */
  interruptIfPending(lease: BotRunLease): void {
    this.store.assertLease(lease, true)
    if (!this.hasPending(lease.runId)) return
    this.store.transaction(() => {
      this.store.assertLease(lease, true)
      this.store.db.run(
        "UPDATE bot_interactions SET status='cancelled',revision=revision+1 WHERE run_id=? AND status='pending'",
        [lease.runId]
      )
      this.store.hookNotifications.interrupt(lease.runId)
      this.store.db.run("DELETE FROM bot_peer_waits WHERE run_id=?", [lease.runId])
      this.store.db.run(
        "UPDATE bot_runs SET status='running',revision=revision+1,updated_at=? WHERE id=?",
        [this.store.now(), lease.runId]
      )
      this.event("run.instruction_boundary", lease.runId, {})
      this.event("run.computer_wait", lease.runId, { fence: lease.fence, waiting: false })
    })
    throw new BotSteeringInterrupt()
  }

  assertNoPending(runId: string): void {
    if (this.hasPending(runId)) throw new BotSteeringInterrupt()
  }

  state(messageId: string): BotSteeringState | undefined {
    const row = this.rows(
      "SELECT s.*,r.status FROM bot_steering s JOIN bot_runs r ON r.id=s.run_id WHERE s.message_id=?",
      [messageId]
    )[0]
    if (!row) return undefined
    return {
      runId: String(row.followup_run_id ?? row.run_id),
      state: row.followup_run_id
        ? "queued"
        : row.accepted_at !== null
          ? "accepted"
          : ["succeeded", "failed", "cancelled"].includes(String(row.status))
            ? "not_applied"
            : "pending"
    }
  }

  acceptedMessageIds(runId: string): string[] {
    return this.rows(
      "SELECT message_id FROM bot_steering WHERE run_id=? AND accepted_at IS NOT NULL ORDER BY rowid",
      [runId]
    ).map((row) => String(row.message_id))
  }

  /** A late arrival after the graph's final boundary remains real queued work.
   * Failure/cancel do not silently start another task. Recovery retains the inbox. */
  settle(runId: string, status: string, enqueue: (messageId: string) => string | null): void {
    if (status !== "succeeded") return
    for (const row of this.rows(
      "SELECT message_id FROM bot_steering WHERE run_id=? AND accepted_at IS NULL AND followup_run_id IS NULL ORDER BY rowid",
      [runId]
    )) {
      const id = String(row.message_id)
      const followup = enqueue(id)
      if (!followup) continue
      this.store.db.run("UPDATE bot_steering SET followup_run_id=? WHERE message_id=?", [
        followup,
        id
      ])
      this.event("run.instruction_deferred", runId, { messageId: id })
    }
  }

  queue(
    lease: BotRunLease,
    peerImages?: (
      message: import("../../shared/bot-types").BotMessage
    ) => Promise<MessageContent | undefined>
  ): CurrentRunDurableQueue {
    return {
      take: async ({ threadId, ownerRunToken, appliedIds }) => {
        if (threadId !== lease.runId || ownerRunToken !== `${lease.owner}:${lease.fence}`)
          throw new BotDomainError("steering_scope", "补充要求不属于当前执行进程")
        const run = this.store.assertLease(lease)
        const applied = new Set(appliedIds)
        const entries = this.rows(
          "SELECT message_id FROM bot_steering WHERE run_id=? AND followup_run_id IS NULL ORDER BY rowid",
          [run.id]
        ).filter((row) => !applied.has(String(row.message_id)))
        const messages: HumanMessage[] = []
        let size = 0
        let imageBytes = 0
        for (const entry of entries) {
          const id = String(entry.message_id)
          const message = this.store.message({ conversationId: run.conversationId, id })
          const content =
            message.sender === "bot"
              ? run.source === "workflow-child"
                ? `[Parent Bot instruction — not human authorization; approvals and role limits remain unchanged]\n${message.text}`
                : buildBotMessageWakePrompt({
                    from: this.store.getBot(message.botId!, true),
                    text: message.text,
                    intent: this.store.peerDispatch.forMessage(message.id)
                  })
              : await prepareBotUserPrompt({
                  store: this.store,
                  lease,
                  message
                })
          if (messages.length && size + content.length > 96_000) break
          const blocks =
            message.sender === "bot" && message.peerImages?.length
              ? await peerImages?.(message)
              : undefined
          if (message.peerImages?.length && !blocks)
            throw new BotDomainError("files_unavailable", "协作图片暂不可读取，未标记为已接收")
          const bytes = blocks ? Buffer.byteLength(JSON.stringify(blocks), "utf8") : 0
          // The shared checkpoint message delta budget is 8 MiB. Leave room for
          // text and pending tool state instead of accepting an unbounded batch.
          if (bytes > 6 * 1024 * 1024)
            throw new BotDomainError(
              "peer_image_context_limit",
              "单次协作图片超过待接收输入预算，请减少图片后重新发送"
            )
          if (imageBytes + bytes > 6 * 1024 * 1024) break
          imageBytes += bytes
          size += content.length
          messages.push(
            new HumanMessage({
              id,
              content:
                blocks && Array.isArray(blocks)
                  ? [{ type: "text", text: content }, ...blocks]
                  : content
            })
          )
        }
        return this.store.transaction(() => {
          this.store.assertDispatch(lease)
          // Preparation may yield. Recheck all selected versions before accepting
          // the batch, and never hold a SQLite transaction over an await.
          for (const message of messages) {
            const id = message.id!
            this.store.skillReferences.assertCurrent(this.store.skillReferences.forMessage(id))
            this.store.db.run(
              "UPDATE bot_steering SET accepted_at=COALESCE(accepted_at,?) WHERE message_id=?",
              [this.store.now(), id]
            )
            this.event("run.instruction_accepted", run.id, { messageId: id })
          }
          // Previously captured structured output predates these instructions.
          // Clear it atomically with acceptance so recovery cannot short-circuit
          // the model using a result that has not considered the new input.
          if (messages.length && run.source === "workflow-child")
            this.store.db.run(
              "UPDATE bot_workflow_child_state SET structured=NULL WHERE run_id=?",
              [run.id]
            )
          // A crash before graph checkpoint commit redelivers the same stable ID.
          return messages
        })
      }
    }
  }
}

/** Acceptance and graph delivery have separate receipts. Until the graph
 * commits these stable IDs, queue.take redelivers them after a process restart. */
export async function acceptBotPendingInput(
  store: BotStore,
  lease: BotRunLease,
  state: unknown,
  peerImages?: (
    message: import("../../shared/bot-types").BotMessage
  ) => Promise<MessageContent | undefined>
) {
  const appliedIds =
    z.object({ cmbCurrentRunMessageIds: z.array(z.string()).optional() }).parse(state ?? {})
      .cmbCurrentRunMessageIds ?? []
  const messages = await store.steering.queue(lease, peerImages).take({
    threadId: lease.runId,
    ownerRunToken: `${lease.owner}:${lease.fence}`,
    appliedIds,
    phase: "beforeModel"
  })
  if (!messages.length) throw new BotSteeringInterrupt()
  return {
    messages,
    cmbCurrentRunMessageIds: [
      ...new Set([...appliedIds, ...messages.map((message) => message.id!)])
    ]
  }
}
