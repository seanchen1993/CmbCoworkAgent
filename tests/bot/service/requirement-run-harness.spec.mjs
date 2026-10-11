import { test } from "node:test"
import assert from "node:assert/strict"
import {
  requirementRunProbe,
  requirementRunCheck
} from "../../../deploy/dev/service/requirement-run-check.mjs"

test("queue probes never select arbitrary SQL or execution entrypoints", async () => {
  for (const action of ["repair", "clean", "drop", "start", "createRun", "SELECT 1"])
    await assert.rejects(requirementRunProbe(null, null, action), /R01_RUN_SELECTION/)
})
test("cancelled queue tests allocate no resources or secrets", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(requirementRunCheck(controller.signal), /B1_CANCELLED/)
  await assert.rejects(
    requirementRunProbe(null, null, "exercise", {}, controller.signal),
    /B1_CANCELLED/
  )
})
