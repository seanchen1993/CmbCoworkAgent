import { z } from "zod"
import { questionSchema } from "./user-input-schema"

export const BOT_USER_FORM_MAX_BYTES = 24 * 1024
const MAX_VALUE_LENGTH = 2000
const encoder = new TextEncoder()
const reservedIds = new Set(["constructor", "prototype", "__proto__"])

function parseFormJson(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    // Validate the original JSON keys before schema materialization can omit
    // a dangerous object key. No field/control/value is echoed into errors.
    if (reservedIds.has(key)) throw new Error("表单 JSON 包含无效字段")
    return value
  })
}

function withinBudget(text: string): boolean {
  return (
    text.length <= BOT_USER_FORM_MAX_BYTES &&
    encoder.encode(text).byteLength <= BOT_USER_FORM_MAX_BYTES
  )
}

const field = z.object({
  id: questionSchema.shape.id
    .max(80)
    .refine((id) => !reservedIds.has(id), "请使用具体字段名称作为 ID"),
  label: z.string().max(160).trim().min(1),
  required: z.boolean().optional(),
  placeholder: z.string().max(160).optional()
})
const option = z
  .object({
    value: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => value.trim().length > 0),
    label: z.string().max(160).trim().min(1)
  })
  .strict()
const fieldSchema = z.discriminatedUnion("type", [
  field.extend({ type: z.literal("text") }).strict(),
  field.extend({ type: z.literal("textarea") }).strict(),
  field.extend({ type: z.literal("date") }).strict(),
  field.extend({ type: z.literal("number") }).strict(),
  field.extend({ type: z.literal("email") }).strict(),
  field.extend({ type: z.literal("tel") }).strict(),
  field
    .extend({
      type: z.literal("select"),
      options: z.array(option).min(2).max(30)
    })
    .strict()
])

/** Ordinary information only. Credentials use the existing secure card or human takeover. */
export const botUserFormSchema = z
  .object({
    title: z.string().max(160).trim().min(1),
    description: z.string().max(1000).optional(),
    fields: z.array(fieldSchema).min(1).max(10)
  })
  .strict()
  .superRefine((input, context) => {
    const ids = new Set<string>()
    input.fields.forEach((item, index) => {
      if (ids.has(item.id))
        context.addIssue({
          code: "custom",
          path: ["fields", index, "id"],
          message: "字段 ID 不能重复"
        })
      ids.add(item.id)
      if (item.type !== "select") return
      const values = new Set<string>()
      item.options.forEach((entry, optionIndex) => {
        if (values.has(entry.value))
          context.addIssue({
            code: "custom",
            path: ["fields", index, "options", optionIndex, "value"],
            message: "选项值不能重复"
          })
        values.add(entry.value)
      })
    })
    if (!withinBudget(JSON.stringify(input)))
      context.addIssue({
        code: "custom",
        message: "表单内容超过 24 KiB"
      })
  })
export type BotUserForm = z.infer<typeof botUserFormSchema>
type FormField = BotUserForm["fields"][number]

export const botUserFormCardSchema = z
  .object({
    botUserForm: z
      .object({
        version: z.literal(1),
        dataEpoch: z.string().min(1).max(160),
        input: botUserFormSchema
      })
      .strict()
  })
  .strict()
  .superRefine((card, context) => {
    if (!withinBudget(JSON.stringify(card)))
      context.addIssue({
        code: "custom",
        message: "表单请求超过 24 KiB"
      })
  })
export type BotUserFormCard = z.infer<typeof botUserFormCardSchema>["botUserForm"]

/** Host stamps its epoch at the trusted creation entry; this helper grants no authority. */
export function createBotUserFormPrompt(input: BotUserForm, dataEpoch: string): string {
  return JSON.stringify(
    botUserFormCardSchema.parse({ botUserForm: { version: 1, dataEpoch, input } })
  )
}

/** Keep unsupported/malformed markers separate from the ordinary question fallback. */
export function hasBotUserFormMarker(prompt: string): boolean {
  if (prompt.length <= 64_000) {
    try {
      const value: unknown = JSON.parse(prompt)
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.hasOwn(value, "botUserForm")
      )
    } catch {
      // The expected card wrapper owns this first key even if its body is malformed.
    }
  }
  return /^\s*\{\s*"botUserForm"\s*:/.test(prompt)
}

