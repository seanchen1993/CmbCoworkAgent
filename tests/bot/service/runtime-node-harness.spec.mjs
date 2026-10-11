import { test } from "node:test"
import assert from "node:assert/strict"
import {
  runtimeNodeProbe,
  runtimeNodeCheck
} from "../../../deploy/dev/service/runtime-node-check.mjs"

test("node probes cannot select arbitrary SQL, migration or production entrypoints", async () => {
  for (const action of ["repair", "clean", "drop", "connectRuntime", "createRun", "SELECT 1"])
    await assert.rejects(runtimeNodeProbe(null, null, action), /R01_NODE_SELECTION/)
})
test("cancelled node probes refuse resources and secrets before work", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runtimeNodeCheck(controller.signal), /B1_CANCELLED/)
  await assert.rejects(
    runtimeNodeProbe(null, null, "exercise", {}, controller.signal),
    /B1_CANCELLED/
  )
})
