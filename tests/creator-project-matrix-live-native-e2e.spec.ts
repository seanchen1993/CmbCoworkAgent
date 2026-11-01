/** Real model matrix; installed seeds are explicit inputs, never claimed as authored output. */
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { creatorProjectMatrixMode } from "./support/creator-project-matrix"

const mode = creatorProjectMatrixMode(process.env.CREATOR_LIVE_PROJECT_MATRIX)
assert(mode, "LIVE_PROJECT_MATRIX_MODE_REQUIRED")
assert.equal(process.env.COMPOSITION_E2E_SOURCE_CANDIDATE
  ? process.env.CREATOR_E2E_SOURCE_PREVIEW : process.env.CREATOR_E2E_BUILT_PREVIEW, "1",
"LIVE_MATRIX_EXPLICIT_CANDIDATE_REQUIRED")
assert.match(process.env.CREATOR_E2E_EXPECTED_SHA256 ?? "", /^[a-f0-9]{64}$/)
assert(process.env.CMB_CREATOR_LIVE_MODEL_ID, "LIVE_MATRIX_REAL_MODEL_REQUIRED")
for (const key of ["CREATOR_LIVE_SOURCE_SET", "GENERIC_PROJECT_CREATOR", "CREATOR_LIVE_PROMPT_FILE",
  "CMB_CREATOR_LIVE_RESUME_RUN", "CMB_CREATOR_LIVE_INSTALLED_PROJECT_ID"])
  assert(!process.env[key], `LIVE_MATRIX_INCOMPATIBLE_INPUT:${key}`)
process.env.CREATOR_LIVE_SCENARIO = "project"
process.env.CMB_CREATOR_LIVE_PROJECT_RUNTIME = mode === "autobiz-derived" ? "0" : "1"
process.env.CMB_CREATOR_LIVE_MAX_REQUESTS = "64"
process.env.COMPOSITION_E2E_ARTIFACT_ROOT ??= resolve("output/creator-project-matrix-20261031", mode)
void import("./creator-live-authoring-native-e2e.spec")
