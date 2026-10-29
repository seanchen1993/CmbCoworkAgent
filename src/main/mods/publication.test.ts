import { describe, expect, it } from "vitest"
import { ToolMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import { filterModResult, replaceModProjection } from "./publication"

const secret = "sk-this-is-a-test-secret-0123456789"
describe("Mod publication", () => {
  it("suppresses uncheckable binary and truncated output while preserving failure status", () => {
    expect(filterModResult({ type: "image", data: "base64-secret" }, true)).toEqual({
      type: "text",
      text: expect.stringContaining("suppressed")
    })
    expect(
      filterModResult({ output: "partial-secret", exitCode: 2, truncated: true }, true)
    ).toEqual({ output: expect.stringContaining("suppressed"), exitCode: 2, truncated: true })
  })
  it("filters text, structured data, artifacts and metadata together", () => {
    const raw = new ToolMessage({
      tool_call_id: "call",
      status: "error",
      content: secret,
      artifact: { token: secret },
      metadata: { extra: secret }
    })
    const safe = filterModResult(raw, true)
    expect(JSON.stringify(safe)).not.toContain(secret)
    expect(safe.tool_call_id).toBe("call")
    expect(safe.status).toBe("error")
    expect(raw.content).toBe(secret)
  })
  it("preserves graph routing and unrelated messages", () => {
    const original = new Command({
      goto: "next",
      update: {
        unrelated: "keep",
        messages: [new ToolMessage({ tool_call_id: "call", content: secret })]
      }
    })
    const result = filterModResult(original, true, "call")
    expect(result.goto).toEqual(original.goto)
    expect((result.update as Record<string, unknown>).unrelated).toBe("keep")
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it("cannot change process exit status through a result projection", () => {
    const result = replaceModProjection(
      { output: "failed", exitCode: 2 },
      {
        text: "annotated",
        data: { exitCode: 0 }
      }
    )
    expect(result).toEqual({ output: "annotated", exitCode: 2 })
  })
  it("keeps the disabled publication path allocation-free", () => {
    const raw = { text: secret }
    expect(filterModResult(raw, false)).toBe(raw)
  })
})
