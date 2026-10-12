import { z } from "zod"
import type { FunctionPaneSnapshot } from "./mods/v2/ui"
import type { ModJson } from "./mods/types"
import { encodeModJson } from "./mods/validation"

const id = z.string().min(1).max(160)
const intent = z.string().regex(/^[\w-]{16,100}$/)
// Electron's structured clone preserves explicit undefined properties, whereas
// persisted JSON omits them. Normalize optional fields before receipt hashing.
function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
const address = {
  botId: id,
  conversationId: id,
  threadRootId: id.optional()
}
export const botPluginPaneAddress = z.object(address).strict()
export type BotPluginPaneAddress = z.infer<typeof botPluginPaneAddress>
const paneAction = z
  .object({
    ...address,
    target: z.literal("pane"),
    sessionId: z.string().uuid(),
    action: z
      .object({
        pane: z.string().min(1).max(200),
        generation: z.string().uuid(),
        intentId: intent,
        plugin: z.string().min(1).max(100),
        handle: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        kind: z.enum(["press", "change", "submit", "select", "close"]),
        value: z.string().max(10_000).optional()
      })
      .strict()
      .transform(omitUndefined)
  })
  .strict()
const clientAction = z
  .object({
    ...address,
    target: z.literal("client"),
    sessionId: z.string().uuid(),
    generation: z.string().uuid(),
    action: z
      .object({
        pane: z.string().min(1).max(200),
        instance: z.string().min(1).max(160),
        intentId: intent,
        kind: z.enum(["press", "change", "submit", "select", "key", "pointer", "resize"]),
        handle: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        value: z
          .custom<ModJson>((value) => {
            try {
              return encodeModJson(value).length <= 32_000
            } catch {
              return false
            }
          })
          .optional()
      })
      .strict()
      .transform(omitUndefined)
  })
  .strict()
export const botPluginPaneAction = z
  .discriminatedUnion("target", [paneAction, clientAction])
  .transform(omitUndefined)
export type BotPluginPaneAction = z.infer<typeof botPluginPaneAction>

/** These events carry presentation input, never user authority for SDK effects. */
export function isBotPluginPresentationAction(input: BotPluginPaneAction): boolean {
  return ["change", "pointer", "resize"].includes(input.action.kind)
}

export interface BotPluginPaneView {
  sessionId: string | null
  revision: number
  busy: boolean
  panes: FunctionPaneSnapshot[]
  error?: string
}

export function botPluginSessionKey(address: BotPluginPaneAddress, childRunId?: string): string {
  return JSON.stringify([
    address.botId,
    address.conversationId,
    address.threadRootId ?? null,
    childRunId ?? null
  ])
}
