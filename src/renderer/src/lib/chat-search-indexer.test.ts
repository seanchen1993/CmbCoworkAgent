import { describe, expect, it } from "vitest"
import { createChatSearchIndexer } from "./chat-search-indexer"
import { createChatSearchPlan } from "../../../shared/chat-search-plan"
import { findChatSearchLocations, projectChatSearchPlan } from "../../../shared/chat-search-index"
import type { ChatSearchCorpus, ChatSearchDocument } from "./chat-search-matches"

class WorkerHarness extends EventTarget {
  messages: Array<{ type: string; requestId: number; raw?: string; query?: string }> = []
  terminated = false
  hold = false
  postMessage(request: (typeof this.messages)[number]): void {
    this.messages.push(request)
    if (!this.hold) queueMicrotask(() => this.reply(request))
  }
  reply(request = this.messages.at(-1)!): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: { requestId: request.requestId, done: true } })
    )
  }
  terminate(): void {
    this.terminated = true
  }
}
const corpus = (documents: ChatSearchDocument[]): ChatSearchCorpus => ({
  stableDocuments: documents,
  dynamicDocuments: [],
  dynamicMessageIds: new Set()
})
const doc = (messageId: string, text = "needle"): ChatSearchDocument => ({
  messageId,
  text,
  plan: createChatSearchPlan("assistant", text)
})

describe("asynchronous search index lifecycle", () => {
  it("uploads and matches only the replaced document on a streaming refresh", async () => {
    const worker = new WorkerHarness()
    const indexer = createChatSearchIndexer(() => worker as unknown as Worker)
    const documents = [doc("first"), doc("second"), doc("third")]
    await indexer.search(corpus(documents), "needle")
    worker.messages = []
    await indexer.search(
      corpus([...documents.slice(0, 2), doc("third", "changed needle")]),
      "needle"
    )
    expect(worker.messages.filter((request) => request.type === "begin")).toHaveLength(1)
    expect(worker.messages.filter((request) => request.type === "match")).toHaveLength(1)
    indexer.dispose()
    expect(worker.terminated).toBe(true)
  })

  it("sends only admitted source slices in byte-bounded packets", async () => {
    const worker = new WorkerHarness()
    const indexer = createChatSearchIndexer(() => worker as unknown as Worker)
    const large = doc("large", '\u0000中😀\\"'.repeat(100_000))
    await indexer.search(corpus([large]), "needle")
    const parts = worker.messages.filter((request) => request.type === "part")
    expect(parts.reduce((sum, part) => sum + (part.raw?.length ?? 0), 0)).toBeLessThanOrEqual(
      256 * 1024
    )
    for (const packet of worker.messages)
      expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThan(64 * 1024)
    indexer.dispose()
  })

  it("drops superseded work at a worker boundary without queueing old documents", async () => {
    const worker = new WorkerHarness()
    worker.hold = true
    const indexer = createChatSearchIndexer(() => worker as unknown as Worker)
    const first = indexer.search(corpus([doc("obsolete")]), "old")
    const firstOutcome = first.catch(() => "cancelled")
    await Promise.resolve()
    await Promise.resolve()
    expect(worker.messages).toHaveLength(1)
    const second = indexer.search(corpus([doc("current")]), "new")
    worker.hold = false
    worker.reply()
    expect(await firstOutcome).toBe("cancelled")
    await second
    expect(
      worker.messages.filter((request) => request.type === "match").map((request) => request.query)
    ).toEqual(["new"])
    indexer.dispose()
  })

  it("releases an in-flight request on close instead of leaving a timer or worker alive", async () => {
    const worker = new WorkerHarness()
    worker.hold = true
    const indexer = createChatSearchIndexer(() => worker as unknown as Worker)
    const pending = indexer.search(corpus([doc("pending")]), "needle")
    const outcome = pending.catch(() => "cancelled")
    await Promise.resolve()
    await Promise.resolve()
    indexer.dispose()
    expect(await outcome).toBe("cancelled")
    expect(worker.terminated).toBe(true)
  })

  it("forgets validation snapshots whose original search identity was evicted", async () => {
    const worker = new WorkerHarness()
    const indexer = createChatSearchIndexer(() => worker as unknown as Worker)
    const original = doc("evicted")
    const location = findChatSearchLocations(projectChatSearchPlan(original.plan!), "needle")[0]
    await indexer.search(corpus([original]), "needle")
    await indexer.search(corpus([]), "needle")
    worker.messages = []
    await indexer.validate(original, location)
    expect(worker.messages.map((request) => request.type)).toEqual([
      "begin",
      "part",
      "commit",
      "validate",
      "forget"
    ])
    indexer.dispose()
  })

  it("terminates a failed worker and re-uploads documents before the next search", async () => {
    const failed = new WorkerHarness()
    failed.hold = true
    const recovered = new WorkerHarness()
    const workers = [failed, recovered]
    const indexer = createChatSearchIndexer(() => workers.shift() as unknown as Worker)
    const documents = corpus([doc("recovery")])
    const first = indexer.search(documents, "needle")
    const outcome = first.catch((error: Error) => error.message)
    await Promise.resolve()
    await Promise.resolve()
    failed.dispatchEvent(new Event("error", { cancelable: true }))
    expect(await outcome).toBe("Search worker failed")
    expect(failed.terminated).toBe(true)
    await indexer.search(documents, "needle")
    expect(recovered.messages.filter((request) => request.type === "begin")).toHaveLength(1)
    expect(recovered.messages.filter((request) => request.type === "match")).toHaveLength(1)
    indexer.dispose()
  })
})
