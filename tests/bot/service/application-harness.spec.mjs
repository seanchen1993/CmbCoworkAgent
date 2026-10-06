import { test } from "node:test"
import assert from "node:assert/strict"
import { applicationMode, startApplicationJava, applicationChildFacts, parseApplicationProof } from "../../../deploy/dev/service/application-java.mjs"
import { applicationResponses } from "../../../deploy/dev/service/application-proof.mjs"
import { operations } from "../../../contracts/bot/v1/fixtures/positive.mjs"
import { validator } from "../schema-support.mjs"

test("application launcher has only fixed test modes and already-aborted launch starts/sends nothing", async () => {
  for (const mode of ["suite", "reopen", "race-seed", "race-verify"]) assert.equal(applicationMode(mode), false)
  for (const mode of ["hold", "race-same", "race-cas-a", "race-cas-b"]) assert.equal(applicationMode(mode), true)
  for (const mode of ["migrate", "arbitrary.Main", "https://example.invalid", "", null]) assert.throws(() => applicationMode(mode), /C1_SELECTION/)
  const before = applicationChildFacts(), controller = new AbortController(); controller.abort()
  await assert.rejects(startApplicationJava(null, null, "suite", controller.signal), /B1_CANCELLED/)
  assert.deepEqual(applicationChildFacts(), before)
})
test("application proof rejects child diagnostics, wrong exit and incomplete controlled handshake", () => {
  const proof = { status: "verified", assertions: 1, denials: 0, replays: 0, rollbacks: 0, corruptReceipts: 0 }
  const result = { code: 0, stdout: JSON.stringify(proof), stderr: "" }
  assert.equal(parseApplicationProof(result, "suite").exitCode, 0)
  for (const patch of [{ stderr: "sentinel" }, { overflow: true }, { code: 1 }, { stdout: `${result.stdout}\n${result.stdout}` }]) assert.throws(() => parseApplicationProof({ ...result, ...patch }, "suite"))
  assert.throws(() => parseApplicationProof(result, "race-cas-a"))
  assert.throws(() => parseApplicationProof({ ...result, stdout: JSON.stringify({ ...proof, assertions: -1 }) }, "suite"))
})
const names = ["createBot", "getBot", "createBotVersion", "createGroup", "getGroup", "updateGroupMembers"]
function fixtures() {
  return { status: "verified", responses: names.map(operation => {
    const response = operations.find(x => x.operationId === operation).responses.find(x => x.status < 300)
    return { operation, status: response.status, body: Buffer.from(JSON.stringify(response.body)).toString("base64") }
  }) }
}
test("six declaration-derived synthetic response baselines run original Ajv (not JDBC evidence)", () => { assert.equal(applicationResponses(fixtures()), 6) })
test("response audit refuses duplicate selector, undeclared status, invalid body and missing operation", () => {
  for (const mutate of [p => p.responses.pop(), p => p.responses[1] = p.responses[0], p => p.responses[0].status = 418, p => p.responses[0].body = Buffer.from("{}").toString("base64"), p => p.responses[0].body += "!"])
  { const proof = fixtures(); mutate(proof); assert.throws(() => applicationResponses(proof), /C1_SCHEMA_PROOF/) }
})
test("actual frozen Text accepts 16384 Unicode codepoints, NUL and escaped isolated surrogate", () => {
  for (const value of ["🚀".repeat(16384), "x\u0000y", JSON.parse('"\\ud800"'), JSON.parse('"\\udc00"')]) assert.equal(validator("Text")(value), true)
  assert.equal(validator("Text")("🚀".repeat(16385)), false)
})
