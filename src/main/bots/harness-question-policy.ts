import { z } from "zod"
import type { HarnessRequestUserInputConfig } from "../../shared/harness-board-types"
import { botQuestionsSchema, readBotQuestions } from "../../shared/bot-questions"
import type { BotInteraction } from "../../shared/bot-types"

export function botHarnessQuestionsSchema(policy?: HarnessRequestUserInputConfig) {
  return policy?.allowAutoResolution
    ? z
        .object({
          questions: botQuestionsSchema.shape.questions,
          autoResolutionMs: z.number().int().min(30_000).max(240_000).optional()
        })
        .strict()
        .superRefine((value, ctx) => {
          const result = botQuestionsSchema.safeParse({ questions: value.questions })
          if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue })
        })
    : botQuestionsSchema
}

/** The run's frozen project policy can resolve questions; it can never approve an effect. */
export function botHarnessAutomaticAnswer(
  interaction: BotInteraction,
  policy: HarnessRequestUserInputConfig | undefined,
  now: number
): string | null {
  if (
    interaction.kind !== "question" ||
    interaction.status !== "pending" ||
    !policy?.allowAutoResolution
  )
    return null
  const questions = readBotQuestions(interaction.prompt)
  if (!questions) return null
  let deadline: number | undefined
  try {
    deadline = z
      .object({ harnessAutoResolution: z.object({ deadline: z.number().int() }) })
      .parse(JSON.parse(interaction.prompt)).harnessAutoResolution.deadline
  } catch {
    return null
  }
  if (
    deadline < interaction.createdAt + 30_000 ||
    deadline > interaction.createdAt + 240_000 ||
    now < deadline
  )
    return null
  const selected =
    policy.autoResolutionType === "select_first" &&
    questions.questions.every((question) => question.options.length >= 2)
  const answers = selected
    ? Object.fromEntries(
        questions.questions.map((question) => [
          question.id,
          question.multiple
            ? {
                type: "multiple",
                questionId: question.id,
                optionIndices: [0],
                labels: [question.options[0]!.label]
              }
            : {
                type: "option",
                questionId: question.id,
                optionIndex: 0,
                label: question.options[0]!.label,
                description: question.options[0]!.description
              }
        ])
      )
    : {}
  return JSON.stringify({
    status: "auto_resolved",
    answers,
    message:
      policy.autoResolutionType === "user_message"
        ? (policy.userMessage ?? "未收到用户回答，请在现有授权范围内继续。")
        : selected
          ? "按项目配置自动采用首个选项。这不是用户授权。"
          : "未收到用户回答，没有选择答案。",
    source: "project_policy"
  })
}
