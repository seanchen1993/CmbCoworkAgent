import { z } from "zod"
import type { BotOutputContract, BotOutputFileContract } from "../../shared/bot-output-contract"
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "../agent/workflow/json-schema"
import { scanDelimitedTable } from "./upstream/grok-delimited-table"
import { validateBotFileName } from "./artifact-validation"

const fileName = z.string().min(1).max(200)
const shape = z
  .object({
    files: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              name: fileName,
              kind: z.literal("csv"),
              columns: z.array(z.string().min(1).max(128)).min(1).max(64)
            })
            .strict(),
          z
            .object({
              name: fileName,
              kind: z.literal("tsv"),
              columns: z.array(z.string().min(1).max(128)).min(1).max(64)
            })
            .strict(),
          z
            .object({
              name: fileName,
              kind: z.literal("json"),
              schema: z.union([z.boolean(), z.record(z.string(), z.unknown())])
            })
            .strict()
        ])
      )
      .min(1)
      .max(8)
  })
  .strict()

export function parseBotOutputContract(input: unknown): BotOutputContract {
  const value = shape.parse(input)
  if (JSON.stringify(value).length > 32_000) throw new Error("交付格式要求过大，请缩减后重试")
  const names = new Set<string>()
  for (const file of value.files) {
    validateBotFileName(file.name)
    if (!file.name.toLowerCase().endsWith(`.${file.kind}`) || names.has(file.name))
      throw new Error("交付文件名重复或扩展名与格式不一致")
    names.add(file.name)
    if (file.kind === "json") {
      assertSupportedJsonSchema(file.schema)
      // User-supplied regexes cannot run synchronously in the Host. The existing
      // workflow validator retains its pattern semantics for its original caller.
      rejectPatterns(file.schema)
    } else if (
      new Set(file.columns).size !== file.columns.length ||
      file.columns.some((column) => /[\r\n]/u.test(column) || column.includes("\0"))
    ) {
      throw new Error("交付表头不能重复，也不能包含换行或空字符")
    }
  }
  return value
}
function rejectPatterns(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return
  const node = schema as Record<string, unknown>
  if (node.pattern !== undefined)
    throw new Error("交付格式暂不支持 pattern；请使用类型、枚举或长度限制")
  for (const child of Object.values((node.properties ?? {}) as Record<string, unknown>))
    rejectPatterns(child)
  rejectPatterns(node.items)
  rejectPatterns(node.additionalProperties)
  for (const key of ["anyOf", "oneOf"])
    if (Array.isArray(node[key])) for (const child of node[key]) rejectPatterns(child)
}

/** Deliberately narrow literal recognition. Prose, quotes, examples and file
 * mentions are not promises to deliver a file. Typed input handles JSON schemas
 * and richer declarations without guessing their meaning from model output. */
export function inferBotOutputContract(text: string): BotOutputContract | undefined {
  const files: BotOutputFileContract[] = []
  let fence: string | undefined
  let quotedParagraph = false
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) quotedParagraph = false
    if (/^(?:.*(?:示例|例子|引用|解释|分析|example|quoted text))[:：]\s*$/iu.test(line)) {
      quotedParagraph = true
      continue
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence || quotedParagraph || /^(?: {4}|\t|\s*>)/u.test(line)) continue
    for (const sentence of line.split(/[。；;]/u)) {
      const match =
        /^\s*(?:[-*]\s+|\d+[.)、]\s*)?(?:请\s*)?(?:完成后\s*)?(?:交付|输出|导出|提供|生成并交付|deliver|export|create)\s*`?([^\s`/\\:<>"|?*，,（）()]+\.(csv|tsv))`?\s*[（(]([^（）()]+)[）)]/iu.exec(
          sentence
        )
      if (
        !match ||
        /(?:不要|无需|不必|别|不用|do not|don't|example|示例|例子|列名说明|各列含义)/iu.test(
          sentence
        )
      )
        continue
      const tail = sentence.slice(match[0].length)
      if (/^\s*(?:的|格式|含义|说明|长什么样|怎么)/u.test(tail)) continue
      const declarations = match[3].split(/[、，,]/u).map((part) => part.trim())
      const columns = declarations
        .filter((part) => !/^(?:每个[^\s、，,]{1,32}一行|每条记录一行)$/u.test(part))
        .map((part) => part.replace(/^`([^`]+)`$/u, "$1"))
      if (!columns.length || columns.some((column) => !/^[\p{L}\p{N}_ .%\-/]+$/u.test(column)))
        continue
      files.push({ name: match[1], kind: match[2].toLowerCase() as "csv" | "tsv", columns })
    }
  }
  if (!files.length) return undefined
  try {
    return parseBotOutputContract({ files })
  } catch {
    return undefined
  }
}

export const BOT_OUTPUT_FILE_BYTES = 512_000
export function validateBotOutputBytes(file: BotOutputFileContract, bytes: Uint8Array): string[] {
  if (bytes.byteLength > BOT_OUTPUT_FILE_BYTES) return ["文件超过交付格式校验上限（512000 字节）"]
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return ["文件不是有效 UTF-8；请交付原件或明确转换后的文件"]
  }
  if (file.kind === "json") {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return ["内容不是有效 JSON"]
    }
    return validateJsonSchemaValue(file.schema, value, {
      operations: 100_000,
      characters: 4_000_000
    })
  }
  const errors: string[] = [],
    header: string[] = []
  let count = 0
  try {
    scanDelimitedTable(text, file.kind === "tsv" ? "\t" : ",", {
      strict: true,
      maxFieldCharacters: 129,
      retain: (row, column) => row === 0 && column < 65,
      field(value, row, column) {
        if (row === 0 && column < 65) header.push(value)
      },
      row(columns, row) {
        count++
        if (row > 0 && columns !== file.columns.length && errors.length < 3)
          errors.push(`第 ${row + 1} 行有 ${columns} 列，应为 ${file.columns.length} 列`)
      }
    })
  } catch (error) {
    return [error instanceof Error ? error.message : "表格格式无效"]
  }
  if (
    !count ||
    header.length !== file.columns.length ||
    header.some((column, index) => column !== file.columns[index])
  )
    errors.unshift(`表头必须完全一致并保持顺序：${JSON.stringify(file.columns)}`)
  return errors.slice(0, 4)
}
