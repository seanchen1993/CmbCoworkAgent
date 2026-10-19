/** Explicit native-timeout-chain functional entry; original90s/15min goals remain measured. */
import assert from "node:assert/strict"

assert(process.env.AUTOBIZ_FULL_APP_ACCEPTANCE_MODE === undefined ||
  process.env.AUTOBIZ_FULL_APP_ACCEPTANCE_MODE === "native-functional",
"The native-functional entry cannot silently replace another acceptance mode")
process.env.AUTOBIZ_FULL_APP_ACCEPTANCE_MODE = "native-functional"
void import("./autobiz-full-journey-packaged-e2e.spec").catch(error => {
  console.error(error)
  process.exitCode = 1
})
