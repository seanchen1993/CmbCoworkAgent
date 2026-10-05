import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { generate } from "../../../scripts/generate-bot-java-contracts.mjs"
import { parityFixtures } from "../../../tests/bot/service/parity-fixtures.mjs"
import { validator } from "../../../tests/bot/schema-support.mjs"

const root = fileURLToPath(new URL("../../../", import.meta.url))
export async function prepareContracts() {
  const docs = {}, bytes = {}, hashes = {}
  for (const file of ["schemas.json", "openapi.json", "state-transitions.json"]) {
    bytes[file] = await readFile(join(root, "contracts/bot/v1", file))
    docs[file] = JSON.parse(bytes[file].toString("utf8"))
    hashes[file] = createHash("sha256").update(bytes[file]).digest("hex")
  }
  const closure = generate(docs)
  const deref = value => value.$ref ? value.$ref.slice(2).split("/").reduce((node, key) => node[key], docs["openapi.json"]) : value
  const name = schema => {
    const match = /^\.\/schemas\.json#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/.exec(schema.$ref ?? "")
    if (!match) throw new Error("B01_SCHEMA_MAPPING")
    return match[1]
  }
  const manifest = { hashes, definitions: closure.reachable.map(ref => ref.split("/$defs/")[1]), operations: {} }
  for (const item of Object.values(docs["openapi.json"].paths)) for (const operation of Object.values(item)) {
    if (!closure.operations.some(op => op.id === operation?.operationId)) continue
    const mapping = { parameters: {}, responses: {} }
    if (operation.requestBody) mapping.request = name(deref(operation.requestBody).content["application/json"].schema)
    for (const ref of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
      const parameter = deref(ref)
      mapping.parameters[parameter.name] = name(parameter.schema)
    }
    for (const [status, ref] of Object.entries(operation.responses)) mapping.responses[status] = name(deref(ref).content["application/json"].schema)
    manifest.operations[operation.operationId] = mapping
  }
  const output = join(root, "services/bot-control/target/generated-resources/contracts/bot/v1")
  const testOutput = join(root, "services/bot-control/target/generated-test-resources")
  await mkdir(output, { recursive: true }); await mkdir(testOutput, { recursive: true })
  for (const [file, contents] of Object.entries(bytes)) await writeFile(join(output, file), contents)
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  const fixtures = parityFixtures(docs, closure)
  const ajv = fixtures.map(fixture => ({ id: fixture.id, schema: fixture.schema, valid: Boolean(validator(fixture.schema)(JSON.parse(fixture.json))) }))
  await writeFile(join(testOutput, "parity-fixtures.json"), JSON.stringify(fixtures) + "\n")
  await writeFile(join(root, "services/bot-control/target/parity-ajv-results.json"), JSON.stringify(ajv, null, 2) + "\n")
  console.log(JSON.stringify({ stage: "schema-resources", hashes, definitions: manifest.definitions.length, operations: Object.keys(manifest.operations).length, parityFixtures: fixtures.length }))
}
