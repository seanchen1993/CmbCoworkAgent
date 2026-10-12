import { z } from "zod"

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
export const botApprovalRuleChange = z
  .object({
    botId: id,
    ruleId: id,
    revision: z.number().int().nonnegative(),
    nonce: id,
    dataEpoch: z.string().min(1).max(160),
    behavior: z.enum(["allow", "ask", "deny"]).nullable()
  })
  .strict()

export interface BotApprovalRule {
  id: string
  title: string
  prompt: string
  behavior: "allow" | "ask" | "deny"
  createdAt: number
}
export interface BotApprovalRules {
  botId: string
  revision: number
  dataEpoch: string
  rules: BotApprovalRule[]
}
export interface BotApprovalReview {
  /** Only Host-created, eligible requests expose this choice. */
  canRemember: boolean
  /** A permanent refusal remains available when automatic approval is disabled. */
  canDeny?: boolean
  ruleTitle: string
  source: "user" | "rule"
  remembered: boolean
}
export type BotApprovalRuleChange = z.infer<typeof botApprovalRuleChange>
