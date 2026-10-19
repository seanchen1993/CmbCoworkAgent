/** Explicit bounded functional entry. Default Full10 entry keeps its strict90s behavior. */
import assert from "node:assert/strict"

assert(process.env.AUTOBIZ_FULL_APP_ACCEPTANCE_MODE === undefined ||
  process.env.AUTOBIZ_FULL_APP_ACCEPTANCE_MODE === "bounded-functional",
"The bounded functional entry cannot silently replace another acceptance mode")
process.env.AUTOBIZ_FULL_APP_ACCEPTANCE_MODE = "bounded-functional"
void import("./autobiz-full-journey-packaged-e2e.spec").catch(error => {
  console.error(error)
  process.exitCode = 1
})
