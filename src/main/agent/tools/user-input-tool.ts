import { tool } from "langchain"
import { z } from "zod"
import { requestUserInput } from "../../services/user-input"

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

const requestUserInputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(10).describe(
    "Questions to show the user. Prefer 1 and do not exceed 10."
  )
}).superRefine((input, ctx) => {
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
})

interface RequestUserInputToolContext {
  threadId: string
  abortSignal?: AbortSignal
}

export function createRequestUserInputTool(context: RequestUserInputToolContext) {
  return tool(
    async (input) => {
      try {
        const response = await requestUserInput({
          threadId: context.threadId,
          questions: input.questions,
          abortSignal: context.abortSignal
        })
        return JSON.stringify({
          status: "submitted",
          requestId: response.requestId,
          submittedAt: response.submittedAt,
          answers: response.answers
        }, null, 2)
      } catch (error) {
        return JSON.stringify({
          status: "cancelled",
          error: error instanceof Error ? error.message : String(error)
        }, null, 2)
      }
    },
    {
      name: "request_user_input",
      description:
        "Request user input for one to ten short questions and wait indefinitely for the response. The UI shows each question with 2-5 choices and adds a free-form Other option automatically. Returns JSON keyed by each question id.",
      schema: requestUserInputSchema
    }
  )
}
