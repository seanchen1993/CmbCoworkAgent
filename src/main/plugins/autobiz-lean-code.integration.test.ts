import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import { runAutoBizLeanCodeFixture } from "./autobiz-lean-code.test-helper"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("repairs an actual failed Node test through original workflow evidence and rejects changed upstream bytes", async () => {
  const result = await runAutoBizLeanCodeFixture({ cleanup, utFailure: "source_bug" })
  expect(result.evidenceRoute).toBe("standalone-unbound")
}, 180000)

it("executes actual Maven Java with Python unittest and binds the selected adapter", async () => {
  const result = await runAutoBizLeanCodeFixture({
    cleanup,
    executionAdapter: "python-unittest/v1"
  })
  expect(result.evidenceRoute).toBe("standalone-unbound")
}, 180000)
