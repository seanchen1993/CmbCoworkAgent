import { z } from "zod"

const contentPart = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.object({ url: z.string() }).optional()
  })
  .passthrough()
export const testModelRequest = z
  .object({
    stream: z.boolean().optional(),
    messages: z.array(
      z
        .object({
          role: z.string(),
          content: z
            .union([z.string(), z.array(contentPart)])
            .nullable()
            .optional()
        })
        .passthrough()
    ),
    tools: z
      .array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough())
      .default([])
  })
  .passthrough()
export type TestModelRequest = z.infer<typeof testModelRequest>
