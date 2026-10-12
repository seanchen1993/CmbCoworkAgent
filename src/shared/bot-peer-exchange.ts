import { z } from "zod"
import { botPeerMessageImages } from "./bot-peer-images"
import { botMessageAttachments } from "./bot-message-attachments"

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
export const botPeerExchangeAddress = z
  .object({
    conversationId: id,
    runId: id,
    threadRootId: id.optional()
  })
  .strict()
const peer = z.object({ botId: id, name: z.string().min(1).max(200) }).strict()
export const botPeerExchangeLink = z
  .object({
    anchor: botPeerExchangeAddress,
    peerRunId: id,
    mergedMessageId: id.optional(),
    direction: z.enum(["incoming", "outgoing"]),
    peer
  })
  .strict()
export const botPeerExchangeLinks = z.array(botPeerExchangeLink).max(64)
export const botPeerExchangeRequest = z
  .object({
    anchor: botPeerExchangeAddress,
    peerRunId: id,
    mergedMessageId: id.optional(),
    expectedDataEpoch: id,
    includeFiles: z.literal(true).optional()
  })
  .strict()
const message = z
  .object({
    id,
    conversationId: id,
    text: z.string().max(128_000),
    createdAt: z.number().int().nonnegative(),
    images: botPeerMessageImages,
    attachments: z.array(id).max(20).optional(),
    attachmentFiles: botMessageAttachments.optional()
  })
  .strict()
export const botPeerExchange = z
  .object({
    anchor: botPeerExchangeAddress,
    peerRunId: id,
    mergedMessageId: id.optional(),
    dataEpoch: id,
    sender: peer,
    recipient: peer,
    status: z.enum([
      "queued",
      "running",
      "waiting_input",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "needs_review"
    ]),
    revision: z.number().int().positive(),
    request: message,
    reply: message.nullable()
  })
  .strict()
export type BotPeerExchangeLink = z.infer<typeof botPeerExchangeLink>
export type BotPeerExchangeRequest = z.infer<typeof botPeerExchangeRequest>
export type BotPeerExchange = z.infer<typeof botPeerExchange>
export function botPeerExchangeKey(input: BotPeerExchangeRequest): string {
  return JSON.stringify([
    input.expectedDataEpoch,
    input.anchor.conversationId,
    input.anchor.threadRootId ?? null,
    input.anchor.runId,
    input.peerRunId,
    ...(input.mergedMessageId ? [input.mergedMessageId] : []),
    ...(input.includeFiles ? ["files"] : [])
  ])
}
