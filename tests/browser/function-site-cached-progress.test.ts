import { it } from "vitest"
import { runFunctionSiteCachedProgressBrowser } from "../function-site-cached-progress-browser.spec"

it(
  "bridges cached progress without restoring exact keys or revoked data",
  runFunctionSiteCachedProgressBrowser,
  30000
)
