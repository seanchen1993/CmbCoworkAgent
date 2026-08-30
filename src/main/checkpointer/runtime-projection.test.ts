import { describe, expect, it } from "vitest"
import type { Checkpoint } from "@langchain/langgraph-checkpoint"
import { buildCheckpointRuntimeProjection } from "./runtime-projection"

describe("checkpoint runtime projection", () => {
  it("bounds unrelated channels and oversized restored runtime metadata", () => {
    const huge = "x".repeat(2 * 1024 * 1024)
    const checkpoint = {
      v: 1,
      id: "large-runtime-source",
      ts: "2026-08-24T00:00:00.000Z",
      channel_values: {
        messages: [{ id: "message", content: huge }],
        unrelated: huge,
        todos: Array.from({ length: 256 }, (_, index) => ({
          id: `todo-${index}`,
          content: huge,
          status: "pending"
        })),
        __interrupt__: [
          { value: { actionRequests: [{ action: "shell", args: { input: huge } }] } }
        ]
      },
      channel_versions: {},
      versions_seen: {}
    } as Checkpoint

    const projection = buildCheckpointRuntimeProjection(checkpoint)
    const channelValues = projection.channel_values as Record<string, unknown>
    expect("messages" in channelValues).toBe(false)
    expect("unrelated" in channelValues).toBe(false)
    const interruptArgs = (
      channelValues.__interrupt__ as Array<{
        value: { actionRequests: Array<{ action: string; args: { input?: string } }> }
      }>
    )[0].value.actionRequests[0].args
    expect(interruptArgs.input?.length).toBeLessThan(300)
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8")).toBeLessThan(140 * 1024)
  })
})
