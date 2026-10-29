/** Explicit live-provider acceptance. No generated source or tool results are supplied by this runner. */
import assert from "node:assert/strict"
import { resolve } from "node:path"

assert.equal(process.env.CREATOR_E2E_BUILT_PREVIEW, "1", "GENERIC_PROJECT_BUILT_PREVIEW_REQUIRED")
assert.match(process.env.CREATOR_E2E_EXPECTED_SHA256 ?? "", /^[a-f0-9]{64}$/)
assert(process.env.CMB_CREATOR_LIVE_MODEL_ID, "GENERIC_PROJECT_REAL_MODEL_REQUIRED")
assert(!process.env.CREATOR_LIVE_SOURCE_SET, "GENERIC_PROJECT_MUST_START_FROM_EMPTY_TEMPLATE")
if (process.env.CMB_CREATOR_LIVE_RESUME_RUN)
  assert(["diagnostic", "runtime"].includes(process.env.CMB_CREATOR_LIVE_RESUME_MODE ?? ""))
process.env.GENERIC_PROJECT_CREATOR = "1"
process.env.CREATOR_LIVE_SCENARIO = "project"
process.env.CMB_CREATOR_LIVE_PROJECT_RUNTIME = "1"
process.env.CMB_CREATOR_LIVE_MAX_REQUESTS = "64"
process.env.COMPOSITION_E2E_ARTIFACT_ROOT ??= resolve("output/generic-project-creator-live-20261028")
void import("./creator-live-authoring-native-e2e.spec")