export function readBotUserForm(prompt: string): BotUserFormCard | null {
  if (!withinBudget(prompt)) return null
  try {
    return botUserFormCardSchema.safeParse(parseFormJson(prompt)).data?.botUserForm ?? null
  } catch {
    return null
  }
}

function normalizedValue(item: FormField, value: string): string {
  return item.type === "select" ? value : value.trim()
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]!
}

/** Used by both field UI and durable answer validation; never includes the supplied value. */
export function botUserFormValueError(item: FormField, raw: string | undefined): string | null {
  if (raw !== undefined && raw.length > MAX_VALUE_LENGTH) return "字段内容不能超过 2000 字符"
  const value = raw === undefined ? "" : normalizedValue(item, raw)
  if (!value.trim()) return item.required ? `请填写“${item.label}”` : null
  if (item.type === "select")
    return item.options.some((entry) => entry.value === value) ? null : `请重新选择“${item.label}”`
  if (item.type === "date" && !validDate(value)) return `“${item.label}”需要有效的 YYYY-MM-DD 日期`
  if (
    item.type === "number" &&
    (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
      !Number.isFinite(Number(value)))
  )
    return `“${item.label}”需要有限的十进制数值`
  if (
    item.type === "email" &&
    (/\s/.test(value) ||
      Array.from(value).some((character) => {
        const point = character.codePointAt(0)!
        return point <= 31 || point === 127
      }) ||
      !/^[^@]+@[^@]+$/.test(value))
  )
    return `“${item.label}”需要有效的邮箱地址`
  return null
}

const answerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled"), values: z.object({}).strict() }).strict(),
  z
    .object({
      status: z.literal("submitted"),
      // All answer ids must follow the same contract as the original fields.
      values: z.record(field.shape.id, z.string().max(MAX_VALUE_LENGTH))
    })
    .strict()
])

/** Canonical answers follow the original field order for exact CAS/retry identity. */
export function validateBotUserFormAnswer(input: BotUserForm, raw: string): string {
  const original = botUserFormSchema.parse(input)
  if (!withinBudget(raw)) throw new Error("表单回答超过 24 KiB")
  let parsed: z.infer<typeof answerSchema>
  try {
    parsed = answerSchema.parse(parseFormJson(raw))
  } catch {
    throw new Error("表单回答格式无效，请在原卡片中填写或取消")
  }
  if (parsed.status === "cancelled") return JSON.stringify(parsed)
  const allowed = new Set(original.fields.map((item) => item.id))
  if (Object.keys(parsed.values).some((id) => !allowed.has(id))) throw new Error("回答包含未知字段")
  const values = Object.fromEntries(
    original.fields.flatMap((item) => {
      const value = Object.hasOwn(parsed.values, item.id) ? parsed.values[item.id] : undefined
      const error = botUserFormValueError(item, value)
      if (error) throw new Error(error)
      return value === undefined || !value.trim() ? [] : [[item.id, normalizedValue(item, value)]]
    })
  )
  const answer = JSON.stringify({ status: "submitted", values })
  if (!withinBudget(answer)) throw new Error("表单回答超过 24 KiB")
  return answer
}

/** Only validated ordinary values enter the existing user confirmation/history. */
export function formatBotUserFormAnswer(input: BotUserForm, raw: string): string {
  const original = botUserFormSchema.parse(input)
  const parsed = answerSchema.parse(JSON.parse(validateBotUserFormAnswer(original, raw)))
  if (parsed.status === "cancelled") return `已取消填写，未提供任何字段信息。\n\n${original.title}`
  const entries = original.fields.flatMap((item) => {
    const value = parsed.values[item.id]
    if (value === undefined) return []
    const visible =
      item.type === "select" ? item.options.find((entry) => entry.value === value)!.label : value
    return [`${item.label}\n${visible}`]
  })
  return `补充信息 · ${original.title}\n\n${entries.length ? entries.join("\n\n") : "未提供可选字段信息。"}`
}
