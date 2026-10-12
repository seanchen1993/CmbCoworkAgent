import { expect, it } from "vitest"
import {
  inferBotOutputContract,
  parseBotOutputContract,
  validateBotOutputBytes
} from "./output-contract"
import { validateJsonSchemaValue } from "../agent/workflow/json-schema"
import { readDelimitedTable } from "./upstream/grok-delimited-table"
const csv = { name: "result.csv", kind: "csv" as const, columns: ["project_id", "amount万元"] }
const bytes = (text: string) => Buffer.from(text, "utf8")
it("preserves exact literal columns and only strips an explicit row annotation", () => {
  expect(
    inferBotOutputContract("交付 result.csv（project_id、amount万元，每个项目一行）和 review.md。")
  ).toEqual({ files: [csv] })
  expect(inferBotOutputContract("完成后交付 result.csv（project_id、amount万元）")).toEqual({
    files: [csv]
  })
})
it.each([
  "请解释 result.csv（project_id、amount万元）各列的含义",
  "不要交付 result.csv（project_id、amount万元）",
  "如果有时间，交付 result.csv（project_id、amount万元）",
  "> 交付 result.csv（project_id、amount万元）",
  "    交付 result.csv（project_id、amount万元）",
  "```text\n交付 result.csv（project_id、amount万元）\n```",
  "~~~\n交付 result.csv（project_id、amount万元）\n~~~",
  "例如：交付 result.csv（project_id、amount万元）",
  "下面是一个示例：\n交付 result.csv（project_id、amount万元）",
  "“交付 result.csv（project_id、amount万元）”是什么意思？",
  "输出 result.csv（project_id、amount万元）的列名说明",
  "提供 result.csv（project_id、amount万元）格式示例，不要生成文件",
  "交付 presentation.pptx 和九个项目文件"
])("does not invent an enforced contract from %s", (text) =>
  expect(inferBotOutputContract(text)).toBeUndefined()
)
it("accepts quoted multiline CSV cells and BOM but rejects wrong names, rows and broken quoting", () => {
  expect(
    validateBotOutputBytes(csv, bytes('\ufeffproject_id,amount万元\r\n"A\r\nB",18.45\r\n'))
  ).toEqual([])
  expect(validateBotOutputBytes(csv, bytes("project_id,amount_wan\nA,18.45\n"))[0]).toContain(
    "amount万元"
  )
  expect(validateBotOutputBytes(csv, bytes("project_id,amount万元\nA,18,45\n"))[0]).toContain(
    "3 列"
  )
  for (const text of [
    'project_id,amount万元\nA,"18',
    'project_id,amount万元\nA,1"2"',
    'project_id,amount万元\nA,"12"x'
  ])
    expect(validateBotOutputBytes(csv, bytes(text))).not.toEqual([])
})
it("checks every row after the preview window and retains preview behavior", () => {
  const text = "project_id,amount万元\n" + "A,1\n".repeat(100) + "B,2,3\n"
  expect(readDelimitedTable(text, ",", 90, 0).rows).toHaveLength(12)
  expect(validateBotOutputBytes(csv, bytes(text))).toEqual(["第 102 行有 3 列，应为 2 列"])
})
it("checks original bytes before parsing and rejects oversized or invalid UTF-8", () => {
  expect(validateBotOutputBytes(csv, new Uint8Array(512001))[0]).toContain("512000")
  expect(validateBotOutputBytes(csv, new Uint8Array([0xff]))[0]).toContain("UTF-8")
})
it("supports typed JSON and rejects unsupported schemas and unsafe synchronous patterns", () => {
  const contract = parseBotOutputContract({
    files: [
      {
        name: "result.json",
        kind: "json",
        schema: {
          type: "object",
          properties: { amount: { type: "number" } },
          required: ["amount"],
          additionalProperties: false
        }
      }
    ]
  })
  expect(validateBotOutputBytes(contract.files[0], bytes('{"amount":18.45}'))).toEqual([])
  expect(validateBotOutputBytes(contract.files[0], bytes('{"amount":"18.45"}'))[0]).toContain(
    "number"
  )
  expect(() =>
    parseBotOutputContract({
      files: [{ name: "result.json", kind: "json", schema: { pattern: "a+" } }]
    })
  ).toThrow("pattern")
  expect(() =>
    parseBotOutputContract({
      files: [{ name: "result.json", kind: "json", schema: { $ref: "#" } }]
    })
  ).toThrow("not supported")
})
it("bounds repeated schema work while retaining default workflow semantics", () => {
  const schema = {
    type: "array",
    items: { anyOf: Array.from({ length: 20 }, () => ({ const: "a".repeat(2000) })) }
  }
  const value = Array.from({ length: 100 }, () => "a".repeat(2000))
  expect(validateJsonSchemaValue(schema, value)).toEqual([])
  expect(validateJsonSchemaValue(schema, value, { operations: 100, characters: 10000 })).toContain(
    "$: validation work limit exceeded; value not fully validated"
  )
  expect(
    validateJsonSchemaValue(schema, value, { operations: 100000, characters: 10000 })
  ).toContain("$: validation work limit exceeded; value not fully validated")
})
