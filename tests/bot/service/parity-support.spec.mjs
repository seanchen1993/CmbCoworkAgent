import { test } from "node:test"
import assert from "node:assert/strict"
import { readContract, validator } from "../schema-support.mjs"
import { generate } from "../../../scripts/generate-bot-java-contracts.mjs"
import { parityFixtures } from "./parity-fixtures.mjs"
import { compareResults } from "../../../deploy/dev/service/compare-parity.mjs"
const documents = Object.fromEntries(["schemas.json", "openapi.json", "state-transitions.json"].map(file => [file, readContract(file)]))
const closure = generate(documents), fixtures = parityFixtures(documents, closure)
test("fixture coverage has actual valid baselines for every reachable definition and public mapping", () => {
  for (const name of closure.reachable.map(ref => ref.split("/$defs/")[1])) {
    const fixture = fixtures.find(row => row.id === `definition.${name}.positive`)
    assert.ok(fixture)
    assert.equal(validator(name)(JSON.parse(fixture.json)), true, name)
  }
  const consumers = fixtures.filter(row => row.consumer)
  assert.equal(consumers.filter(row => row.consumer.kind === "request").length, 4)
  assert.equal(consumers.filter(row => row.consumer.kind === "response" && row.consumer.status < 300).length, 6)
  assert.equal(consumers.filter(row => row.consumer.kind === "response" && row.consumer.status >= 300).length, 42)
  assert.equal(consumers.filter(row => row.consumer.kind === "parameter").length, 10)
  for (const fixture of consumers) assert.equal(validator(fixture.schema)(JSON.parse(fixture.json)), true, fixture.id)
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
