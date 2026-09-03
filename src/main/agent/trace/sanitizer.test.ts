import { describe, expect, it } from "vitest"
import { sanitizeTraceForCloudUpload } from "./sanitizer"
import type { AgentTrace } from "./types"

function traceWithReasoning(reasoning: string, content = "done"): AgentTrace {
  return {
    traceId: "trace-reasoning",
    threadId: "thread-reasoning",
    startedAt: "2026-07-15T10:00:00.000Z",
    endedAt: "2026-07-15T10:00:01.000Z",
    durationMs: 1000,
    userMessage: "test",
    suspectedTechnicalDetailSupplement: true,
    modelId: "test-model",
    steps: [],
    modelCalls: [
      {
        startedAt: "2026-07-15T10:00:00.500Z",
        inputMessages: [],
        outputMessage: { role: "assistant", content, reasoning },
        toolCalls: []
      }
    ],
    nodes: [
      {
        id: "llm-1",
        type: "llm",
        parentId: null,
        startedAt: "2026-07-15T10:00:00.500Z",
        endedAt: "2026-07-15T10:00:01.000Z",
        output: content,
        metadata: { providerMessageId: "message-1", reasoning }
      }
    ],
    totalToolCalls: 0,
    outcome: "success",
    usedSkills: [],
    evolvedSkills: [],
    triggerSource: "chat"
  }
}

describe("trace reasoning sanitization", () => {
  it("bounds reasoning independently and keeps it addressable on the LLM node", () => {
    const sanitized = sanitizeTraceForCloudUpload(
      traceWithReasoning("r".repeat(5000), "c".repeat(5000))
    )
    const modelReasoning = sanitized.modelCalls?.[0]?.outputMessage.reasoning
    const modelContent = sanitized.modelCalls?.[0]?.outputMessage.content
    const rawNodeReasoning = sanitized.nodes?.[0]?.metadata?.reasoning
    const nodeReasoning = typeof rawNodeReasoning === "string" ? rawNodeReasoning : undefined
    const nodeContent = sanitized.nodes?.[0]?.output

    // The marker is shown to readers, so it is in the interface's language.
    expect(modelReasoning).toContain("已省略")
    expect(nodeReasoning).toContain("已省略")
    expect(sanitized.nodes?.[0]?.metadata?.providerMessageId).toBe("message-1")
    expect(modelReasoning).toHaveLength(modelContent?.length ?? 0)
    expect(nodeReasoning).toHaveLength(typeof nodeContent === "string" ? nodeContent.length : 0)
    expect(sanitized.modelCalls?.[0]?.outputMessage).not.toHaveProperty("reasoningSummary")
    expect(sanitized.nodes?.[0]?.metadata).not.toHaveProperty("reasoningSummary")
    expect(sanitized.suspectedTechnicalDetailSupplement).toBe(true)
  })
})
