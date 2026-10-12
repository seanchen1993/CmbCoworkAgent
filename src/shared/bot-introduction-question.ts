import { z } from "zod"
import { botQuestionsSchema } from "./bot-questions"

export const BOT_INTRODUCTION_QUESTION_CAPABILITY = "bot-introduction-question-v1"
/** The ordinary Cmb question contract, limited to one optional opening question. */
export const botIntroductionQuestionInput = botQuestionsSchema.safeExtend({
  questions: z
    .array(
      botQuestionsSchema.shape.questions.element.extend({
        multiple: z.literal(false).optional()
      })
    )
    .length(1)
})
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
export const botIntroductionQuestion = z
  .object({
    runId: identifier,
    messageId: identifier,
    botId: identifier,
    conversationId: identifier,
    dataEpoch: z.string().min(1).max(160),
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    status: z.enum(["pending", "answered", "skipped", "superseded"]),
    input: botIntroductionQuestionInput
  })
  .strict()
export const botIntroductionQuestionReply = z
  .object({
    runId: identifier,
    messageId: identifier,
    revision: z.number().int().positive(),
    nonce: identifier,
    dataEpoch: z.string().min(1).max(160),
    answer: z.string().min(1).max(32_000)
  })
  .strict()
export type BotIntroductionQuestion = z.infer<typeof botIntroductionQuestion>
export type BotIntroductionQuestionInput = z.infer<typeof botIntroductionQuestionInput>
export type BotIntroductionQuestionReply = z.infer<typeof botIntroductionQuestionReply>
export interface BotIntroductionQuestionReceipt {
  input: BotIntroductionQuestionReply
  question: BotIntroductionQuestion
  /** Only a submitted answer creates genuine work. Ignoring never starts a run. */
  send: import("./bot-types").BotSendReceipt | null
}
