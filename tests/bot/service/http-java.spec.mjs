import { test } from "node:test"
import assert from "node:assert/strict"
import { httpMode, startHttpJava, httpChildFacts, proveHttpEndpoint, httpBearer } from "../../../deploy/dev/service/http-java.mjs"
test("HTTP launcher has fixed mains and already-cancelled starts send/spawn zero", async () => {
  assert.equal(httpMode("production"), false)
  for (const mode of ["serve", "race-same", "race-cas", "partial-version", "partial-members", "before-receipt", "before-commit", "lost-response"]) assert.equal(httpMode(mode), true)
  for (const mode of ["arbitrary.Main", "http://127.0.0.1", "", null]) assert.throws(() => httpMode(mode), /C2_SELECTION/)
  const before = httpChildFacts(), controller = new AbortController(); controller.abort()
  await assert.rejects(startHttpJava(null, null, null, "production", controller.signal), /B1_CANCELLED/)
  assert.deepEqual(httpChildFacts(), before)
})
test("bearer cannot leave for unregistered, self-reported or already-cancelled endpoints", async () => {
  await assert.rejects(proveHttpEndpoint({ pid: process.pid, port: 32893 }), /C2_ENDPOINT_PROOF/)
  await assert.rejects(httpBearer({ port: 32893 }, "p1"), /C2_ENDPOINT_PROOF/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(proveHttpEndpoint(null, controller.signal), /B1_CANCELLED/)
})
