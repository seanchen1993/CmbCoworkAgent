import { describe, expect, it } from "vitest"
import { isCoordinatorWorkerStreamChunk, isMainTurnMessageStream } from "./main-turn-stream"

describe("main turn stream attribution", () => {
  it.each([
    { tags: ["cmb:context-compaction"] },
    { langgraph_checkpoint_ns: "tools:call|model:1" },
    { checkpoint_ns: "tools:call" },
    { langgraph_checkpoint_ns: "main__worker__a:model" },
    { thread_id: "main__worker__a" },
    { langgraph_thread_id: "main__worker__a" },
    { configurable: { thread_id: "main__worker__a" } }
  ])("excludes non-main metadata %j", (metadata) => {
    expect(isMainTurnMessageStream("messages", [{ content: "private" }, metadata], "main")).toBe(
      false
    )
  })

  it.each([
    { additional_kwargs: { lc_source: "summarization" } },
    { kwargs: { additional_kwargs: { lc_source: "summarization" } } }
  ])("excludes summarization markers in either wire shape", (message) => {
    expect(isMainTurnMessageStream("messages", [message, {}], "main")).toBe(false)
  })

  it("preserves a worker's own main stream without attributing it to its coordinator", () => {
    const payload = [{ content: "answer" }, { thread_id: "main__worker__a" }]
    expect(isCoordinatorWorkerStreamChunk("messages", payload, "main")).toBe(true)
    expect(isMainTurnMessageStream("messages", payload, "main__worker__a")).toBe(true)
    expect(isMainTurnMessageStream("messages", [{}, { checkpoint_ns: "model:1" }], "main")).toBe(
      true
    )
    expect(isMainTurnMessageStream("values", payload, "main")).toBe(false)
    expect(isMainTurnMessageStream("messages", {}, "main")).toBe(false)
  })
})
