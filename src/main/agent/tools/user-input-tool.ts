import { tool } from "langchain"
import { z } from "zod"
import { requestUserInput, UserInputRequestRejectedError } from "../../services/user-input"
import type { HarnessRequestUserInputConfig } from "../../../shared/harness-board-types"

const optionSchema = z.object({
  label: z.string().min(1).max(80).describe("User-facing label, 1-5 words."),
  description: z.string().min(1).max(240).describe(
    "One short sentence explaining impact/tradeoff if selected."
  )
})

const questionSchema = z.object({
  header: z.string().min(1).max(12).describe(
    "Short header label shown in the UI, 12 or fewer chars."
  ),
  id: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/).describe(
    "Stable identifier for mapping answers, snake_case."
  ),
  question: z.string().min(1).max(500).describe(
    "Single-sentence prompt shown to the user."
  ),
  options: z.array(optionSchema).min(2).max(5).describe(
    "Provide 2-5 mutually exclusive choices. Put the recommended option first and suffix its label with '(Recommended)'. Do not include an 'Other' option; the client adds free-form Other automatically."
  )
})

const questionsSchema = z.object({
  questions: z.array(questionSchema).min(1).max(10).describe(
    "Questions to show the user. Prefer 1 and do not exceed 10."
  )
})

function validateQuestionIds(
  input: { questions: Array<{ id: string }> },
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>()
  input.questions.forEach((question, index) => {
    if (seen.has(question.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions", index, "id"],
        message: `Duplicate question id: ${question.id}`
      })
    }
    seen.add(question.id)
  })
}

const requestUserInputSchema = questionsSchema.superRefine(validateQuestionIds)
const requestUserInputWithAutoResolutionSchema = questionsSchema
  .extend({
    autoResolutionMs: z
      .number()
      .int()
      .min(30_000)
      .max(240_000)
      .optional()
      .describe(
        "Automatically resolve after 30,000-240,000 milliseconds when the question is useful but non-blocking. Omit this when explicit user input is required."
      )
  })
  .superRefine(validateQuestionIds)

interface RequestUserInputToolContext {
  threadId: string
  abortSignal?: AbortSignal
  requestUserInputConfig?: HarnessRequestUserInputConfig
}

export function createRequestUserInputTool(context: RequestUserInputToolContext) {
  const allowAutoResolution = context.requestUserInputConfig?.allowAutoResolution !== false
  const schema = allowAutoResolution
    ? requestUserInputWithAutoResolutionSchema
    : requestUserInputSchema

  return tool(
    async (input) => {
      try {
        const modelTimeout =
          "autoResolutionMs" in input && typeof input.autoResolutionMs === "number"
            ? input.autoResolutionMs
            : undefined
        const autoResolutionMs = allowAutoResolution
          ? (modelTimeout ?? context.requestUserInputConfig?.defaultTimeoutMs)
          : undefined
        const autoResolutionType = context.requestUserInputConfig
          ? context.requestUserInputConfig.autoResolutionType
          : "user_message"
        const userMessage =
          context.requestUserInputConfig?.userMessage ??
          "The user did not answer within the configured time. Do not infer or assume any option selections; continue with your best judgment."
        const response = await requestUserInput({
          threadId: context.threadId,
          questions: input.questions,
          autoResolutionMs,
          autoResolution: {
            type: autoResolutionType,
            message: userMessage
          },
          abortSignal: context.abortSignal
        })
        if ("autoResolved" in response) {
          return JSON.stringify(
            {
              status: "auto_resolved",
              requestId: response.requestId,
              answers: response.answers,
              ...(response.message ? { message: response.message } : {})
            },
            null,
            2
          )
        }
        if (response.ignored) {
          return JSON.stringify({
            status: "ignored",
            requestId: response.requestId,
            submittedAt: response.submittedAt,
            answers: {},
            message:
              "The user ignored this request and did not provide answers. Do not infer or assume any option selections."
          }, null, 2)
        }
        return JSON.stringify({
          status: "submitted",
          requestId: response.requestId,
          submittedAt: response.submittedAt,
          answers: response.answers
        }, null, 2)
      } catch (error) {
        if (error instanceof UserInputRequestRejectedError) {
          return JSON.stringify({
            status: "rejected",
            code: error.code,
            reason: error.message
          }, null, 2)
        }
        return JSON.stringify({
          status: "cancelled",
          error: error instanceof Error ? error.message : String(error)
        }, null, 2)
      }
    },
    {
      name: "request_user_input",
      description: allowAutoResolution
        ? "Request user input for one to ten short questions and wait for the response, with optional automatic resolution for non-blocking questions."
        : "Request user input for one to ten short questions and wait for the user's response.",
      schema
    }
  )
}
