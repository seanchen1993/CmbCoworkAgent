import { it } from "vitest"
import { runFunctionToolProgressBrowser } from "../function-tool-progress-browser.spec"

it(
  "retains protected tool progress without crossing replacement or revocation",
  runFunctionToolProgressBrowser,
  30000
)
