import { z } from "zod"

const optionSchema = z.object({
  label: z.string().min(1).max(80).describe("User-facing label, 1-5 words."),
  description: z
    .string()
    .min(1)
    .max(240)
    .describe("One short sentence explaining impact/tradeoff if selected.")
})

const questionSchema = z.object({
  header: z
    .string()
    .min(1)
    .max(12)
    .describe("Short header label shown in the UI, 12 or fewer chars."),
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/)
    .describe("Stable identifier for mapping answers, snake_case."),
  question: z.string().min(1).max(500).describe("Single-sentence prompt shown to the user."),
  options: z
    .array(optionSchema)
    .min(2)
    .max(5)
    .describe(
      "Provide 2-5 mutually exclusive choices. Put the recommended option first and suffix its label with '(Recommended)'. Do not include a free-form choice such as 'Other', 'I want to add more', or 'Custom answer'; the client adds a text entry automatically."
    )
})

const questionsSchema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(10)
    .describe("Questions to show the user. Prefer 1 and do not exceed 10.")
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

export const requestUserInputSchema = questionsSchema.superRefine(validateQuestionIds)
export const requestUserInputWithAutoResolutionSchema = questionsSchema
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
