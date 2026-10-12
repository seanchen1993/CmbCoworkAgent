import { createHash } from "node:crypto"
import { z } from "zod"
import type { BotStore } from "./store"

export const BOT_SESSION_END_KEY = "lifecycle:session-end"
export const BOT_STOP_FAILURE_KEY = "lifecycle:stop-failure"

const activation = z.object({
  invocation: z.string(),
  trigger: z.enum(["explicit", "read_file"]),
  toolName: z.string(),
  notes: z.array(z.string())
})
export const skillCompletionReceipt = z.object({
  invocation: z.string(),
  result: z
    .object({
      exitCode: z.number().int().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      blocked: z.boolean(),
      decision: z.enum(["approve", "block"]).optional(),
      reason: z.string().optional(),
      continue: z.boolean().optional(),
      stopReason: z.string().optional(),
      additionalContext: z.string().optional(),
      systemMessage: z.string().optional()
    })
    .nullable()
})

export function skillLifecycleKey(id: string, version: number, phase = "activation"): string {
  return `skill-${phase}:${createHash("sha256")
    .update(JSON.stringify([id, version]))
    .digest("hex")}`
}

/** Only Host-generated lifecycle keys may read these receipts. External callers
 * cannot name receipts or bypass the task's current skill/version validation. */
export function readSkillHookReceipt(store: BotStore, runId: string, key: string): unknown {
  const raw = store.db.exec("SELECT response FROM bot_receipts WHERE nonce=?", [
    `tool:${runId}:${key}`
  ])[0]?.values[0]?.[0]
  return typeof raw === "string" ? JSON.parse(raw) : undefined
}

export function readSkillActivation(store: BotStore, runId: string, id: string, version: number) {
  const value = readSkillHookReceipt(store, runId, skillLifecycleKey(id, version))
  return value === undefined ? undefined : activation.parse(value)
}
