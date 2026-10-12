import { z } from "zod"

/** Optional supplements; ordinary messages to an exact requester are replies. */
export const botPeerIntent = z.enum(["request", "question", "status", "result", "fyi"])
export const botPeerDispatchOptions = z
  .object({
    intent: botPeerIntent.optional(),
    priority: z.boolean().optional(),
    reply_to_run_id: z.string().min(1).max(200).optional()
  })
  .strict()
export type BotPeerDispatchOptions = z.infer<typeof botPeerDispatchOptions>
export type BotPeerDispatchIntent = z.infer<typeof botPeerIntent> | "reply"
export interface BotPeerDispatch {
  intent: BotPeerDispatchIntent
  priority: boolean
  replyToRunId: string | null
  activationScopeRunId: string | null
  manualResponseSent: boolean
  automatic: boolean
}

/** Default options must retain the original persisted receipt fingerprint. */
export function botPeerDispatchFingerprint(options: BotPeerDispatchOptions) {
  return {
    ...(options.intent ? { intent: options.intent } : {}),
    ...(options.priority === true ? { priority: true } : {}),
    ...(options.reply_to_run_id ? { reply_to_run_id: options.reply_to_run_id } : {})
  }
}

const routeId = z.string().min(1).max(200)
/** Display only the exact frozen action; malformed historical data is not a new approval. */
export const botPeerApprovalDispatch = z
  .object({
    intent: z.enum(["request", "reply", "question", "status", "result", "fyi"]),
    priority: z.boolean(),
    replyToRunId: routeId.nullable(),
    activationScopeRunId: routeId.nullable(),
    originalRequestId: routeId.nullable(),
    conversationId: routeId,
    threadRootId: routeId.nullable()
  })
  .strict()
