import { createHash, randomUUID } from "node:crypto"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { BotStore } from "./store"
import { BotError } from "../../shared/bots/contracts"
import type {
  BotWorkConversationRef,
  LinkBotWorkConversationInput
} from "../../shared/bots/conversation"
import type { BotConversationToolSource, BotOrdinaryThreadRef, BotThreadDeleteInput } from "../../shared/bots/thread-history"
import type { BotWorkItem } from "../../shared/bots/work"
import type { BotDesktopOperationTarget } from "./desktop-operation"
import {
  localWorkConversationRef,
  readWorkConversationRecord,
  type WorkConversationRecord
} from "./conversation-link-validation"

// Reuse the work's projection flags: this hides a derived title, never its new goal.
export const OMIT_DERIVED_WORK_TITLE = 4

function commandFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function createdConversationRecord(botId: string, workId: string, ref: BotOrdinaryThreadRef): WorkConversationRecord {
  return {
    ref,
    origin: "created",
    state: "preparing",
    operationId: `created:${workId}`,
    fingerprint: commandFingerprint([botId, workId, ref])
  }
}

export function conversationToolOperationId(source: BotConversationToolSource): string {
  return `tool-${commandFingerprint([source.taskId, source.key])}`
}

/** The original control database journals the handshake; it never owns/copies the transcript. */
export class BotWorkConversationJournal {
  constructor(
    private db: NativeSqliteAdapter,
    private owner: BotStore,
    private transaction: <T>(fn: () => T) => T,
    private changed: () => void,
    private now: () => number
  ) {}
  private rows(sql: string, args: readonly unknown[] = []): Record<string, unknown>[] {
    const q = this.db.prepare(sql, args),
      result: Record<string, unknown>[] = []
    try {
      while (q.step()) result.push(q.getAsObject())
      return result
    } finally {
      q.free()
    }
  }
  record(workId: string): WorkConversationRecord | undefined {
    const row = this.rows("SELECT thread_id,conversation_json FROM bot_work_items WHERE id=?", [
      workId
    ])[0]
    return row
      ? readWorkConversationRecord(row.conversation_json, String(row.thread_id))
      : undefined
  }
  forThread(threadId: string) {
    const row = this.rows("SELECT id,bot_id FROM bot_work_items WHERE thread_id=? AND detached=0", [
      threadId
    ])[0]
    return row ? this.owner.getWork(String(row.bot_id), String(row.id)) : null
  }
  forBot(botId: string) {
    return this.rows(
      "SELECT id FROM bot_work_items WHERE bot_id=? AND conversation_json IS NOT NULL",
      [botId]
    ).map((row) => this.owner.getWork(botId, String(row.id)))
  }
  private save(workId: string, record: WorkConversationRecord, detached = false) {
    this.db.run(
      "UPDATE bot_work_items SET conversation_json=?,detached=?,version=version+1,updated_at=? WHERE id=?",
      [JSON.stringify(record), detached ? 1 : 0, this.now(), workId]
    )
    this.changed()
  }
  private commandReceipt<T = { workId: string; botId: string }>(commandId: string, fingerprint: string, source?: BotConversationToolSource) {
    const previous = this.rows(source
      ? `SELECT command_id,source_task_id,request_key,fingerprint,receipt FROM bot_work_commands
         WHERE command_id=? OR (source_task_id=? AND (tool_call_id=? OR request_key=?))`
      : "SELECT command_id,fingerprint,receipt FROM bot_work_commands WHERE command_id=?",
    source ? [commandId, source.taskId, source.callId, source.key] : [commandId])
    if (previous.some(row => row.fingerprint !== fingerprint || row.command_id !== commandId ||
        (source && (row.source_task_id !== source.taskId || row.request_key !== source.key))))
      throw new BotError("CONFLICT", "此关联操作标识已用于其他内容。")
    return previous[0] ? JSON.parse(String(previous[0].receipt)) as T : undefined
  }
  ordinaryDeletion(botId: string, input: BotThreadDeleteInput, source: BotConversationToolSource,
    phase?: "confirmed" | "deleted") {
    const ref = localWorkConversationRef(input.conversation)
    const commandId = `conversation-delete:${conversationToolOperationId(source)}`
    const fingerprint = commandFingerprint(["delete-thread", botId, ref, input.expectedTitle])
    return this.transaction(() => {
      const previous = this.commandReceipt<{ phase: "confirmed" | "deleted" }>(commandId, fingerprint, source)
      if (!phase || previous?.phase === "deleted") return previous
      if (!previous) {
        if (phase !== "confirmed") throw new BotError("CONFLICT", "会话删除尚未确认。")
        const binding = this.owner.desktopOperationBinding(source.taskId,
          { kind: "thread_delete", targetId: ref.threadId })
        this.db.run("INSERT INTO bot_work_commands(command_id,source_task_id,tool_call_id,request_key,fingerprint,receipt,operation_json) VALUES(?,?,?,?,?,?,?)",
          [commandId, source.taskId, source.callId, source.key, fingerprint, JSON.stringify({ phase }),
            binding ? JSON.stringify(binding) : null])
      } else {
        this.db.run("UPDATE bot_work_commands SET receipt=? WHERE command_id=?", [JSON.stringify({ phase }), commandId])
      }
      this.changed()
      return { phase }
    })
  }
  private recordCommand(
    commandId: string, fingerprint: string, workId: string, botId: string,
    operation: BotDesktopOperationTarget, source?: BotConversationToolSource
  ) {
    const binding = source && this.owner.desktopOperationBinding(source.taskId, operation)
    this.db.run(
      "INSERT INTO bot_work_commands(command_id,source_task_id,tool_call_id,request_key,fingerprint,receipt,operation_json) VALUES(?,?,?,?,?,?,?)",
      [commandId, source?.taskId ?? null, source?.callId ?? null, source?.key ?? null, fingerprint,
        JSON.stringify({ workId, botId }), binding ? JSON.stringify(binding) : null]
    )
  }
  private linkCommand(input: LinkBotWorkConversationInput) {
    const ref = localWorkConversationRef(input.conversation)
    if (
      !input.operationId ||
      input.operationId.length > 128 ||
      !input.title.trim() ||
      input.title.length > 160 ||
      !input.goal.trim() ||
      input.goal.length > 30000
    )
      throw new BotError("INVALID_INPUT", "任务名称、目标或操作标识无效。")
    return {
      ref,
      commandId: `conversation-link:${input.operationId}`,
      fingerprint: commandFingerprint([input.botId, input.title.trim(), input.goal.trim(), ref])
    }
  }
  linkReceipt(input: LinkBotWorkConversationInput, source?: BotConversationToolSource) {
    const { commandId, fingerprint } = this.linkCommand(input)
    const previous = this.commandReceipt(commandId, fingerprint, source)
    if (!previous) return undefined
    const record = this.record(previous.workId)
    if (!record || record.state === "detached" || record.state === "detaching")
      throw new BotError("CONFLICT", "原任务关联已解除，旧操作不会重新关联。")
    return this.owner.getWork(input.botId, previous.workId)
  }
  prepare(input: LinkBotWorkConversationInput, source?: BotConversationToolSource, hideDerivedTitle = false) {
    const { ref, commandId, fingerprint } = this.linkCommand(input)
    return this.transaction(() => {
      const bot = this.owner.getBot(input.botId)
      if (bot.archived || bot.deleting) throw new BotError("CONFLICT", "请先恢复所属 Bot。")
      const previous = this.linkReceipt(input, source)
      if (previous) return previous
      if (this.forThread(ref.threadId))
        throw new BotError("CONFLICT", "此会话已经关联任务，请先显式解除原关联。")
      const id = randomUUID(),
        now = this.now(),
        record: WorkConversationRecord = {
          ref,
          origin: "existing",
          state: "preparing",
          operationId: input.operationId,
          fingerprint
        }
      this.db.run(
        "INSERT INTO bot_work_items(id,bot_id,thread_id,parent_thread_id,title,goal,audience_key,created_at,updated_at,conversation_json,omit_result_title) VALUES(?,?,?,?,?,?,'desktop',?,?,?,?)",
        [
          id,
          bot.id,
          ref.threadId,
          bot.threadId,
          input.title.trim(),
          input.goal.trim(),
          now,
          now,
          JSON.stringify(record),
          hideDerivedTitle ? OMIT_DERIVED_WORK_TITLE : 0
        ]
      )
      this.recordCommand(commandId, fingerprint, id, bot.id, { kind: "thread_link", targetId: ref.threadId, workId: id }, source)
      this.changed()
      return this.owner.getWork(bot.id, id)
    })
  }
  prepareCreated(botId: string, workId: string, conversation: BotWorkConversationRef) {
    const ref = localWorkConversationRef(conversation)
    return this.transaction(() => {
      const work = this.owner.getWork(botId, workId)
      if (work.source || work.audienceKey !== "desktop" || work.threadId !== ref.threadId)
        throw new BotError("CONFLICT", "只有本机独立任务可在对话模式打开。")
      const old = this.record(workId)
      if (old) {
        if (
          JSON.stringify(old.ref) !== JSON.stringify(ref) ||
          old.state === "detached" ||
          old.state === "detaching"
        )
          throw new BotError("CONFLICT", "任务会话身份或关联状态已变化。")
        return work
      }
      this.save(workId, createdConversationRecord(botId, workId, ref))
      return this.owner.getWork(botId, workId)
    })
  }
  bound(botId: string, workId: string, conversation: BotWorkConversationRef) {
    const ref = localWorkConversationRef(conversation)
    return this.transaction(() => {
      this.owner.getWork(botId, workId)
      const record = this.record(workId)
      if (
        !record ||
        JSON.stringify(record.ref) !== JSON.stringify(ref) ||
        !["preparing", "bound"].includes(record.state)
      )
        throw new BotError("CONFLICT", "任务关联已变化，请重新核对原会话。")
      if (record.state !== "bound") {
        this.save(workId, { ...record, state: "bound" })
        this.db.run("UPDATE bot_work_items SET initialized=1 WHERE id=?", [workId])
      }
      return this.owner.getWork(botId, workId)
    })
  }
  assertIdle(botId: string, workId: string) {
    const work = this.owner.getWork(botId, workId)
    if (
      work.backgroundBusy ||
      this.owner.pendingWorkFamily(botId, workId).length ||
      this.rows(
        "SELECT c.id FROM bot_commands c LEFT JOIN bot_tasks t ON t.id=c.source_task_id WHERE c.state='accepted' AND (c.thread_id=? OR json_extract(t.origin_json,'$.rootWorkId')=?) LIMIT 1",
        [work.threadId, workId]
      ).length ||
      this.rows(
        "SELECT task_id FROM bot_reply_outbox WHERE blocked=0 AND (json_extract(origin_json,'$.rootWorkId')=? OR json_extract(origin_json,'$.returnWorkId')=?) LIMIT 1",
        [workId, workId]
      ).length
    )
      throw new BotError("CONFLICT", "请先处理任务待办、审批、后台执行和协作结果，再解除关联。")
  }
  private unlinkCommand(work: BotWorkItem, expectedVersion: number, source: BotConversationToolSource, ref = work.conversation?.ref) {
    return {
      commandId: `conversation-unlink:${conversationToolOperationId(source)}`,
      fingerprint: commandFingerprint(["unlink", work.botId, work.id, expectedVersion, ref])
    }
  }
  unlinkReceipt(work: BotWorkItem, expectedVersion: number, source: BotConversationToolSource, ref?: BotOrdinaryThreadRef) {
    const { commandId, fingerprint } = this.unlinkCommand(work, expectedVersion, source, ref)
    return this.commandReceipt(commandId, fingerprint, source) !== undefined
  }
  beginDetach(
    botId: string, workId: string, expectedVersion: number, source?: BotConversationToolSource,
    unexposedRef?: BotOrdinaryThreadRef
  ) {
    return this.transaction(() => {
      const work = this.owner.getWork(botId, workId),
        stored = this.record(workId)
      // The service verified the native ref under the thread lock. Journal
      // detaching directly, without exposing a binding or changing settings.
      const record = stored ?? (source && unexposedRef && work.threadInitialized && !work.source &&
        work.audienceKey === "desktop" && work.threadId === unexposedRef.threadId
        ? createdConversationRecord(botId, workId, unexposedRef) : undefined)
      if (!record) throw new BotError("CONFLICT", "此任务尚无可解除的本机会话关联。")
      const command = source ? this.unlinkCommand(work, expectedVersion, source, record.ref) : undefined
      if (command) {
        const replay = this.commandReceipt(command.commandId, command.fingerprint, source) !== undefined
        if (replay && (record.state === "detaching" || record.state === "detached")) return work
        if (stored && record.state !== "bound")
          throw new BotError("CONFLICT", "原任务关联已变化，请先核对原操作回执。")
      } else if (record.state === "detached" || record.state === "detaching") return work
      if (work.version !== expectedVersion)
        throw new BotError("CONFLICT", "任务已变化，请刷新后重新确认。")
      this.assertIdle(botId, workId)
      if (command) {
        this.recordCommand(command.commandId, command.fingerprint, workId, botId, { kind: "work_unlink", targetId: workId }, source)
      }
      this.save(workId, { ...record, state: "detaching" })
      return this.owner.getWork(botId, workId)
    })
  }
  detached(botId: string, workId: string, retainThreadClaim = false) {
    return this.transaction(() => {
      this.owner.getWork(botId, workId)
      const record = this.record(workId)
      if (!record || !["preparing", "detaching", "detached"].includes(record.state))
        throw new BotError("CONFLICT", "请先确认解除原任务关联。")
      if (record.state !== "detached") {
        this.assertIdle(botId, workId)
        this.save(workId, { ...record, state: "detached" }, !retainThreadClaim)
        this.db.run("UPDATE bot_work_items SET state='completed' WHERE id=?", [workId])
      }
      return this.owner.getWork(botId, workId)
    })
  }
}
