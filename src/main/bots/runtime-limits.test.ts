import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { BotStore } from "./store"
import { AGENT_GRAPH_RECURSION_LIMIT_DEFAULT } from "../../shared/agent-runtime-limits"
import type { BotFailureFusePolicy } from "./failure-fuse-policy"

it("retains the running budget through reopening while new work adopts the new setting", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-runtime-limits-"))
  const path = join(directory, "bots.sqlite")
  let store = new BotStore(path)
  const firstPolicy: BotFailureFusePolicy = {
    mode: "warn",
    userNoticeEnabled: true,
    modelFeedbackEnabled: false
  }
  const changedPolicy: BotFailureFusePolicy = {
    mode: "debug",
    userNoticeEnabled: false,
    modelFeedbackEnabled: true
  }
  try {
    const { conversationId } = store.createBot({ nonce: "bot", name: "Budget" })
    store.send({ nonce: "task", conversationId, text: "Review" })
    const original = store.claim("old")!
    expect(() => store.runTimezone(original.lease, "Invalid/Timezone")).toThrow("时区配置无效")
    expect(store.runTimezone(original.lease, "Asia/Shanghai")).toBe("Asia/Shanghai")
    expect(store.runGraphRecursionLimit(original.lease, 25)).toBe(25)
    expect(store.runToolStrategy(original.lease, "shell-first")).toBe("shell-first")
    expect(store.runFailureFusePolicy(original.lease, firstPolicy)).toEqual(firstPolicy)
    store.send({
      nonce: "steer",
      conversationId,
      text: "Additional context",
      steerRunId: original.run.id
    })
    expect(store.runGraphRecursionLimit(original.lease, 500)).toBe(25)
    expect(store.runTimezone(original.lease, "America/New_York")).toBe("Asia/Shanghai")
    expect(store.runToolStrategy(original.lease, "standard")).toBe("shell-first")
    expect(store.runFailureFusePolicy(original.lease, changedPolicy)).toEqual(firstPolicy)
    expect(store.steering.hasPending(original.run.id)).toBe(true)
    store.fenceOwner("old", "test interruption")
    const interrupted = store.getRun(original.run.id)
    store.close()
    store = new BotStore(path)
    store.recover({
      id: interrupted.id,
      revision: interrupted.revision,
      decision: "resume",
      effects: [],
      note: "Checked"
    })
    const resumed = store.claim("new")!
    expect(store.runTimezone(resumed.lease, "America/New_York")).toBe("Asia/Shanghai")
    expect(() => store.runTimezone(original.lease, "UTC")).toThrow()
    expect(store.runGraphRecursionLimit(resumed.lease, 500)).toBe(25)
    expect(store.runToolStrategy(resumed.lease, "standard")).toBe("shell-first")
    expect(store.runFailureFusePolicy(resumed.lease, changedPolicy)).toEqual(firstPolicy)
    expect(() => store.runGraphRecursionLimit(original.lease, 500)).toThrow()
    expect(() => store.runToolStrategy(original.lease, "standard")).toThrow()
    expect(() => store.runFailureFusePolicy(original.lease, changedPolicy)).toThrow()
    store.finish(resumed.lease, "cancelled", "Done")
    store.send({ nonce: "next", conversationId, text: "Next task" })
    const next = store.claim("new")!
    expect(store.runTimezone(next.lease, "America/New_York")).toBe("America/New_York")
    expect(store.runGraphRecursionLimit(next.lease, 500)).toBe(500)
    expect(store.runToolStrategy(next.lease, "standard")).toBe("standard")
    expect(() => store.runFailureFusePolicy(next.lease, { mode: "invalid" })).toThrow()
    expect(store.runFailureFusePolicy(next.lease, changedPolicy)).toEqual(changedPolicy)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([undefined, -1, 24, 100001, Infinity, "500"])(
  "uses the shared default for missing or invalid settings: %s",
  (value) => {
    const store = new BotStore(":memory:")
    try {
      const { conversationId } = store.createBot({ nonce: "bot", name: "Budget" })
      store.send({ nonce: "task", conversationId, text: "Review" })
      expect(store.runGraphRecursionLimit(store.claim("host")!.lease, value)).toBe(
        AGENT_GRAPH_RECURSION_LIMIT_DEFAULT
      )
    } finally {
      store.close()
    }
  }
)
