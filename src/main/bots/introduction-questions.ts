import { createHash } from "node:crypto"
import {
  botIntroductionQuestion,
  botIntroductionQuestionInput,
  botIntroductionQuestionReply,
  type BotIntroductionQuestion,
  type BotIntroductionQuestionInput,
  type BotIntroductionQuestionReceipt,
  type BotIntroductionQuestionReply
} from "../../shared/bot-introduction-question"
import { formatBotQuestionAnswer, validateBotQuestionAnswer } from "../../shared/bot-questions"
import { BOT_INTRODUCTION_SOURCE } from "../../shared/bot-introduction"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"

/** Optional onboarding belongs to its durable public message, not a waiting
 * execution lease. It reuses the normal send path for an actual human answer. */
export class BotIntroductionQuestions {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, request: unknown, operation: () => T) => T,
    private readonly event: (kind: string, id: string, payload: unknown) => void,
    private readonly append: (runId: string, text: string) => string
  ) {}

  stage(lease: BotRunLease, callId: string, input: BotIntroductionQuestionInput) {
    const parsed = botIntroductionQuestionInput.parse(input)
    return this.store.toolOnce(
      lease,
      callId,
      parsed,
      () => {
        this.store.assertIntroductionDispatch(lease)
        const raw = JSON.stringify(parsed)
        if (raw.length > 16_000) throw new BotDomainError("invalid_input", "介绍问题过长")
        if (this.one("SELECT 1 FROM bot_introduction_questions WHERE run_id=?", [lease.runId]))
          throw new BotDomainError("introduction_question_exists", "已经准备了一个介绍问题")
        this.store.db.run("INSERT INTO bot_introduction_questions VALUES(?,NULL,?,?,'staged',1)", [
          lease.runId,
          raw,
          this.store.dataEpoch()
        ])
        return { prepared: true, optional: true }
      },
      () => this.store.assertIntroductionDispatch(lease)
    )
  }

  /** Called inside the introduction's existing final-publication transaction. */
  publish(runId: string, messageId: string): void {
    const run = this.store.getRun(runId)
    if (run.source !== BOT_INTRODUCTION_SOURCE || run.status !== "succeeded")
      throw new BotDomainError("introduction_scope", "问题不属于已完成的介绍")
    const message = this.one(
      "SELECT 1 FROM bot_messages WHERE id=? AND run_id=? AND bot_id=? AND conversation_id=? AND sender='bot'",
      [messageId, runId, run.botId, run.conversationId]
    )
    if (!message) throw new BotDomainError("introduction_scope", "介绍问题缺少实际公开消息")
    const staged = this.one(
      "SELECT input FROM bot_introduction_questions WHERE run_id=? AND status='staged' AND data_epoch=?",
      [runId, this.store.dataEpoch()]
    )
    if (!staged) return
    const input = botIntroductionQuestionInput.parse(JSON.parse(String(staged.input)))
    // The question is an actual public message, so normal history/read_message
    // retains it. UI metadata does not hide conversation content from the model.
    const questionMessage = this.append(runId, input.questions[0].question)
    this.store.db.run(
      "UPDATE bot_introduction_questions SET message_id=?,status='pending' WHERE run_id=? AND status='staged' AND data_epoch=?",
      [questionMessage, runId, this.store.dataEpoch()]
    )
  }

  /** Genuine work always wins, including peer/routine work and the first task. */
  suppress(botIds: string[]): void {
    if (!botIds.length) return
    this.store.db.run(
      `UPDATE bot_introduction_questions SET status='superseded',revision=revision+1
       WHERE status IN ('staged','pending') AND run_id IN
       (SELECT run_id FROM bot_introductions WHERE bot_id IN (${botIds.map(() => "?").join(",")}))`,
      botIds
    )
  }

  forMessages(rows: Record<string, unknown>[]): Map<string, BotIntroductionQuestion> {
    if (rows.length > 200) throw new BotDomainError("invalid_input", "介绍问题超出消息分页范围")
    const ids = rows.filter((row) => row.sender === "bot").map((row) => String(row.id))
    const result = new Map<string, BotIntroductionQuestion>()
    if (!ids.length) return result
    const statement = this.store.db.prepare(
      `SELECT q.*,r.bot_id,r.conversation_id,m.created_at FROM bot_introduction_questions q
       JOIN bot_runs r ON r.id=q.run_id JOIN bot_messages m ON m.id=q.message_id
       WHERE q.message_id IN (${ids.map(() => "?").join(",")}) AND r.source=? AND r.status='succeeded'
       AND m.run_id=r.id AND m.bot_id=r.bot_id AND m.conversation_id=r.conversation_id AND m.sender='bot'`,
      [...ids, BOT_INTRODUCTION_SOURCE]
    )
    try {
      while (statement.step()) {
        const row = statement.getAsObject(),
          question = this.project(row)
        result.set(question.messageId, question)
      }
    } finally {
      statement.free()
    }
    return result
  }

  reply(raw: BotIntroductionQuestionReply): BotIntroductionQuestionReceipt {
    const input = botIntroductionQuestionReply.parse(raw)
    return this.store.transaction(() => {
      this.store.assertMutationEpoch(input.dataEpoch)
      return this.receipt(input.nonce, { op: "introduction.question.reply", ...input }, () => {
        const run = this.store.getRun(input.runId)
        const message = this.store.message({
          conversationId: run.conversationId,
          id: input.messageId
        })
        const question = message.introductionQuestion
        const conversation = this.store.getConversation(run.conversationId)
        this.store.getBot(run.botId)
        if (
          !question ||
          question.runId !== run.id ||
          question.botId !== run.botId ||
          run.source !== BOT_INTRODUCTION_SOURCE ||
          run.status !== "succeeded" ||
          conversation.kind !== "direct" ||
          conversation.members.length !== 1 ||
          conversation.members[0] !== run.botId ||
          question.dataEpoch !== input.dataEpoch
        )
          throw new BotDomainError("introduction_scope", "问题不属于此 Bot 的原介绍")
        if (question.revision !== input.revision || question.status !== "pending")
          throw new BotDomainError("stale_interaction", "介绍问题已处理，可直接交办工作")
        const answer = validateBotQuestionAnswer(question.input, input.answer)
        const skipped = JSON.parse(answer).status === "cancelled"
        const send = skipped
          ? null
          : this.store.send({
              nonce: `introduction-answer:${createHash("sha256").update(input.nonce).digest("hex")}`,
              conversationId: run.conversationId,
              text: formatBotQuestionAnswer(question.input, answer),
              replyTo: input.messageId
            })
        this.store.db.run(
          "UPDATE bot_introduction_questions SET status=?,revision=? WHERE run_id=?",
          [skipped ? "skipped" : "answered", question.revision + 1, run.id]
        )
        this.event("introduction.question_answered", input.messageId, {
          runId: run.id,
          skipped,
          conversationId: run.conversationId
        })
        return {
          input,
          question: {
            ...question,
            status: skipped ? ("skipped" as const) : ("answered" as const),
            revision: question.revision + 1
          },
          send
        }
      })
    })
  }

  private project(row: Record<string, unknown>): BotIntroductionQuestion {
    return botIntroductionQuestion.parse({
      runId: row.run_id,
      messageId: row.message_id,
      botId: row.bot_id,
      conversationId: row.conversation_id,
      dataEpoch: row.data_epoch,
      revision: row.revision,
      createdAt: row.created_at,
      status: row.data_epoch !== this.store.dataEpoch() ? "superseded" : row.status,
      input: JSON.parse(String(row.input))
    })
  }

  private one(sql: string, args: unknown[]): Record<string, unknown> | null {
    const statement = this.store.db.prepare(sql, args)
    try {
      return statement.step() ? statement.getAsObject() : null
    } finally {
      statement.free()
    }
  }
}
