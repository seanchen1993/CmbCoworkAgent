import test from "node:test"
import assert from "node:assert/strict"
import { withRequirementExecutionFixture, requirementExecutionCheck } from "../../../deploy/dev/service/requirement-execution-check.mjs"

test("execution fixture refuses noncallback before resources or credentials", async () => {
  await assert.rejects(withRequirementExecutionFixture(null), /R01_EXECUTION_CALLBACK/)
})
test("cancelled execution fixture and full check refuse resources and callback", async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  await assert.rejects(withRequirementExecutionFixture(() => { called = true }, { signal: controller.signal }))
  await assert.rejects(requirementExecutionCheck(controller.signal))
  assert.equal(called, false)
})
