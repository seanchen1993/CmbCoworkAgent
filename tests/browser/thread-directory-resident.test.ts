import { it } from "vitest"
import { runThreadDirectoryResidentBrowser } from "../thread-directory-resident-browser.spec"

it("isolates recreated resident history and refreshes background transcript changes on revisit",
  runThreadDirectoryResidentBrowser, 30000)
