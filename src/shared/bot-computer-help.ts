import { z } from "zod"
import { botNativeDesktopTarget } from "./bot-native-desktop"

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const botComputerHelpRequest = z
  .object({
    backend: z.enum(["browser", "windows-native"]),
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(800)
      .refine((value) => !/[\r\n\0]/.test(value)),
    reason: z.enum(["auth", "captcha", "payment", "other"]).default("other")
  })
  .strict()
export const botComputerHelpCard = botComputerHelpRequest
  .extend({
    version: z.literal(1),
    hostId: id,
    dataEpoch: id,
    botId: id,
    runId: id,
    conversationId: id,
    threadRootId: id.optional(),
    taskRunId: id.optional(),
    generation: z.string().uuid(),
    runFence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    controlEpoch: counter
  })
  .strict()
export type BotComputerHelpCard = z.infer<typeof botComputerHelpCard>
const browserTarget = z
  .object({
    botId: id,
    taskRunId: id.optional(),
    generation: z.string().uuid(),
    controlEpoch: counter,
    control: z.enum(["bot", "human", "handoff"]),
    viewId: z.string().uuid()
  })
  .strip()
export const botComputerHelpReturn = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("browser"), target: browserTarget }).strict(),
  z
    .object({
      backend: z.literal("windows-native"),
      target: botNativeDesktopTarget
    })
    .strict()
])
export type BotComputerHelpReturn = z.infer<typeof botComputerHelpReturn>

export function writeBotComputerHelp(card: BotComputerHelpCard): string {
  return JSON.stringify({ botComputerHelp: botComputerHelpCard.parse(card) })
}
export function readBotComputerHelp(text: string): BotComputerHelpCard | null {
  if (text.length > 4096 || !text.startsWith("{")) return null
  try {
    const parsed = z
      .object({ botComputerHelp: botComputerHelpCard })
      .strict()
      .safeParse(JSON.parse(text))
    return parsed.success ? parsed.data.botComputerHelp : null
  } catch {
    return null
  }
}
export function formatBotComputerHelpAnswer(card: BotComputerHelpCard, answer: string): string {
  return `${card.instruction}\n\n${answer === "done" ? "人工操作已完成，已归还 Bot 控制权。" : "已取消本次人工帮助，未确认操作完成。"}`
}
