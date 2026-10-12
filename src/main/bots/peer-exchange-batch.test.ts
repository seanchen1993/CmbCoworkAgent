import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture() {
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  return store
}
function measuredPage(store: BotStore, conversationId: string, count: number) {
  const projectionQueries: string[] = []
  const bindings: unknown[] = []
  const prepare = store.db.prepare.bind(store.db)
  const project = store.peerExchanges.forMessages.bind(store.peerExchanges)
  const outer = vi.spyOn(store.peerExchanges, "forMessages").mockImplementation((rows) => {
    const inner = vi.spyOn(store.db, "prepare").mockImplementation((sql, params) => {
      projectionQueries.push(sql)
      bindings.push(params)
      return prepare(sql, params)
    })
    try {
      return project(rows)
    } finally {
      inner.mockRestore()
    }
  })
  try {
    const messages = store.messages(conversationId, undefined, count)
    const plans = projectionQueries.flatMap((sql, index) => {
      if (!sql.includes("INDEXED BY")) return []
      const statement = store.db.prepare(
          `EXPLAIN QUERY PLAN ${sql}`,
          bindings[index] as Parameters<typeof prepare>[1]
        ),
        details: string[] = []
      try {
        while (statement.step()) details.push(String(statement.getAsObject().detail))
      } finally {
        statement.free()
      }
      return [{ sql, details }]
    })
    return { messages, projectionQueries, plans }
  } finally {
    outer.mockRestore()
  }
}
it("projects 100 and 200 actual ordinary Bot results with bounded page queries", () => {
  const store = fixture(),
    bot = store.createBot({ nonce: "bot", name: "Result owner" })
  for (let i = 0; i < 200; i++)
    store.send({ nonce: `task-${i}`, conversationId: bot.conversationId, text: `User ${i}` })
  for (let i = 0; i < 200; i++) {
    const claim = store.claim("host")!
    store.finish(claim.lease, "succeeded", `Result ${i}`)
  }
  const measured: ReturnType<typeof measuredPage>[] = []
  for (const size of [100, 200]) {
    const { messages, projectionQueries } = measuredPage(store, bot.conversationId, size)
    expect(messages).toHaveLength(size)
    expect(messages.every((m) => m.sender === "bot")).toBe(true)
    console.info(
      JSON.stringify({
        case: "ordinary-results",
        size,
        projectionQueries: projectionQueries.length
      })
    )
    measured.push({ messages, projectionQueries, plans: [] })
    expect(messages.every((m) => m.peerExchanges === undefined)).toBe(true)
  }
  for (const { projectionQueries } of measured)
    expect(projectionQueries.length).toBeLessThanOrEqual(3)
})
it("batch projects 100 and 200 exact peer dispatches using the existing owned-child and event indexes", () => {
  const store = fixture(),
    recipient = store.createBot({ nonce: "recipient", name: "Recipient" }),
    source = store.createBot({ nonce: "source", name: "Source" })
  for (let i = 0; i < 200; i++) {
    store.send({
      nonce: `task-${i}`,
      conversationId: source.conversationId,
      text: `Private user ${i}`
    })
    const p = store.claim("host")!
    expect(p.run.botId).toBe(source.bot.id)
    store.sendPeer(p.lease, {
      nonce: `peer-${i}`,
      recipient: recipient.bot.id,
      text: `Exact dispatch ${i}`
    })
    store.finish(p.lease, "succeeded", `Source result ${i}`)
    if (i === 0) expect(store.claim("host")!.run.botId).toBe(recipient.bot.id)
  }
  const measured: ReturnType<typeof measuredPage>[] = []
  for (const size of [100, 200]) {
    const { messages, projectionQueries, plans } = measuredPage(
      store,
      recipient.conversationId,
      size
    )
    expect(messages).toHaveLength(size)
    expect(
      messages.every(
        (m) =>
          m.peerExchanges?.length === 1 &&
          m.peerExchanges[0].direction === "incoming" &&
          m.peerExchanges[0].anchor.conversationId === recipient.conversationId
      )
    ).toBe(true)
    console.info(
      JSON.stringify({ case: "peer-dispatch", size, projectionQueries: projectionQueries.length })
    )
    measured.push({ messages, projectionQueries, plans })
  }
  for (const { projectionQueries, plans } of measured) {
    expect(projectionQueries.length).toBeLessThanOrEqual(9)
    expect(projectionQueries.some((q) => q.includes("bot_run_owned_children"))).toBe(true)
    expect(projectionQueries.some((q) => q.includes("bot_event_entity_kind"))).toBe(true)
    console.info(JSON.stringify({ case: "actual-page-plans", plans: plans.map((p) => p.details) }))
    expect(
      plans.some((p) =>
        p.details.some((d) =>
          /SEARCH r USING INDEX bot_run_owned_children.*root_run_id=\?.*parent_run_id=\?/.test(d)
        )
      )
    ).toBe(true)
    expect(
      plans.some((p) =>
        p.details.some((d) =>
          /SEARCH bot_events USING INDEX bot_event_entity_kind.*entity_id=\?.*kind=\?/.test(d)
        )
      )
    ).toBe(true)
  }
})
