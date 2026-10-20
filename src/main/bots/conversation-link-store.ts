import { createHash, randomUUID } from "node:crypto"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { BotStore } from "./store"
import { BotError } from "../../shared/bots/contracts"
import type {
  BotWorkConversationRef,
  LinkBotWorkConversationInput
} from "../../shared/bots/conversation"
import {
  localWorkConversationRef,
  readWorkConversationRecord,
  type WorkConversationRecord
} from "./conversation-link-validation"

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
  private save(workId: string, record: WorkConversationRecord, detached = false) {
    this.db.run(
      "UPDATE bot_work_items SET conversation_json=?,detached=?,version=version+1,updated_at=? WHERE id=?",
      [JSON.stringify(record), detached ? 1 : 0, this.now(), workId]
    )
    this.changed()
  }
  prepare(input: LinkBotWorkConversationInput) {
    const ref = localWorkConversationRef(input.conversation)
    return this.transaction(() => {
      const bot = this.owner.getBot(input.botId)
      if (bot.archived || bot.deleting) throw new BotError("CONFLICT", "请先恢复所属 Bot。")
      if (
        !input.operationId ||
        input.operationId.length > 128 ||
        !input.title.trim() ||
        input.title.length > 160 ||
        !input.goal.trim() ||
        input.goal.length > 30000
      )
        throw new BotError("INVALID_INPUT", "任务名称、目标或操作标识无效。")
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([input.botId, input.title.trim(), input.goal.trim(), ref]))
        .digest("hex")
      const commandId = `conversation-link:${input.operationId}`,
        previous = this.rows(
          "SELECT fingerprint,receipt FROM bot_work_commands WHERE command_id=?",
          [commandId]
        )[0]
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new BotError("CONFLICT", "此关联操作标识已用于其他内容。")
        const { workId } = JSON.parse(String(previous.receipt)),
          record = this.record(workId)
        if (!record || record.state === "detached" || record.state === "detaching")
          throw new BotError("CONFLICT", "原任务关联已解除，旧操作不会重新关联。")
        return this.owner.getWork(bot.id, workId)
      }
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
        "INSERT INTO bot_work_items(id,bot_id,thread_id,parent_thread_id,title,goal,audience_key,created_at,updated_at,conversation_json) VALUES(?,?,?,?,?,?,'desktop',?,?,?)",
        [
          id,
          bot.id,
          ref.threadId,
          bot.threadId,
          input.title.trim(),
          input.goal.trim(),
          now,
          now,
          JSON.stringify(record)
        ]
      )
      this.db.run("INSERT INTO bot_work_commands(command_id,fingerprint,receipt) VALUES(?,?,?)", [
        commandId,
        fingerprint,
        JSON.stringify({ workId: id })
      ])
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
      this.save(workId, {
        ref,
        origin: "created",
        state: "preparing",
        operationId: `created:${workId}`,
        fingerprint: createHash("sha256")
          .update(JSON.stringify([botId, workId, ref]))
          .digest("hex")
      })
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
  beginDetach(botId: string, workId: string, expectedVersion: number) {
    return this.transaction(() => {
      const work = this.owner.getWork(botId, workId),
        record = this.record(workId)
      if (!record) throw new BotError("CONFLICT", "此任务尚无可解除的本机会话关联。")
      if (record.state === "detached" || record.state === "detaching") return work
      if (work.version !== expectedVersion)
        throw new BotError("CONFLICT", "任务已变化，请刷新后重新确认。")
      this.assertIdle(botId, workId)
      this.save(workId, { ...record, state: "detaching" })
      return this.owner.getWork(botId, workId)
    })
  }
  detached(botId: string, workId: string) {
    return this.transaction(() => {
      this.owner.getWork(botId, workId)
      const record = this.record(workId)
      if (!record || !["preparing", "detaching", "detached"].includes(record.state))
        throw new BotError("CONFLICT", "请先确认解除原任务关联。")
      if (record.state !== "detached") {
        this.assertIdle(botId, workId)
        this.save(workId, { ...record, state: "detached" }, true)
        this.db.run("UPDATE bot_work_items SET state='completed' WHERE id=?", [workId])
      }
      return this.owner.getWork(botId, workId)
    })
  }
}
