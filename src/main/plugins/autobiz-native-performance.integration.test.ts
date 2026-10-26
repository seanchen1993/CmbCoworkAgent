import { afterEach, it, vi } from "vitest"
import { runAutoBizNativeCodeFixture } from "./autobiz-native-code.test-helper"

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("checks actual JS commits through Guest, native Python and durable action receipts without leaking source", async () => {
  await runAutoBizNativeCodeFixture({ cleanup, performanceOnly: true })
}, 120_000)
