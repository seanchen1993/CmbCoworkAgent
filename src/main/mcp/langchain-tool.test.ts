import { describe, expect, it, vi } from "vitest"
import type { McpCapabilityService, McpCapabilityTool } from "./capability-types"
import { createEagerMcpTool } from "./langchain-tool"
import { ToolMessage } from "@langchain/core/messages"
import { modCallContext } from "../mods/context"

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
  it("preserves MCP error status and protects end callbacks", async () => {
    const secret = "sk-test-private-secret-123456789"
    const service: McpCapabilityService = {
      listTools: async () => [eagerTool],
      getTool: async () => eagerTool,
      invoke: async () => ({
        capabilityId: eagerTool.capabilityId,
        raw: { content: [] },
        text: secret,
        isError: true
      }),
      invalidate: async () => undefined,
      close: async () => undefined
    }
    const end = vi.fn()
    const result = await modCallContext.run(
      {
        identity: {
          callId: "call",
          threadId: "thread",
          turnId: "turn",
          workspace: "workspace",
          agentId: "main",
          origin: "model",
          grantEpoch: 0
        },
        toolId: "mcp:test",
        routeClaimed: true,
        protectedOutput: true,
        readOnly: false
      },
      () =>
        createEagerMcpTool(service, eagerTool).invoke(
          { type: "tool_call", id: "call", name: eagerTool.toolId, args: {} },
          { callbacks: [{ handleToolEnd: end }] }
        )
    )
    expect(ToolMessage.isInstance(result)).toBe(true)
    expect((result as ToolMessage).status).toBe("error")
    expect(JSON.stringify(end.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(result)).toContain("[REDACTED]")
  })
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
