import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BotArtifacts } from "./artifacts"
import { BotDocumentReader } from "./document-reader"
import { avatarImage } from "./image-fixtures"
import { sendReviewedBotPeer } from "./peer-approval"
import type { BotRunAddress } from "../../shared/bot-run-history"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function fixture() {
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const a = store.createBot({ nonce: "a", name: "Source" }),
    b = store.createBot({ nonce: "b", name: "Recipient" })
  store.send({ nonce: "task", conversationId: a.conversationId, text: "PRIVATE_ROOT" })
  const parent = store.claim("host")!
  const childIds: string[] = []
  for (let i = 0; i < 34; i++) {
    const sent = store.sendPeer(parent.lease, {
      nonce: `dispatch-${i}`,
      recipient: b.bot.id,
      text: `Task ${i}`
    })
    const id = sent.runIds[0]
    childIds.push(id)
    store.waitForPeer(parent.lease, id)
    const child = store.claim("host")!
    expect(child.run.id).toBe(id)
    store.finish(child.lease, "succeeded", `Result ${i}`)
    store.waitForPeer(parent.lease, id)
  }
  const address: BotRunAddress = { conversationId: a.conversationId, runId: parent.run.id }
  return { store, address, parent, childIds }
}
function measuredPage(store: BotStore, address: BotRunAddress, before?: number) {
  const queries: string[] = []
  const bindings: unknown[] = []
  const prepare = store.db.prepare.bind(store.db)
  const capture = <T>(read: () => T) => {
    const spy = vi.spyOn(store.db, "prepare").mockImplementation((sql, params) => {
      queries.push(sql)
      bindings.push(params)
      return prepare(sql, params)
    })
    try {
      return read()
    } finally {
      spy.mockRestore()
    }
  }
  const projection = store.peerExchanges
  const original = projection.eventLink.bind(projection)
  const event = vi
    .spyOn(projection, "eventLink")
    .mockImplementation((...args) => capture(() => original(...args)))
  // Identical tests count the original point projection and the new batch boundary.
  const batch = Reflect.get(projection, "forEvents")
  const descriptor = Object.getOwnPropertyDescriptor(projection, "forEvents")
  if (typeof batch === "function")
    Reflect.set(projection, "forEvents", (...args: unknown[]) =>
      capture(() => Reflect.apply(batch, projection, args))
    )
  try {
    const history = store.runHistory({ ...address, ...(before ? { before } : {}), limit: 50 })
    const plans = queries.flatMap((sql, index) => {
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
    return { history, queries, plans }
  } finally {
    event.mockRestore()
    if (typeof batch === "function") {
      if (descriptor) Object.defineProperty(projection, "forEvents", descriptor)
      else Reflect.deleteProperty(projection, "forEvents")
    }
  }
}
it("batch projects the actual 50-event history page and 100 events across two original pages", () => {
  const f = fixture()
  const pages = [measuredPage(f.store, f.address)]
  expect(pages[0].history.nextBefore).not.toBeNull()
  pages.push(measuredPage(f.store, f.address, pages[0].history.nextBefore!))
  expect(pages.map((p) => p.history.items.length)).toEqual([50, 50])
  const items = pages.flatMap((p) => p.history.items)
  expect(new Set(items.map((item) => item.cursor)).size).toBe(100)
  expect(items.every((item) => item.peerExchange?.anchor.runId === f.parent.run.id)).toBe(true)
  expect(new Set(items.map((item) => item.peerExchange!.peerRunId)).size).toBeLessThan(100)
  expect(items.every((item) => f.childIds.includes(item.peerExchange!.peerRunId))).toBe(true)
  expect(items.map((item) => item.label)).toEqual(
    expect.arrayContaining(["已委派协作任务", "等待协作结果", "收到协作结果"])
  )
  expect(() => f.store.runHistory({ ...f.address, limit: 100 })).toThrow()
  for (const [index, page] of pages.entries()) {
    console.info(
      JSON.stringify({
        case: "history",
        page: index,
        rows: 50,
        projectionQueries: page.queries.length
      })
    )
    console.info(JSON.stringify({ case: "history-plans", page: index, plans: page.plans }))
  }
  console.info(
    JSON.stringify({
      case: "history",
      rows: 100,
      pages: 2,
      projectionQueries: pages.flatMap((p) => p.queries).length
    })
  )
  expect(pages.every((page) => page.queries.length <= 7)).toBe(true)
  expect(JSON.stringify(pages.map((p) => p.history))).not.toMatch(
    /PRIVATE_ROOT|checkpoint|leaseOwner/
  )
})

it("keeps ordinary history projection query-free and standalone peer links unchanged", () => {
  const f = fixture()
  const first = f.store.runHistory({ ...f.address, limit: 50 })
  for (const item of first.items)
    expect(item.peerExchange).toEqual(
      f.store.peerExchanges.eventLink(f.address, item.peerExchange!.peerRunId)
    )
  const ordinary = f.store.createBot({ nonce: "ordinary", name: "No collaboration" })
  f.store.send({ nonce: "ordinary-task", conversationId: ordinary.conversationId, text: "Check" })
  const run = f.store.claim("host")!
  expect(run.run.botId).toBe(ordinary.bot.id)
  f.store.activity(run.lease, "Read completed")
  const counts = () =>
    ["bot_runs", "bot_messages", "bot_effects", "bot_receipts", "bot_peer_waits"].map(
      (table) => f.store.db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]
    )
  const before = counts()
  const measured = measuredPage(f.store, {
    conversationId: ordinary.conversationId,
    runId: run.run.id
  })
  expect(measured.queries).toEqual([])
  expect(measured.history.items.every((item) => !item.peerExchange)).toBe(true)
  expect(counts()).toEqual(before)
})

it("does not link corrupt legacy foreign-child events or guess an unknown task", () => {
  const f = fixture()
  const other = f.store.createBot({ nonce: "foreign-parent", name: "Other source" })
  f.store.send({
    nonce: "foreign-task",
    conversationId: other.conversationId,
    text: "FOREIGN_PRIVATE"
  })
  const parent = f.store.claim("host")!
  expect(parent.run.botId).toBe(other.bot.id)
  const recipient = f.store.getBot(f.store.getRun(f.childIds[0]).botId)
  const foreign = f.store.sendPeer(parent.lease, {
    nonce: "foreign-peer",
    recipient: recipient.id,
    text: "FOREIGN_CHILD_PRIVATE"
  })
  for (const childId of [foreign.runIds[0], "unknown-legacy-child"])
    f.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('run.waiting_peer',?,?,?)",
      [f.parent.run.id, JSON.stringify({ childId }), Date.now()]
    )
  const history = f.store.runHistory({ ...f.address, limit: 50 })
  expect(history.items.slice(0, 2).map((item) => item.label)).toEqual([
    "等待协作结果",
    "等待协作结果"
  ])
  expect(history.items.slice(0, 2).every((item) => !item.peerExchange)).toBe(true)
  expect(
    history.items.slice(2).every((item) => item.peerExchange?.anchor.runId === f.parent.run.id)
  ).toBe(true)
  expect(JSON.stringify(history)).not.toMatch(/FOREIGN_PRIVATE|FOREIGN_CHILD_PRIVATE/)
})

