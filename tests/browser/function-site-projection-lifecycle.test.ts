import { it } from "vitest"
import { runFunctionSiteProjectionLifecycleBrowser } from "../function-site-projection-lifecycle-browser.spec"

it(
  "preserves safe projection lifetimes through streaming, eviction and native-child remounts",
  runFunctionSiteProjectionLifecycleBrowser,
  30000
)
