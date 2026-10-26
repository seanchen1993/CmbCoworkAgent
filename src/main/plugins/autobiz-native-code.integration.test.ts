import { afterEach, expect, it, vi } from "vitest"
import { runAutoBizNativeCodeFixture } from "./autobiz-native-code.test-helper"
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it("runs the saved AutoBiz Code workflow with real Git, native actions, production compilation and behavioral tests", async () => {
  const result = await runAutoBizNativeCodeFixture({ cleanup })
  expect(result.evidenceRoute).toBe("standalone-unbound")
}, 180_000)
it.each(["source_bug", "test_bug"] as const)(
  "binds a real failed UT receipt before the single %s repair and identical-command rerun",
  async (utFailure) => {
    const result = await runAutoBizNativeCodeFixture({ cleanup, utFailure })
    expect(result.evidenceRoute).toBe("standalone-unbound")
  },
  240_000
)
