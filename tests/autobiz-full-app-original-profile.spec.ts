import assert from "node:assert/strict"
import {
  originalFullAppProfile,
  originalMainPromotionArguments
} from "./support/autobiz-full-app-model"

const profile = originalFullAppProfile({ id: "autobiz.original-234-kernel", version: "1.0.3" })
assert.equal(profile.workerSample, "tests/support/autobiz-original-fixed-workflow-sample.py")
assert.equal(profile.parentSample, "tests/support/autobiz-original-full-app-sample.py")
assert.equal(profile.workflowTerminal, "awaiting_user_confirmation")
assert.equal(profile.requiresPromotion, true)
assert.equal(
  originalFullAppProfile({ id: "autobiz.python-kernel", version: "1.0.3" }).requiresPromotion,
  false
)
assert.throws(() => originalFullAppProfile({ id: "autobiz.original-234-kernel", version: "1.0.1" }))
assert.throws(() => originalFullAppProfile({ id: "unknown", version: "1.0.3" }))
const actual = {
  runId: "cw-real-run",
  finalStatus: "awaiting_user_confirmation",
  verification: { mainPromotion: { approvalDigest: "a".repeat(64) } }
}
assert.deepEqual(originalMainPromotionArguments(actual, "sample"), [
  "promote",
  "--feature",
  "sample",
  "--run-id",
  "cw-real-run",
  "--approval-digest",
  "a".repeat(64),
  "--approved-by",
  "explicit-native-app-acceptance-fixture",
  "--confirm"
])
for (const input of [
  { ...actual, finalStatus: "succeeded" },
  { ...actual, runId: "foreign" },
  { ...actual, verification: {} },
  { ...actual, verification: { mainPromotion: { approvalDigest: "sha256:" + "a".repeat(64) } } }
])
  assert.throws(() => originalMainPromotionArguments(input, "sample"))
console.log("PASS original-234 App fixture profile and exact native promotion approval boundaries")
