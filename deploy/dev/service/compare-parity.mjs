import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
const target = fileURLToPath(new URL("../../../services/bot-control/target/", import.meta.url))
export async function compareParity() {
  const ajv = JSON.parse(await readFile(join(target, "parity-ajv-results.json"), "utf8"))
  const java = JSON.parse(await readFile(join(target, "parity-java-results.json"), "utf8"))
  if (java.length !== ajv.length) throw new Error("B01_PARITY_COUNT")
  const rows = ajv.map((expected, index) => {
    const actual = java[index]
    if (expected.id !== actual.id || expected.schema !== actual.schema) throw new Error("B01_PARITY_ID")
    return { id: expected.id, schema: expected.schema, ajv: expected.valid, java: actual.valid, match: actual.valid === expected.valid }
  })
  await writeFile(join(target, "parity-report.json"), JSON.stringify(rows, null, 2) + "\n")
  const mismatches = rows.filter(row => !row.match)
  console.log(JSON.stringify({ stage: "schema-parity", fixtures: rows.length, valid: java.filter(row => row.valid).length, invalid: java.filter(row => !row.valid).length, mismatches }))
  if (mismatches.length) throw new Error("B01_PARITY_MISMATCH")
}
