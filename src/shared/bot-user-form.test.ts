import { describe, expect, it } from "vitest"
import {
  BOT_USER_FORM_MAX_BYTES,
  botUserFormSchema,
  botUserFormValueError,
  createBotUserFormPrompt,
  formatBotUserFormAnswer,
  hasBotUserFormMarker,
  readBotUserForm,
  validateBotUserFormAnswer,
  type BotUserForm
} from "./bot-user-form"

const form = (fields: BotUserForm["fields"]): BotUserForm => ({ title: "发布信息", fields })
const submitted = (values: Record<string, unknown>): string =>
  JSON.stringify({ status: "submitted", values })
const select: BotUserForm["fields"][number] = {
  id: "branch",
  label: "分支",
  type: "select",
  required: true,
  options: [
    { value: "main", label: "主分支" },
    { value: " feature ", label: "特性分支" }
  ]
}

describe("ordinary typed form source contract", () => {
  it.each([
    ["text", "  研发团队  ", "研发团队"],
    ["textarea", "  第一行\n第二行  ", "第一行\n第二行"],
    ["date", "  2000-02-29  ", "2000-02-29"],
    ["number", "  0  ", "0"],
    ["email", "  dev@example.test  ", "dev@example.test"],
    ["tel", "  +86 (021) 1234-5678  ", "+86 (021) 1234-5678"]
  ] as const)(
    "validates %s identically for field UI and durable answer",
    (type, value, normalized) => {
      const item = { id: "value", label: "业务信息", type, required: true }
      expect(botUserFormValueError(item, value)).toBeNull()
      expect(validateBotUserFormAnswer(form([item]), submitted({ value }))).toBe(
        submitted({ value: normalized })
      )
    }
  )

  it("uses exact original select values and original labels", () => {
    expect(botUserFormValueError(select, " feature ")).toBeNull()
    expect(validateBotUserFormAnswer(form([select]), submitted({ branch: " feature " }))).toBe(
      submitted({ branch: " feature " })
    )
    expect(botUserFormValueError(select, "feature")).not.toBeNull()
    expect(() =>
      validateBotUserFormAnswer(form([select]), submitted({ branch: " main " }))
    ).toThrow("选择")
    expect(() =>
      validateBotUserFormAnswer(form([select]), submitted({ branch: "主分支" }))
    ).toThrow("选择")
    expect(formatBotUserFormAnswer(form([select]), submitted({ branch: "main" }))).toBe(
      "补充信息 · 发布信息\n\n分支\n主分支"
    )
  })

  it("keeps canonical original field order, optional omissions and numeric precision", () => {
    const input = form([
      { id: "count", label: "数量", type: "number", required: true },
      { id: "note", label: "说明", type: "textarea" },
      { id: "owner", label: "负责人", type: "text", required: true }
    ])
    const first = validateBotUserFormAnswer(
      input,
      submitted({ owner: "A", note: "  ", count: "9007199254740993" })
    )
    expect(first).toBe(submitted({ count: "9007199254740993", owner: "A" }))
    expect(
      validateBotUserFormAnswer(input, submitted({ count: "9007199254740993", owner: " A " }))
    ).toBe(first)
    expect(formatBotUserFormAnswer(input, first)).not.toContain("说明")
    expect(
      validateBotUserFormAnswer(form([{ id: "note", label: "说明", type: "text" }]), submitted({}))
    ).toBe(submitted({}))
  })

  it("requires explicit cancellation without any answer values", () => {
    const input = form([{ id: "owner", label: "负责人", type: "text", required: true }])
    const cancelled = JSON.stringify({ status: "cancelled", values: {} })
    expect(validateBotUserFormAnswer(input, cancelled)).toBe(cancelled)
    expect(formatBotUserFormAnswer(input, cancelled)).toBe(
      "已取消填写，未提供任何字段信息。\n\n发布信息"
    )
    expect(() =>
      validateBotUserFormAnswer(
        input,
        JSON.stringify({ status: "cancelled", values: { owner: "A" } })
      )
    ).toThrow("格式")
    expect(() => validateBotUserFormAnswer(input, submitted({}))).toThrow("负责人")
    expect(() => validateBotUserFormAnswer(input, submitted({ owner: "   " }))).toThrow("负责人")
  })

  it.each([
    "1900-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "0000-01-01",
    "2026-1-01",
    "2026-01-00",
    "2026-01-01T00:00:00Z"
  ])("rejects invalid calendar date %s without Date/timezone coercion", (value) => {
    const item = { id: "day", label: "日期", type: "date" as const }
    expect(botUserFormValueError(item, value)).not.toBeNull()
    expect(() => validateBotUserFormAnswer(form([item]), submitted({ day: value }))).toThrow("日期")
  })

  it("accepts Gregorian leap rules and finite decimal syntax while preserving strings", () => {
    const day = { id: "day", label: "日期", type: "date" as const }
    for (const value of ["0001-01-01", "2024-02-29", "2000-02-29", "9999-12-31"])
      expect(botUserFormValueError(day, value)).toBeNull()
    const number = { id: "count", label: "数量", type: "number" as const }
    for (const value of ["0", "-0", "+.5", "-1.00", "1e3", "001", "1."])
      expect(validateBotUserFormAnswer(form([number]), submitted({ count: value }))).toBe(
        submitted({ count: value })
      )
    for (const value of ["Infinity", "NaN", "0x1", "1_000", "1 extra", "1e9999", ".", "--1"])
      expect(botUserFormValueError(number, value)).not.toBeNull()
  })

  it("uses one shared basic email rule instead of browser locale validation", () => {
    const email = { id: "mail", label: "邮箱", type: "email" as const }
    expect(botUserFormValueError(email, "name+tag@domain")).toBeNull()
    for (const value of [
      "@domain",
      "name@",
      "a@@domain",
      "name domain",
      "a b@domain",
      "a\u0000@domain"
    ])
      expect(botUserFormValueError(email, value)).not.toBeNull()
  })

  it("rejects unknown answer ids, non-string values and client option labels", () => {
    const input = form([select])
    for (const values of [
      { branch: "main", foreign: "x" },
      { branch: 0 },
      { branch: false },
      { branch: null },
      { branch: { value: "main", label: "Approved" } }
    ])
      expect(() => validateBotUserFormAnswer(input, submitted(values))).toThrow()
    expect(() =>
      validateBotUserFormAnswer(
        input,
        '{"status":"submitted","values":{"branch":"main","__proto__":"x"}}'
      )
    ).toThrow()
    for (const key of ["constructor", "prototype", "has space"])
      expect(() =>
        validateBotUserFormAnswer(input, submitted({ branch: "main", [key]: "x" }))
      ).toThrow()
    expect(() =>
      validateBotUserFormAnswer(input, '{"status":"cancelled","values":{"__proto__":"x"}}')
    ).toThrow()
    expect(() =>
      validateBotUserFormAnswer(
        input,
        '{"status":"submitted","values":{"branch":"main"},"label":"Forged"}'
      )
    ).toThrow("格式")
  })

  it("rejects secret types and properties without exposing a secret input channel", () => {
    for (const type of ["password", "otp", "secret", "checkbox", "html"])
      expect(
        botUserFormSchema.safeParse(form([{ id: "value", label: "信息", type } as never])).success
      ).toBe(false)
    const item = { id: "value", label: "信息", type: "text" }
    for (const extra of [
      { secret: true },
      { secret: false },
      { options: [] },
      { html: "<input>" },
      { regex: ".*" },
      { browserRef: "password" }
    ])
      expect(
        botUserFormSchema.safeParse({ title: "信息", fields: [{ ...item, ...extra }] }).success
      ).toBe(false)
    expect(
      botUserFormSchema.safeParse({ title: "信息", fields: [item], dataEpoch: "model-epoch" })
        .success
    ).toBe(false)
  })

  it("rejects invalid/duplicate field ids and duplicate/empty/oversized select choices", () => {
    for (const id of [
      "constructor",
      "prototype",
      "__proto__",
      "Field",
      "has space",
      "x".repeat(81)
    ])
      expect(botUserFormSchema.safeParse(form([{ id, label: "字段", type: "text" }])).success).toBe(
        false
      )
    expect(
      botUserFormSchema.safeParse(form([select, { id: "branch", label: "同 ID", type: "text" }]))
        .success
    ).toBe(false)
    for (const options of [
      [],
      [{ value: "main", label: "Main" }],
      [
        { value: "main", label: "A" },
        { value: "main", label: "B" }
      ],
      [
        { value: "", label: "A" },
        { value: "b", label: "B" }
      ],
      [
        { value: " ", label: "A" },
        { value: "b", label: "B" }
      ],
      Array.from({ length: 31 }, (_, index) => ({ value: `${index}`, label: `${index}` }))
    ])
      expect(botUserFormSchema.safeParse(form([{ ...select, options }])).success).toBe(false)
  })

  it("bounds original field/definition lengths and seven field catalog counts", () => {
    const text = { id: "value", label: "字段", type: "text" as const }
    expect(botUserFormSchema.safeParse(form([])).success).toBe(false)
    expect(
      botUserFormSchema.safeParse(
        form(Array.from({ length: 11 }, (_, index) => ({ ...text, id: `f${index}` })))
      ).success
    ).toBe(false)
    expect(
      botUserFormSchema.safeParse({ ...form([text]), title: " ".repeat(160) + "A" }).success
    ).toBe(false)
    expect(
      botUserFormSchema.safeParse({ ...form([text]), description: "x".repeat(1001) }).success
    ).toBe(false)
    expect(
      botUserFormSchema.safeParse(form([{ ...text, placeholder: "x".repeat(161) }])).success
    ).toBe(false)
    expect(botUserFormValueError(text, "x".repeat(2001))).not.toBeNull()
    expect(() =>
      validateBotUserFormAnswer(form([text]), submitted({ value: "x".repeat(2001) }))
    ).toThrow()
  })

  it("enforces UTF-8 request and answer byte budgets independent of UTF-16 limits", () => {
    const input = form(
      Array.from({ length: 10 }, (_, index) => ({
        id: `f${index}`,
        label: "选择",
        type: "select" as const,
        options: Array.from({ length: 30 }, (_, choice) => ({
          value: `${choice}`,
          label: "中".repeat(160)
        }))
      }))
    )
    expect(botUserFormSchema.safeParse(input).success).toBe(false)
    expect(() => createBotUserFormPrompt(input, "initial")).toThrow()
    const text = form(
      Array.from({ length: 5 }, (_, index) => ({
        id: `f${index}`,
        label: "说明",
        type: "text" as const
      }))
    )
    const values = Object.fromEntries(text.fields.map((item) => [item.id, "中".repeat(2000)]))
    expect(submitted(values).length).toBeLessThan(BOT_USER_FORM_MAX_BYTES)
    expect(() => validateBotUserFormAnswer(text, submitted(values))).toThrow("24 KiB")
    expect(() =>
      validateBotUserFormAnswer(text, " ".repeat(BOT_USER_FORM_MAX_BYTES) + submitted({}))
    ).toThrow("24 KiB")
  })

  it("roundtrips the Host epoch while unsupported/malformed markers stay fail closed", () => {
    const input = form([select])
    const prompt = createBotUserFormPrompt(input, "workspace-epoch")
    expect(hasBotUserFormMarker(prompt)).toBe(true)
    expect(readBotUserForm(prompt)).toEqual({ version: 1, dataEpoch: "workspace-epoch", input })
    for (const unsupported of [
      '{"botUserForm":{"version":2}}',
      '{"botUserForm":',
      '{"botUserForm":null}',
      '{"botUserForm":{"version":1,"dataEpoch":"initial","input":{}},"extra":true}'
    ]) {
      expect(hasBotUserFormMarker(unsupported)).toBe(true)
      expect(readBotUserForm(unsupported)).toBeNull()
    }
    for (const ordinary of [
      "普通问题",
      '{"botQuestions":{"version":1}}',
      '{"quoted":{"botUserForm":{}}}',
      '[{"botUserForm":{}}]'
    ]) {
      expect(hasBotUserFormMarker(ordinary)).toBe(false)
      expect(readBotUserForm(ordinary)).toBeNull()
    }
    expect(readBotUserForm(" ".repeat(BOT_USER_FORM_MAX_BYTES) + prompt)).toBeNull()
  })
})
