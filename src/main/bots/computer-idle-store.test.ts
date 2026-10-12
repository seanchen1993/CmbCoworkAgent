import { expect, it, vi } from "vitest"
import { writeFile } from "node:fs/promises"
import { BotStore } from "./store"

it("queries unfinished task lifetime through the existing queue index without taking a snapshot", async () => {
  const store = new BotStore(":memory:")
  try {
    const reader = store as unknown as {
      one(sql: string): Record<string, unknown> | undefined
      rows(sql: string): Record<string, unknown>[]
    }
    const one = vi.spyOn(reader, "one")
    const snapshot = vi.spyOn(store, "snapshot")
    expect(store.hasUnfinishedWork()).toBe(false)
    const query = one.mock.calls.at(-1)![0]
    const plan = reader.rows("EXPLAIN QUERY PLAN " + query)
    expect(plan.map((row) => row.detail).join("\n")).toMatch(
      /USING COVERING INDEX bot_run_queue \(status=\?\)/
    )
    if (process.env.CMB_IDLE_SQL_EVIDENCE)
      await writeFile(
        process.env.CMB_IDLE_SQL_EVIDENCE,
        JSON.stringify({ query, plan, sqliteRuntime: process.version }, null, 2) + "\n"
      )
    const { conversationId } = store.createBot({ nonce: "bot", name: "Queue lifetime" })
    const run = store.send({ nonce: "first", conversationId, text: "Prepare a form" }).runIds[0]!
    expect(store.getRun(run).status).toBe("queued")
    expect(store.hasUnfinishedWork()).toBe(true)
    const first = store.claim("first-owner")!
    expect(store.getRun(run).status).toBe("running")
    expect(store.hasUnfinishedWork()).toBe(true)
    store.requestInteraction(first.lease, { kind: "question", prompt: "Keep the form open" })
    expect(store.getRun(run).status).toBe("waiting_input")
    expect(store.hasUnfinishedWork()).toBe(true)
    store.cancel(run)
    expect(store.getRun(run).status).toBe("cancelling")
    expect(store.hasUnfinishedWork()).toBe(true)
    store.finish(first.lease, "cancelled", "Cancelled after the form was checked")
    expect(store.hasUnfinishedWork()).toBe(false)
    const next = store.send({ nonce: "second", conversationId, text: "Prepare another form" })
      .runIds[0]!
    store.claim("next-owner")!
    store.fenceOwner("next-owner", "Review the interrupted form")
    expect(store.getRun(next).status).toBe("needs_review")
    expect(store.hasUnfinishedWork()).toBe(true)
    store.recover({
      id: next,
      revision: store.getRun(next).revision,
      decision: "cancel",
      note: "No submitted action",
      effects: []
    })
    expect(store.hasUnfinishedWork()).toBe(false)
    expect(snapshot).not.toHaveBeenCalled()
  } finally {
    store.close()
  }
})
