import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { forkReplayMessageDigest, readGraphInputForkReplay } from "./fork-replay-proof"

describe("historical fork replay proof", () => {
  it("matches canonical payloads across storage shapes and message renames", () => {
    const plain = {
      type: "ai",
      id: "provisional",
      content: [{ type: "text", text: "Inspect two files" }],
      tool_calls: [{ id: "read-1", name: "read", args: { a: "one", b: "two" } }]
    }
    const revived = new AIMessage({
      id: "canonical",
      content: [{ text: "Inspect two files", type: "text" }],
      tool_calls: [{ id: "read-1", name: "read", args: { b: "two", a: "one" }, type: "tool_call" }]
    })
    expect(forkReplayMessageDigest(plain)).toBe(forkReplayMessageDigest(revived))
    expect(forkReplayMessageDigest({ ...plain, tool_calls: [] })).not.toBe(
      forkReplayMessageDigest(revived)
    )
  })

  it("limits evidence to the replay prefix before the new user turn", () => {
    const tool = new ToolMessage({ id: "tool", content: "old result", tool_call_id: "call" })
    const input = new HumanMessage({ id: "new-user", content: "next task" })
    const later = new AIMessage({ id: "later", content: "unrelated reply" })
    const checkpoint = { channel_values: { __start__: { messages: [tool, input, later] } } }
    expect(readGraphInputForkReplay(checkpoint)).toMatchObject([
      { id: "tool", digest: forkReplayMessageDigest(tool) }
    ])
  })
})