it("uses the same approved image and branch lineage checks for history and standalone reads", async () => {
  const f = fixture()
  const directory = await mkdtemp(join(tmpdir(), "cmb-peer-history-images-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const files = new BotArtifacts(join(directory, "objects"), f.store)
  cleanup.push(() => files.close())
  const recipient = f.store.getBot(f.store.getRun(f.childIds[0]).botId)
  f.store.finish(f.parent.lease, "succeeded", "Initial source completed")
  const root = f.parent.run.messageId
  const sent = f.store.send({
    nonce: "branch",
    conversationId: f.address.conversationId,
    threadRootId: root,
    text: "BRANCH_PRIVATE"
  })
  const parent = f.store.claim("host")!
  expect(parent.run.id).toBe(sent.runIds[0])
  const image = await files.publish(
    {
      id: "branch-image",
      conversationId: f.address.conversationId,
      runId: parent.run.id,
      name: "chart.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage(), "base64"),
    parent.lease
  )
  const reader = new BotDocumentReader({
    entry: resolve("src/main/bots/document-worker-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const delivery = JSON.parse(
    await sendReviewedBotPeer(
      {
        store: f.store,
        ...parent,
        bot: f.store.getBot(parent.run.botId),
        messages: f.store.messagesForRun(parent.run.id),
        signal: new AbortController().signal
      },
      {
        callId: "branch-chart",
        recipient: recipient.id,
        text: "Exact chart",
        images: [{ artifact_id: image.id }]
      },
      () => {
        f.store.assertDispatch(parent.lease)
      },
      async (id, action, operation, commit) => {
        const ask = f.store.requestInteraction(parent.lease, {
          kind: "approval",
          prompt: JSON.stringify(action),
          action
        })
        f.store.answerInteraction({ id: ask.id, revision: ask.revision, answer: "approve" })
        const apply = () =>
          f.store.approvedToolOnce(parent.lease, { id, action, approvalId: ask.id }, operation)
        return commit ? commit(apply) : apply()
      },
      files,
      reader
    )
  )
  const address = {
    conversationId: f.address.conversationId,
    runId: parent.run.id,
    threadRootId: root
  }
  const counts = () =>
    ["bot_runs", "bot_messages", "bot_effects", "bot_receipts", "bot_peer_waits"].map(
      (table) => f.store.db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]
    )
  const before = counts()
  const history = f.store.runHistory(address)
  const link = history.items.find((item) => item.label === "已委派协作任务")!.peerExchange
  expect(link).toEqual(f.store.peerExchanges.eventLink(address, delivery.runIds[0]))
  expect(link).toMatchObject({ anchor: address, peerRunId: delivery.runIds[0] })
  expect(() =>
    f.store.runHistory({ conversationId: address.conversationId, runId: parent.run.id })
  ).toThrow("分支")
  const outbound = f.store
    .messages(address.conversationId, undefined, 100, undefined, root)
    .find((m) => m.peerDelivery?.recipientRunId === delivery.runIds[0])!
  f.store.db.run("DELETE FROM bot_message_threads WHERE message_id=?", [outbound.id])
  expect(
    f.store.runHistory(address).items.find((item) => item.label === "已委派协作任务")!.peerExchange
  ).toBeUndefined()
  expect(f.store.peerExchanges.eventLink(address, delivery.runIds[0])).toBeUndefined()
  expect(counts()).toEqual(before)
})
