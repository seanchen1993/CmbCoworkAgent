import { attachmentExtension } from "../../shared/upstream/grok-attachment-open-policy"
import { scanDelimitedTable } from "./upstream/grok-delimited-table"

/** A lossless named-field view beside the original bytes, never an inferred
 * policy or a computed answer. Reuse the Grok lexer used by output validation.
 * Omit the entire view if it cannot be represented within these bounds. */
export function evidenceTable(name: string, text: string) {
  const extension = attachmentExtension(name)
  if (extension !== "csv" && extension !== "tsv") return undefined
  if (text.length > 32000) return undefined
  const rows: string[][] = []
  let current: string[] = []
  try {
    scanDelimitedTable(text, extension === "csv" ? "," : "\t", {
      strict: true,
      maxFieldCharacters: 2048,
      field(value, row, column, truncated) {
        if (row >= 257 || column >= 64 || truncated) throw new Error("Table view exceeds bounds")
        current.push(value)
      },
      row() {
        rows.push(current)
        current = []
      }
    })
  } catch {
    return undefined
  }
  const [fields, ...records] = rows
  if (
    !fields?.length ||
    fields.some((field) => !field || field.length > 128) ||
    new Set(fields).size !== fields.length ||
    records.some((record) => record.length !== fields.length)
  )
    return undefined
  // Repeating long column names across sparse records can amplify a tiny CSV.
  // Bound the representation before constructing the per-record objects.
  const repeatedKeys = fields.reduce((size, field) => size + field.length * 6 + 8, 0)
  const values = records.reduce(
    (size, record) => size + record.reduce((sum, value) => sum + value.length * 6 + 4, 0),
    0
  )
  if (repeatedKeys * records.length + values + fields.join("").length * 6 > 16000) return undefined
  return {
    fields,
    // Strings preserve decimal spelling, leading zeroes, signs and units.
    // Object.fromEntries also safely retains __proto__ as an own data key.
    records: records.map((record, index) => ({
      record: index + 1,
      values: Object.fromEntries(fields.map((field, column) => [field, record[column]]))
    }))
  }
}
