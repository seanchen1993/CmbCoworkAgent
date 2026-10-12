import { z } from "zod"
import { botEventPolicy } from "../../../shared/bot-event-state"
import { createProtectedSavePending } from "./bot-protected-save-pending"
import type { BotSaveRoutineInput } from "../../../shared/bot-routines"
import { botSkillSelections } from "../../../shared/bot-skill-references"

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const request = z
  .object({
    nonce: identifier,
    expectedDataEpoch: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => !value.includes("\0"))
      .optional(),
    botId: identifier,
    id: identifier.optional(),
    revision: z.number().int().positive().optional(),
    name: z.string().min(1).max(100),
    prompt: z.string().min(1).max(64_000),
    timezone: z.string().min(1).max(100),
    enabled: z.boolean(),
    desiredEnabled: z.boolean().optional(),
    skills: botSkillSelections.optional(),
    schedule: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("once"), at: z.number().int().positive() }).strict(),
      z
        .object({
          kind: z.literal("interval"),
          anchor: z.number().int().positive(),
          everyMs: z
            .number()
            .int()
            .min(60_000)
            .max(366 * 86_400_000)
        })
        .strict(),
      z
        .object({
          kind: z.literal("cron"),
          expression: z.string().min(1).max(200)
        })
        .strict(),
      z
        .object({
          kind: z.literal("event"),
          topic: identifier,
          eventPolicy: botEventPolicy.optional()
        })
        .strict()
    ])
  })
  .strict()
const record = z
  .object({ dataEpoch: z.string(), input: request })
  .strict()
  .refine((value) => Boolean(value.input.id) === Boolean(value.input.revision))
  .refine(
    (value) =>
      value.input.expectedDataEpoch === undefined ||
      value.input.expectedDataEpoch === value.dataEpoch
  )
const key = (botId: string, id?: string) => `bot-routine-pending:${botId}:${id ?? "new"}`

/** As with composer drafts, keep only the current unacknowledged save for this editor. */
const pending = createProtectedSavePending<BotSaveRoutineInput>({
  record: record as z.ZodType<{
    dataEpoch: string
    input: BotSaveRoutineInput
  }>,
  input: request as z.ZodType<BotSaveRoutineInput>,
  key: (input) => key(input.botId, input.id),
  maxCharacters: 400_000,
  oversizeMessage: "例程保存记录过大，本次操作尚未提交。请缩短输入内容。",
  storageMessage: "无法保留例程保存记录，请恢复应用存储访问后重试。本次操作尚未提交。"
})

export function inspectPendingRoutine(botId: string, id: string | undefined, dataEpoch: string) {
  const value = pending.inspect(key(botId, id), dataEpoch)
  if (
    (value.kind === "valid" || value.kind === "obsolete") &&
    (value.input.botId !== botId ||
      value.input.id !== id ||
      Boolean(value.input.id) !== Boolean(value.input.revision))
  )
    return { kind: "corrupt" as const, raw: value.raw }
  return value
}

export function readPendingRoutine(
  botId: string,
  id: string | undefined,
  dataEpoch: string
): BotSaveRoutineInput | null {
  const value = inspectPendingRoutine(botId, id, dataEpoch)
  return value.kind === "valid" ? value.input : null
}

export function rememberPendingRoutine(input: BotSaveRoutineInput, dataEpoch: string): void {
  pending.remember(input, dataEpoch)
}

export function acknowledgePendingRoutine(input: BotSaveRoutineInput, dataEpoch: string): boolean {
  return pending.acknowledge(input, dataEpoch)
}

export function discardPendingRoutine(
  botId: string,
  id: string | undefined,
  dataEpoch: string,
  raw: string
): boolean {
  return pending.discard(key(botId, id), dataEpoch, raw)
}

const rejectedRoutineSaveCodes = new Set([
  "invalid_input",
  "invalid_schedule",
  "revision_conflict",
  "not_found",
  "routine_limit",
  "nonce_conflict",
  "skill_changed",
  "skill_unavailable",
  "skill_unverified",
  "skill_scope",
  "skill_catalog_unavailable",
  "approval_required"
])

/** Only an explicit Host rejection proves that a save was not accepted. */
export function isDefinitiveRoutineSaveError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    rejectedRoutineSaveCodes.has(error.code)
  )
}
