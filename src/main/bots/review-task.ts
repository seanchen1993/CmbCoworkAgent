import { z } from "zod"
import { botAutoReviewPolicy } from "../../shared/bot-auto-review"

const message = z.object({ id: z.string(), text: z.string() }).strict()
const delegation = z
  .object({
    parentRunId: z.string(),
    assignment: z.string(),
    role: z.string().nullable(),
    roleInstructions: z.string().nullable(),
    model: z.string().nullable(),
    shellAccess: z.string(),
    disallowedTools: z.array(z.string()),
    isolation: z.string().nullable(),
    agentNotes: z.array(message)
  })
  .strict()

export const botReviewTaskSchema = z
  .object({
    source: z.string(),
    messages: z.array(message),
    rejectedActions: z.array(z.object({ prompt: z.string() }).strict()),
    skillTrial: z
      .object({ id: z.string(), skillId: z.string(), version: z.number().int().positive() })
      .strict()
      .optional(),
    priorContext: z
      .object({
        messages: z
          .array(message.extend({ eventCursor: z.number().int().positive().nullable() }))
          .max(200),
        rejectedActions: z
          .array(
            z
              .object({
                id: z.string(),
                runId: z.string(),
                prompt: z.string(),
                eventCursor: z.number().int().positive().nullable()
              })
              .strict()
          )
          .max(200),
        refusalsTruncated: z.boolean()
      })
      .strict()
      .optional(),
    peer: z
      .object({
        reviewerBotId: z.string(),
        handoffs: z
          .array(
            z
              .object({
                fromBotId: z.string(),
                toBotId: z.string(),
                assignment: z.string(),
                sourceDelegation: delegation.optional(),
                recipient: z
                  .object({
                    name: z.string(),
                    instructions: z.string(),
                    workspacePath: z.string().nullable(),
                    modelRef: z.string().nullable(),
                    connectorIds: z.array(z.string())
                  })
                  .strict(),
                reviewPolicy: botAutoReviewPolicy
              })
              .strict()
          )
          .min(1)
          .max(8)
      })
      .strict()
      .optional(),
    delegation: delegation.optional(),
    routine: z
      .object({
        id: z.string(),
        authorizationId: z.string(),
        name: z.string(),
        prompt: z.string(),
        schedule: z.unknown(),
        timezone: z.string(),
        origin: z.enum(["human", "delegated"]),
        trigger: z.enum(["manual", "scheduled", "event"]),
        eventData: z.string().optional()
      })
      .strict()
      .optional()
  })
  .strict()
export type BotReviewTask = z.infer<typeof botReviewTaskSchema>
