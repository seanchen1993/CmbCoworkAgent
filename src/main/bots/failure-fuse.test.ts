import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { botFailureFuse } from "./failure-fuse"

afterEach(() => vi.unstubAllEnvs())

it("reuses success/reset policy and persists no error text in failure notices", () => {
  vi.stubEnv("CMB_AGENT_FAIL_FAST", "0")
  vi.stubEnv("CMB_AGENT_FAILURE_FUSE_WARN", "1")
  const store = new BotStore(":memory:")
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "A" })
  store.send({ nonce: "message", conversationId, text: "work" })
  const claimed = store.claim("owner", 60_000)!
  const fuse = botFailureFuse({
    ...claimed,
    bot,
    store,
    messages: [],
    signal: new AbortController().signal
  })
  const args = { command: "node", private: "PRIVATE_ARGUMENT" }
  const input = {
    toolName: "execute",
    toolArgs: args,
    signal: {
      kind: "throw" as const,
      message: "PRIVATE_PROVIDER_ERROR",
      errorType: "unknown" as const,
      isInterrupt: false,
      isTimeout: false
    }
  }
  try {
    expect(fuse.failure(input).count).toBe(1)
    const repeated = fuse.failure(input)
    expect(repeated.action).toBe("warn")
    fuse.notice(repeated)
    const events = JSON.stringify(store.events())
    expect(events).toContain("同一工具已重复失败 2 次")
    expect(events).not.toContain("PRIVATE_")
    expect(events).not.toContain("fingerprint")
    fuse.success({ toolName: "execute", toolArgs: args })
    expect(fuse.failure(input).count).toBe(1)
    fuse.close()
    expect(fuse.failure(input).count).toBe(1)
  } finally {
    fuse.close()
    store.close()
  }
})
