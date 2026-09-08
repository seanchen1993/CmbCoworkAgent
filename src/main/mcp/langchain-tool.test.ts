import { describe, expect, it, vi } from "vitest"
import type { McpCapabilityService, McpCapabilityTool } from "./capability-types"
import { createEagerMcpTool } from "./langchain-tool"

const eagerTool: McpCapabilityTool = {
  capabilityId: "connector:test:test_tool",
  toolId: "mcp__test__test_tool",
  providerKey: "connector:test",
  providerAlias: "test",
  providerDisplayName: "Test",
  toolName: "test_tool",
  visibility: "eager"
}

describe("eager MCP tool", () => {
  it("invokes the MCP capability with the provided args", async () => {
    const capabilityService: McpCapabilityService = {
      listTools: async () => [eagerTool],
      getTool: async () => eagerTool,
      invoke: vi.fn(async () => ({
        capabilityId: eagerTool.capabilityId,
        raw: { content: [] },
        text: "ok",
        isError: false
      })),
      invalidate: async () => undefined,
      close: async () => undefined
    }

    const tool = createEagerMcpTool(capabilityService, eagerTool)

    const result = await tool.invoke({ value: "demo" })

    expect(capabilityService.invoke).toHaveBeenCalledWith(eagerTool.capabilityId, { value: "demo" })
    expect(result).toBe("ok")
  })

  it("converts regular invocation failures into non-fatal tool output", async () => {
    const capabilityService: McpCapabilityService = {
      listTools: async () => [eagerTool],
      getTool: async () => eagerTool,
      invoke: vi.fn(async () => {
        throw new Error("boom")
      }),
      invalidate: async () => undefined,
      close: async () => undefined
    }

    const tool = createEagerMcpTool(capabilityService, eagerTool)

    const result = await tool.invoke({})

    expect(result).toBe("MCP tool error: boom")
  })
})
