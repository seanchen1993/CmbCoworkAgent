import { z } from "zod"

export const botModelCheckAddress = z.object({ nonce: z.string().uuid() }).strict()
export const botModelCheckInput = botModelCheckAddress
  .extend({
    modelRef: z.string().min(1).max(512).nullable(),
    kind: z.enum(["text", "tools", "vision"])
  })
  .strict()
export type BotModelCheckInput = z.infer<typeof botModelCheckInput>
export interface BotModelCheckResult {
  kind: BotModelCheckInput["kind"]
  status: "passed" | "failed"
  detail: string
  modelRef: string
  modelName: string
  model: string
  configuration: string
  checkedAt: number
  latencyMs: number
}
