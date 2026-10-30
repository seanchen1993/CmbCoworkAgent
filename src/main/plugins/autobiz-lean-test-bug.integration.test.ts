import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import { runAutoBizLeanCodeFixture } from "./autobiz-lean-code.test-helper"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("stops after an attested real failed test and test_bug diagnosis without rewriting assertions or merging", async () => {
  const result = await runAutoBizLeanCodeFixture({ cleanup, utFailure: "test_bug" })
  expect(result).toMatchObject({
    stoppedForTestReview: true,
    failureMessage: expect.stringContaining("LEAN_TEST_CHANGE_REVIEW_REQUIRED:"),
    authoredLabels: ["B001-implement", "B001-review", "B001-test-author", "B001-ut-diagnosis-1"]
  })
}, 180000)
