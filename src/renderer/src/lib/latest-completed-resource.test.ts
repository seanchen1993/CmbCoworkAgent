import { describe, expect, it } from "vitest"
import { createCompletedResourceProjector, type ResourceMessage } from "./latest-completed-resource"

function completedWrite(path: string): ResourceMessage[] {
  return [
    {
      id: "assistant-1",
      role: "assistant",
      tool_calls: [{ id: "call-1", name: "write_file", args: { path, content: "content" } }]
    },
    { id: "tool-1", role: "tool", tool_call_id: "call-1" }
  ]
}

describe("completed resource path intent", () => {
  it("keeps a POSIX tool /tmp path absolute", () => {
    const projection = createCompletedResourceProjector("linux")(
      completedWrite("/tmp/report.md"),
      []
    )

    expect(projection.latestResourceEvent).toMatchObject({
      path: "/tmp/report.md",
      toolCallId: "call-1",
      workspacePathKind: "absolute"
    })
  })

  it("keeps an ordinary tool path relative", () => {
    const projection = createCompletedResourceProjector("linux")(
      completedWrite("src/report.md"),
      []
    )

    expect(projection.latestResourceEvent).toMatchObject({
      path: "src/report.md",
      toolCallId: "call-1",
      workspacePathKind: "relative"
    })
  })
})
