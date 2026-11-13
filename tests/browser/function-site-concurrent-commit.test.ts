import { it } from "vitest"
import { runFunctionSiteConcurrentCommitBrowser } from "../function-site-concurrent-commit-browser.spec"

it("commits display continuity only after actual DOM and revokes legacy authority synchronously",
  runFunctionSiteConcurrentCommitBrowser, 30000)
