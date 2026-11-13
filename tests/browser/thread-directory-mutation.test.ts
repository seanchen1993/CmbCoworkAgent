import { it } from "vitest"
import { runThreadDirectoryMutationBrowser } from "../thread-directory-mutation-browser.spec"

it("keeps the new resident draft and transcript when old store mutation replies arrive",
  runThreadDirectoryMutationBrowser, 30000)
