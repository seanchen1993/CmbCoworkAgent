import { randomUUID } from "node:crypto"
import type {
  BotTeachSession,
  BotTeachPhase,
  BotTeachFrame,
  BotTeachEvent,
  BotTeachStartInput,
  BotTeachRetryInput
} from "../../shared/bot-teach"
import type { BotRunLease, BotSkill } from "../../shared/bot-types"
import { BotDomainError } from "../../shared/bot-types"
import { parseBotTeachStart } from "./teach-start-scope"
import type { BotStore } from "./store"
import * as v from "./validation"
import { z } from "zod"

type Row = Record<string, unknown>
const sessionRow = z.object({
  id: z.string(),
  bot_id: z.string(),
  conversation_id: z.string(),
  nonce: z.string(),
  thread_root: z.string().nullable(),
  start_request: z.string().nullable(),
  learning_epoch: z.string().nullable(),
  phase: z.enum([
    "recording",
    "paused",
    "finalizing",
    "queued",
    "learning",
    "ready",
    "failed",
    "interrupted",
    "discarded"
  ]),
  revision: z.number().int(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  frame_count: z.number().int(),
  event_count: z.number().int(),
  bytes: z.number(),
  error: z.string().nullable(),
  learning_run_id: z.string().nullable(),
  skill_id: z.string().nullable(),
  video: z.string().nullable(),
  attempt: z.number().int()
})
const frameRow = z.object({
  idx: z.number().int(),
  at: z.number(),
  sha256: z.string(),
  size: z.number(),
  url: z.string(),
  title: z.string()
})
const eventRow = z.object({
  idx: z.number().int(),
  at: z.number(),
  kind: z.string(),
  details: z.string()
})
const transitions: Record<BotTeachPhase, BotTeachPhase[]> = {
  recording: ["paused", "finalizing", "failed", "interrupted", "discarded"],
  paused: ["recording", "finalizing", "failed", "interrupted", "discarded"],
  finalizing: ["queued", "failed", "interrupted", "discarded"],
  queued: ["learning", "failed", "discarded"],
  learning: ["ready", "failed"],
  ready: [],
  failed: ["queued"],
  interrupted: [],
  discarded: []
}

/** Teach state belongs to the same SQLite transaction boundary as its runs and skills. */
export class BotTeachStore {
  constructor(readonly store: BotStore) {}
  private rows(sql: string, args: (string | number | null)[] = []): Row[] {
    const statement = this.store.db.prepare(sql, args),
      rows: Row[] = []
    try {
      while (statement.step()) rows.push(statement.getAsObject())
    } finally {
      statement.free()
    }
    return rows
  }
  private map(raw: Row): BotTeachSession {
    const row = sessionRow.parse(raw)
    const backend = row.start_request
      ? (z
          .object({
            target: z.object({ backend: z.enum(["browser", "windows-native"]).optional() })
          })
          .parse(JSON.parse(row.start_request)).target.backend ?? "browser")
      : "browser"
    return {
      backend,
      id: row.id,
      botId: row.bot_id,
      conversationId: row.conversation_id,
      startNonce: row.nonce,
      ...(row.thread_root ? { threadRootId: row.thread_root } : {}),
      phase: row.phase,
      revision: row.revision,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      frameCount: row.frame_count,
      eventCount: row.event_count,
      bytes: row.bytes,
      error: row.error,
      learningRunId: row.learning_run_id,
      skillId: row.skill_id,
      video: row.video ? JSON.parse(row.video) : null,
      attempt: row.attempt
    }
  }
  get(id: string): BotTeachSession {
    const row = this.rows("SELECT * FROM bot_teach_sessions WHERE id=?", [v.identifier(id)])[0]
    if (!row) throw new Error("示范记录不存在")
    return this.map(row)
  }
  forRun(runId: string): BotTeachSession | null {
    const row = this.rows("SELECT * FROM bot_teach_sessions WHERE learning_run_id=?", [
      v.identifier(runId)
    ])[0]
    return row ? this.map(row) : null
  }
  forNonce(input: {
    nonce: string
    botId: string
    conversationId: string
    target?: BotTeachStartInput["target"]
    expectedDataEpoch?: string
    conversationRevision?: number
    threadRootId?: string
  }): BotTeachSession | null {
    const row = this.rows("SELECT * FROM bot_teach_sessions WHERE nonce=?", [
      v.identifier(input.nonce)
    ])[0]
    if (!row) return null
    if (row.bot_id !== input.botId || row.conversation_id !== input.conversationId)
      throw new Error("录制请求标识已被其他请求使用")
    if (input.target) {
      if (!row.start_request)
        throw new BotDomainError("teach_scope", "旧示范没有原始目标凭据，请从示范记录核对")
      const submitted = parseBotTeachStart(input as BotTeachStartInput)
      if (v.canonicalJson(submitted) !== v.canonicalJson(JSON.parse(String(row.start_request))))
        throw new BotDomainError("nonce_conflict", "同一录制请求标识不能修改目标或对话")
    } else if (row.start_request) {
      throw new BotDomainError("teach_scope", "重试录制必须使用完整的原始请求")
    }
    return this.map(row)
  }

  startRequest(id: string): BotTeachStartInput | null {
    const row = this.rows("SELECT start_request FROM bot_teach_sessions WHERE id=?", [
      v.identifier(id)
    ])[0]
    if (!row) throw new Error("示范记录不存在")
    return row.start_request ? parseBotTeachStart(JSON.parse(String(row.start_request))) : null
  }

  /** Current membership is separate from historical Start receipt readability. */
  assertCurrentScope(session: BotTeachSession): void {
    this.store.getBot(session.botId)
    const conversation = this.store.getConversation(session.conversationId)
    if (!conversation.members.includes(session.botId))
      throw new BotDomainError("teach_scope", "此 Bot 已不在原示范对话中")
    if (session.threadRootId) this.store.threads.root(session.conversationId, session.threadRootId)
  }

  /** Existing recording receipts are history, not fresh learning authority. */
  assertLearningScope(session: BotTeachSession): void {
    const row = z
      .object({ start_request: z.string().nullable(), learning_epoch: z.string().nullable() })
      .parse(
        this.rows("SELECT start_request,learning_epoch FROM bot_teach_sessions WHERE id=?", [
          v.identifier(session.id)
        ])[0]
      )
    if (row.start_request && !row.learning_epoch)
      throw new BotDomainError("teach_scope", "示范缺少本次学习授权，请核对后重新学习")
    this.store.assertMutationEpoch(row.learning_epoch ?? "initial")
    this.assertCurrentScope(session)
  }

  assertStartScope(
    input: Pick<
      BotTeachStartInput,
      "botId" | "conversationId" | "conversationRevision" | "threadRootId" | "expectedDataEpoch"
    >
  ): void {
    this.store.assertMutationEpoch(input.expectedDataEpoch)
    this.store.getBot(input.botId)
    const conversation = this.store.getConversation(input.conversationId)
    if (!conversation.members.includes(input.botId))
      throw new BotDomainError("teach_scope", "Bot 不属于当前示范对话")
    if (
      (conversation.kind === "group" || input.threadRootId) &&
      input.conversationRevision === undefined
    )
      throw new BotDomainError("teach_scope", "请核对当前对话后再开始示范")
    if (
      input.conversationRevision !== undefined &&
      conversation.revision !== input.conversationRevision
    )
      throw new BotDomainError("revision_conflict", "对话成员或资料已变化，请重新选择")
    if (input.threadRootId) this.store.threads.root(input.conversationId, input.threadRootId)
  }
  list(botId?: string): BotTeachSession[] {
    if (botId) this.store.getBot(botId)
    return this.rows(
      `SELECT * FROM bot_teach_sessions ${botId ? "WHERE bot_id=? ORDER BY started_at DESC LIMIT 100" : "WHERE phase IN ('recording','paused','finalizing','queued','learning') ORDER BY started_at DESC"}`,
      botId ? [botId] : []
    ).map((row) => this.map(row))
  }
  history(input: { botId: string; before?: string }) {
    v.record(input)
    this.store.getBot(input.botId)
    const before = input.before ? this.get(input.before) : null
    if (before && before.botId !== input.botId) throw new Error("示范记录不属于此 Bot")
    const rows = this.rows(
      `SELECT * FROM bot_teach_sessions WHERE bot_id=? AND phase!='discarded'
       ${before ? "AND (started_at<? OR (started_at=? AND id<?))" : ""}
       ORDER BY started_at DESC,id DESC LIMIT 31`,
      before ? [input.botId, before.startedAt, before.startedAt, before.id] : [input.botId]
    )
    const items = rows.slice(0, 30).map((row) => this.map(row))
    return { items, nextCursor: rows.length > 30 ? items.at(-1)!.id : null }
  }
  discardedIds(): string[] {
    return this.rows("SELECT id FROM bot_teach_sessions WHERE phase='discarded'").map((row) =>
      z.string().parse(row.id)
    )
  }
  discardSaved(input: { id: string; revision: number }): BotTeachSession {
    v.record(input)
    v.integer(input.revision, "录制版本", 1, Number.MAX_SAFE_INTEGER)
    return this.store.transaction(() => {
      const session = this.get(input.id)
      if (session.phase === "discarded") return session
      if (session.revision !== input.revision) throw new Error("示范状态已变化，请刷新后重试")
      if (!["ready", "failed", "interrupted"].includes(session.phase))
        throw new Error("请等待录制或学习结束后再删除")
      if (
        session.learningRunId &&
        !["succeeded", "failed", "cancelled"].includes(
          this.store.getRun(session.learningRunId).status
        )
      )
        throw new Error("学习任务仍在执行或等待核对，不能删除恢复所需的录制")
      this.store.db.run("DELETE FROM bot_teach_reads WHERE session_id=?", [session.id])
      this.store.db.run("DELETE FROM bot_teach_frames WHERE session_id=?", [session.id])
      this.store.db.run("DELETE FROM bot_teach_events WHERE session_id=?", [session.id])
      // Retain the nonce and task/skill links. A retried start cannot recreate
      // deleted evidence or silently bind it to a different learning run.
      this.store.db.run(
        "UPDATE bot_teach_sessions SET phase='discarded',revision=revision+1,video=NULL,bytes=0,frame_count=0,event_count=0,error=NULL WHERE id=?",
        [session.id]
      )
      this.store.db.run(
        "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('teach.deleted',?,?,?)",
        [session.id, JSON.stringify({ botId: session.botId }), this.store.now()]
      )
      return this.get(session.id)
    })
  }
  create(
    input: Omit<BotTeachStartInput, "target"> & { target?: BotTeachStartInput["target"] }
  ): BotTeachSession {
    v.record(input)
    v.identifier(input.nonce)
    if (input.skillScope !== undefined && !input.target)
      throw new BotDomainError("teach_scope", "保存到我的技能库需要完整的原始录制目标")
    const request = input.target ? parseBotTeachStart(input as BotTeachStartInput) : null
    if (request) this.assertStartScope(request)
    else {
      this.store.getBot(input.botId)
      const conversation = this.store.getConversation(input.conversationId)
      if (conversation.kind !== "direct" || input.threadRootId)
        throw new BotDomainError("teach_scope", "旧示范仅支持私聊，请从原工作浏览器开始示范")
      if (!conversation.members.includes(input.botId)) throw new Error("Bot 不属于此对话")
    }
    return this.store.transaction(() => {
      if (request) this.assertStartScope(request)
      const previous = this.forNonce(input)
      if (previous) return previous
      if (
        this.rows(
          "SELECT id FROM bot_teach_sessions WHERE phase IN ('recording','paused','finalizing')"
        ).length
      )
        throw new Error("已有示范正在录制，请先保存或丢弃")
      const id = randomUUID()
      this.store.db.run(
        "INSERT INTO bot_teach_sessions(id,bot_id,conversation_id,nonce,phase,started_at,thread_root,start_request,learning_epoch) VALUES(?,?,?,?,'recording',?,?,?,?)",
        [
          id,
          input.botId,
          input.conversationId,
          input.nonce,
          this.store.now(),
          input.threadRootId ?? null,
          request ? v.canonicalJson(request) : null,
          request?.expectedDataEpoch ?? null
        ]
      )
      return this.get(id)
    })
  }
  update(
    id: string,
    revision: number,
    next: BotTeachPhase,
    fields: Partial<
      Pick<BotTeachSession, "endedAt" | "error" | "learningRunId" | "video" | "skillId">
    > = {}
  ): BotTeachSession {
    return this.store.transaction(() => this.updateInside(id, revision, next, fields))
  }
  private updateInside(
    id: string,
    revision: number,
    next: BotTeachPhase,
    fields: Partial<BotTeachSession>
  ): BotTeachSession {
    const old = this.get(id)
    if (old.revision !== revision) throw new Error("录制状态已变化，请刷新")
    if (next !== old.phase && !transitions[old.phase].includes(next))
      throw new Error("当前录制状态不支持此操作")
    const value = { ...old, ...fields }
    this.store.db.run(
      "UPDATE bot_teach_sessions SET phase=?,revision=revision+1,ended_at=?,error=?,learning_run_id=?,skill_id=?,video=? WHERE id=?",
      [
        next,
        value.endedAt,
        value.error,
        value.learningRunId,
        value.skillId,
        value.video ? JSON.stringify(value.video) : null,
        id
      ]
    )
    this.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('teach.changed',?,?,?)",
      [id, JSON.stringify({ botId: old.botId, phase: next }), this.store.now()]
    )
    return this.get(id)
  }
  addFrame(id: string, frame: Omit<BotTeachFrame, "index">): BotTeachFrame {
    return this.store.transaction(() => {
      const session = this.get(id)
      if (session.phase !== "recording") throw new Error("录制已暂停或结束")
      if (session.frameCount >= 600 || session.bytes + frame.size > 64 * 1024 * 1024)
        throw new Error("示范画面达到存储上限，请保存后分段示范")
      const index = session.frameCount
      this.store.db.run("INSERT INTO bot_teach_frames VALUES(?,?,?,?,?,?,?)", [
        id,
        index,
        frame.at,
        frame.sha256,
        frame.size,
        frame.url,
        frame.title
      ])
      this.store.db.run(
        "UPDATE bot_teach_sessions SET frame_count=frame_count+1,bytes=bytes+? WHERE id=?",
        [frame.size, id]
      )
      return { ...frame, index }
    })
  }
  addEvent(id: string, kind: string, details: Record<string, unknown>): void {
    this.store.transaction(() => {
      const session = this.get(id)
      if (session.phase !== "recording") return
      if (session.eventCount >= 500) throw new Error("示范操作达到 500 次上限，请分段示范")
      const data = v.canonicalJson(details)
      if (data.length > 4000) throw new Error("示范操作信息过长")
      this.store.db.run("INSERT INTO bot_teach_events VALUES(?,?,?,?,?)", [
        id,
        session.eventCount,
        this.store.now(),
        kind,
        data
      ])
      this.store.db.run("UPDATE bot_teach_sessions SET event_count=event_count+1 WHERE id=?", [id])
    })
  }
  frames(id: string): BotTeachFrame[] {
    this.get(id)
    return this.rows("SELECT * FROM bot_teach_frames WHERE session_id=? ORDER BY idx", [id]).map(
      (raw) => {
        const row = frameRow.parse(raw)
        return {
          index: row.idx,
          at: row.at,
          sha256: row.sha256,
          size: row.size,
          url: row.url,
          title: row.title
        }
      }
    )
  }
  events(id: string): BotTeachEvent[] {
    this.get(id)
    return this.rows("SELECT * FROM bot_teach_events WHERE session_id=? ORDER BY idx", [id]).map(
      (raw) => {
        const row = eventRow.parse(raw)
        return { index: row.idx, at: row.at, kind: row.kind, details: JSON.parse(row.details) }
      }
    )
  }
  queue(id: string): BotTeachSession {
    const session = this.get(id)
    if (session.phase !== "queued") return session
    this.assertLearningScope(session)
    // Bind the run to its recording in the same transaction as the message and nonce.
    // The nonce also recovers recordings written by the earlier split transaction version.
    const complete = (receipt: { runIds: string[] }) => {
      if (receipt.runIds.length !== 1)
        throw new BotDomainError("teach_scope", "示范学习必须绑定一个任务")
      this.updateInside(id, session.revision, "learning", { learningRunId: receipt.runIds[0] })
    }
    const scoped = this.startRequest(id) !== null
    const enqueue = (text: string) =>
      scoped
        ? this.store.enqueueTeachLearning(id, session.revision, text, complete)
        : this.store.send(
            {
              nonce: `teach-learning:${id}:${session.attempt}`,
              conversationId: session.conversationId,
              recipients: [session.botId],
              text
            },
            complete
          )
    try {
      // Tool instructions and the assigned recording are already supplied by the runtime's learning prompt.
      enqueue("示范已保存，请把刚才的操作整理成可复用技能，并说明适用场景和验收方法。")
    } catch (failure) {
      if (!(failure instanceof BotDomainError) || failure.code !== "nonce_conflict") throw failure
      // Recover the earlier split-transaction format with its exact original request, never a new nonce.
      enqueue(
        `示范已结束，请学习记录 ${id}，提炼可复用的步骤、输入参数、判断条件和验收方法，并保存为技能。先用 read_demonstration 查看画面和操作，不能把坐标串当作技能；尚未试跑，不要标记已验证。`
      )
    }
    return this.get(id)
  }

  retry(input: BotTeachRetryInput): BotTeachSession {
    v.record(input)
    v.identifier(input.nonce)
    const result = this.store.teachRetryReceipt(input, () => {
      const session = this.get(input.id)
      this.assertCurrentScope(session)
      const conversation = this.store.getConversation(session.conversationId)
      if (this.startRequest(session.id)) {
        if (input.revision === undefined || input.conversationRevision === undefined)
          throw new BotDomainError("teach_scope", "请核对当前示范和对话版本后重新学习")
        if (
          session.revision !== input.revision ||
          conversation.revision !== input.conversationRevision
        )
          throw new BotDomainError("revision_conflict", "示范或对话已变化，请重新核对")
      }
      const previous = this.rows("SELECT session_id FROM bot_teach_retry_receipts WHERE nonce=?", [
        input.nonce
      ])[0]
      if (previous) {
        if (previous.session_id !== session.id) throw new Error("重试标识已用于其他录制")
        return session
      }
      if (
        session.phase !== "failed" ||
        session.skillId !== null ||
        !session.video ||
        !session.frameCount
      )
        throw new Error("此录制不支持重新学习，请重新示范")
      // A completed model run may have omitted save_taught_skill. The service
      // marks that recording failed; it is safe to relearn only without a saved
      // skill and after the original run has fully settled.
      if (
        session.learningRunId &&
        !["succeeded", "failed", "cancelled"].includes(
          this.store.getRun(session.learningRunId).status
        )
      )
        throw new Error("请先处理原学习任务")
      this.store.db.run(
        "UPDATE bot_teach_sessions SET attempt=attempt+1,learning_epoch=? WHERE id=?",
        [input.expectedDataEpoch ?? "initial", session.id]
      )
      this.store.db.run("INSERT INTO bot_teach_retry_receipts VALUES(?,?)", [
        input.nonce,
        session.id
      ])
      return this.updateInside(session.id, session.revision, "queued", {
        learningRunId: null,
        error: null
      })
    })
    return result.phase === "queued" ? this.queue(result.id) : result
  }
  authorizeRead(id: string, lease: BotRunLease): BotTeachSession {
    const run = this.store.assertLease(lease),
      session = this.get(id)
    this.assertLearningScope(session)
    if (
      run.threadRootId !== session.threadRootId ||
      run.botId !== session.botId ||
      run.conversationId !== session.conversationId ||
      session.learningRunId !== run.id ||
      session.phase !== "learning"
    )
      throw new Error("示范记录不属于当前学习任务")
    return session
  }
  readFrames(id: string, lease: BotRunLease, indices: number[]): void {
    this.store.transaction(() => {
      this.authorizeRead(id, lease)
      for (const index of indices)
        this.store.db.run("INSERT OR IGNORE INTO bot_teach_reads VALUES(?,?,?)", [
          id,
          lease.runId,
          index
        ])
    })
  }
  saveLearned(
    id: string,
    lease: BotRunLease,
    callId: string,
    input: { name: string; instructions: string }
  ): BotSkill {
    return this.store.toolOnce(lease, callId, { teach: id, ...input }, () => {
      const session = this.authorizeRead(id, lease)
      const read = this.rows(
        "SELECT COUNT(*) AS count FROM bot_teach_reads WHERE session_id=? AND run_id=?",
        [id, lease.runId]
      )[0].count
      if (read !== session.frameCount || !session.frameCount)
        throw new Error("请完整查看示范画面后再保存技能")
      const skill = this.store.saveSkill(
        {
          botId: session.botId,
          ...input,
          enabled: true,
          ...(this.startRequest(id)?.skillScope === "user" ? { scope: "user" as const } : {})
        },
        { kind: "task", lease }
      )
      this.updateInside(id, session.revision, "ready", { skillId: skill.id })
      return skill
    })
  }
}
