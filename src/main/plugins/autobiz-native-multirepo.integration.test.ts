import { afterEach, expect, it, vi } from "vitest"
import { runAutoBizNativeCodeFixture } from "./autobiz-native-code.test-helper"

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it.each(["dependent", "independent"] as const)(
  "runs %s tasks in two real declared Git repositories with original evidence and isolated promotion",
  async (repositories) => {
    const result = await runAutoBizNativeCodeFixture({ cleanup, repositories, verifyRelease: false })
    expect(result.evidenceRoute).toBe("standalone-unbound")
  },
  420_000
)
it("rejects an unbound plan repository before any model write or promotion", async () => {
  const result = await runAutoBizNativeCodeFixture({ cleanup, repositories: "unbound", verifyRelease: false })
  expect(result.evidenceRoute).toBe("standalone-unbound")
}, 90_000)
