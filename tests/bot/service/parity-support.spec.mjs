import { test } from "node:test"
import assert from "node:assert/strict"
import { readContract, validator } from "../schema-support.mjs"
import { generate } from "../../../scripts/generate-bot-java-contracts.mjs"
import { parityFixtures, parityValidator } from "./parity-fixtures.mjs"
import { compareResults } from "../../../deploy/dev/service/compare-parity.mjs"
const documents = Object.fromEntries(["schemas.json", "openapi.json", "state-transitions.json"].map(file => [file, readContract(file)]))
const closure = generate(documents), fixtures = parityFixtures(documents, closure)
test("fixture coverage has actual valid baselines for every reachable definition and public mapping", () => {
  for (const name of closure.reachable.map(ref => ref.split("/$defs/")[1])) {
    const fixture = fixtures.find(row => row.id === `definition.${name}.positive`)
    assert.ok(fixture)
    assert.equal(parityValidator(documents, name)(JSON.parse(fixture.json)), true, name)
  }
  const consumers = fixtures.filter(row => row.consumer)
  const expected = { request: 0, success: 0, error: 0, parameter: 0 }
  for (const item of Object.values(documents["openapi.json"].paths)) for (const op of Object.values(item)) {
    if (!closure.operations.some(row => row.id === op?.operationId)) continue
    if (op.requestBody) expected.request++
    for (const status of Object.keys(op.responses)) expected[Number(status) < 300 ? "success" : "error"]++
    expected.parameter += (item.parameters ?? []).length + (op.parameters ?? []).length
  }
  assert.equal(consumers.filter(row => row.consumer.kind === "request").length, expected.request)
  assert.equal(consumers.filter(row => row.consumer.kind === "response" && row.consumer.status < 300).length, expected.success)
  assert.equal(consumers.filter(row => row.consumer.kind === "response" && row.consumer.status >= 300).length, expected.error)
  assert.equal(consumers.filter(row => row.consumer.kind === "parameter").length, expected.parameter)
  const original = new Set(["createBot", "getBot", "createBotVersion", "createGroup", "getGroup", "updateGroupMembers"])
  const old = consumers.filter(row => original.has(row.consumer.operation))
  assert.equal(old.filter(row => row.consumer.kind === "request").length, 4)
  assert.equal(old.filter(row => row.consumer.kind === "response" && row.consumer.status < 300).length, 6)
  assert.equal(old.filter(row => row.consumer.kind === "response" && row.consumer.status >= 300).length, 42)
  assert.equal(old.filter(row => row.consumer.kind === "parameter").length, 10)
  for (const fixture of consumers) assert.equal(parityValidator(documents, fixture.schema)(JSON.parse(fixture.json)), true, fixture.id)
})
test("parity comparison rejects stale, missing, reordered, duplicate or vacuous results", () => {
  const expected = { runId: "same-run", results: [{ id: "valid", schema: "Id", valid: true }, { id: "invalid", schema: "Id", valid: false }] }
  const actual = structuredClone(expected)
  assert.equal(compareResults(expected, actual).every(row => row.match), true)
  assert.throws(() => compareResults(expected, { ...actual, runId: "old-run" }), /STALE_RESULT/)
  assert.throws(() => compareResults(expected, { ...actual, results: [] }), /COUNT/)
  assert.throws(() => compareResults(expected, { ...actual, results: [...actual.results].reverse() }), /ID/)
  assert.throws(() => compareResults(expected, { ...actual, results: [actual.results[0], actual.results[0]] }), /ID/)
  assert.throws(() => compareResults(expected, { ...actual, results: actual.results.map(row => ({ ...row, valid: false })) }), /VACUOUS/)
  const mismatch = { ...actual, results: actual.results.map(row => ({ ...row, valid: !row.valid })) }
  assert.equal(compareResults(expected, mismatch).filter(row => !row.match).length, 2)
})
test("original Ajv data-value parity is distinguished from precise raw-number byte semantics", () => {
  for (const raw of ["1.0000000000000001", "0.99999999999999999", "9007199254740990.5", "9007199254740991.1"])
    assert.equal(validator("Version")(JSON.parse(raw)), true, `observed JS Number rounding limitation for ${raw}`)
  for (const raw of ["1", "1.0", "1e0"]) assert.equal(validator("Version")(JSON.parse(raw)), true)
  assert.equal(validator("Version")(JSON.parse("9007199254740992")), false)
})
