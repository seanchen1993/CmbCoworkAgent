import { z } from "zod"
import { optionSchema, questionSchema, validateQuestionIds } from "./user-input-schema"

export const botQuestionsSchema = z
  .object({
    questions: z
      .array(
        questionSchema
          .extend({
            multiple: z
              .boolean()
              .optional()
              .describe(
                "Allow multiple choices from the options. Defaults to single choice; free text is always available."
              ),
            id: questionSchema.shape.id
              .max(80)
              .refine(
                (id) => !["constructor", "prototype", "__proto__"].includes(id),
                "请使用具体问题名称作为 ID"
              ),
            options: z
              .array(optionSchema)
              .max(5)
              .describe(
                "Zero options for free text, or 2-5 choices. The user can always enter a custom answer."
              )
          })
          .strict()
      )
      .min(1)
      .max(10)
  })
  .strict()
  .superRefine((input, context) => {
    validateQuestionIds(input, context)
    for (const [index, question] of input.questions.entries())
      if (question.options.length === 1 || (question.multiple && question.options.length < 2))
        context.addIssue({
          code: "custom",
          path: ["questions", index, "options"],
          message: "单选题至少提供两个选项，或使用空选项请求文本"
        })
  })
export type BotQuestions = z.infer<typeof botQuestionsSchema>
const cardSchema = z.object({
  botQuestions: z.object({ version: z.literal(1), input: botQuestionsSchema })
})

export function readBotQuestions(prompt: string): BotQuestions | null {
  try {
    return cardSchema.safeParse(JSON.parse(prompt)).data?.botQuestions.input ?? null
  } catch {
    return null
  }
}

const answer = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("multiple"),
      questionId: z.string(),
      optionIndices: z.array(z.number().int().nonnegative()).min(1).max(5),
      labels: z.array(z.string().max(80)).max(5).optional()
    })
    .strict(),
  z
    .object({
      type: z.literal("other"),
      questionId: z.string(),
      text: z.string().trim().min(1).max(2000)
    })
    .strict(),
  z
    .object({
      type: z.literal("option"),
      questionId: z.string(),
      optionIndex: z.number().int().nonnegative(),
      label: z.string().max(80).optional(),
      description: z.string().max(240).optional(),
      additionalText: z.string().trim().max(2000).optional()
    })
    .strict()
])
const response = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled"), answers: z.object({}).strict() }).strict(),
  z.object({ status: z.literal("submitted"), answers: z.record(z.string(), answer) }).strict()
])

/** Validate again in the durable store; option labels come from the original request, never the client. */
export function validateBotQuestionAnswer(input: BotQuestions, raw: string): string {
  let parsed: z.infer<typeof response>
  try {
    parsed = response.parse(JSON.parse(raw))
  } catch {
    throw new Error("回答格式无效，请在问题卡片中填写或取消")
  }
  if (parsed.status === "cancelled") return JSON.stringify(parsed)
  if (Object.keys(parsed.answers).length !== input.questions.length)
    throw new Error("请回答所有问题后提交")
  const answers = Object.fromEntries(
    input.questions.map((question) => {
      const value = Object.hasOwn(parsed.answers, question.id)
        ? parsed.answers[question.id]
        : undefined
      if (!value || value.questionId !== question.id)
        throw new Error("回答与问题不匹配，请重新填写")
      if (value.type === "other") return [question.id, value]
      if (value.type === "multiple") {
        if (
          !question.multiple ||
          new Set(value.optionIndices).size !== value.optionIndices.length ||
          value.optionIndices.some((index) => !question.options[index])
        )
          throw new Error("多选答案无效，请重新选择")
        const optionIndices = [...value.optionIndices].sort((a, b) => a - b)
        return [
          question.id,
          {
            type: "multiple",
            questionId: question.id,
            optionIndices,
            labels: optionIndices.map((index) => question.options[index].label)
          }
        ]
      }
      if (question.multiple) throw new Error("请按多选格式提交答案")
      const option = question.options[value.optionIndex]
      if (!option) throw new Error("所选答案已无效，请重新选择")
      return [
        question.id,
        {
          type: "option",
          questionId: question.id,
          optionIndex: value.optionIndex,
          label: option.label,
          description: option.description,
          ...(value.additionalText ? { additionalText: value.additionalText } : {})
        }
      ]
    })
  )
  return JSON.stringify({ status: "submitted", answers })
}

/** Visible, durable acknowledgement; only already validated non-sensitive answers enter history. */
export function formatBotQuestionAnswer(input: BotQuestions, raw: string): string {
  const parsed = response.parse(JSON.parse(raw))
  if (parsed.status === "cancelled")
    return `已取消回答，未选择任何答案。\n\n${input.questions.map((question) => question.question).join("\n")}`
  return (
    "补充信息\n\n" +
    input.questions
      .map((question) => {
        const value = parsed.answers[question.id]
        const text =
          value.type === "multiple"
            ? value.optionIndices.map((index) => question.options[index].label).join("、")
            : value.type === "other"
              ? value.text
              : `${question.options[value.optionIndex].label}${value.additionalText ? `\n补充：${value.additionalText}` : ""}`
        return `${question.question}\n${text}`
      })
      .join("\n\n")
  )
}
