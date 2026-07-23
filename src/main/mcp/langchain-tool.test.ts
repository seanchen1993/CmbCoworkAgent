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
  it("awaits beforeInvoke before invoking the MCP capability", async () => {
    const callOrder: string[] = []
    const capabilityService: McpCapabilityService = {
      listTools: async () => [eagerTool],
      getTool: async () => eagerTool,
      invoke: vi.fn(async () => {
        callOrder.push("invoke")
        return {
          capabilityId: eagerTool.capabilityId,
          raw: { content: [] },
          text: "ok",
          isError: false
        }
      }),
      invalidate: async () => undefined,
      close: async () => undefined
    }

    const tool = createEagerMcpTool(capabilityService, eagerTool, {
      beforeInvoke: async () => {
        await Promise.resolve()
        callOrder.push("prepare")
      }
    })

    await tool.invoke({})

    expect(callOrder).toEqual(["prepare", "invoke"])
  })
})
