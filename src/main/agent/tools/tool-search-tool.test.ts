import { describe, expect, it, vi } from "vitest"
import { createInspectTool, createInvokeDeferredTool } from "./tool-search-tool"
import { FailureFuseHaltError } from "../failure-fuse"
import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../../mcp/capability-types"

function makeLazyTool(): McpCapabilityTool {
  return {
    capabilityId: "connector:test:large_search",
    toolId: "large_search",
    providerKey: "test",
    providerAlias: "test",
    providerDisplayName: "Test",
    toolName: "large_search",
    visibility: "lazy",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              status: { type: "string" },
              secret: { type: "string" }
            }
          }
        },
        total: { type: "number" }
      }
    }
  }
}

function makeService(
  tool: McpCapabilityTool,
  result: McpInvocationResult
): {
  service: McpCapabilityService
  calls: Array<{ idOrAlias: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ idOrAlias: string; args: Record<string, unknown> }> = []
  const service: McpCapabilityService = {
    listTools: async () => [tool],
    getTool: async (idOrAlias) =>
      idOrAlias === tool.toolId || idOrAlias === tool.capabilityId ? tool : null,
    invoke: async (idOrAlias, args) => {
      calls.push({ idOrAlias, args })
      return result
    },
    invalidate: async () => undefined,
    close: async () => undefined
  }
  return { service, calls }
}

describe("invoke_deferred_tool projection", () => {
  it("projects lazy MCP results without forwarding projection controls to the MCP server", async () => {
    const tool = makeLazyTool()
    const { service, calls } = makeService(tool, {
      capabilityId: tool.capabilityId,
      raw: {},
      text: "",
      isError: false,
      structuredContent: {
        items: [
          { id: "1", name: "A", status: "done", secret: "hidden" },
          { id: "2", name: "B", status: "open", secret: "hidden" }
        ],
        total: 2
      }
    })
    const invokeDeferred = createInvokeDeferredTool(
      service,
      { workspacePath: "C:/workspace", threadId: "thread-1" },
      { codeExecRouteEnabled: false, savedToolsEnabled: false, deferredRouteEnabled: true }
    ) as { invoke(input: unknown): Promise<string> }

    const raw = await invokeDeferred.invoke({
      tool_id: "large_search",
      tool_args: { query: "risk" },
      required_fields: ["items[].id", "items[].status"],
      max_array_items: 1,
      max_result_chars: 4000
    })
    const parsed = JSON.parse(raw) as {
      ok: boolean
      data: unknown
      _projection?: Record<string, unknown>
    }

    expect(calls).toEqual([{ idOrAlias: "large_search", args: { query: "risk" } }])
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toEqual({
      items: [{ id: "1", status: "done" }]
    })
    expect(parsed._projection).toMatchObject({
      projected: true,
      truncated: false
    })
  })

  it("preserves the legacy success payload when no projection options are provided", async () => {
    const tool = makeLazyTool()
    const payload = { items: [{ id: "1", name: "A" }], total: 1 }
    const { service } = makeService(tool, {
      capabilityId: tool.capabilityId,
      raw: {},
      text: "",
      isError: false,
      structuredContent: payload
    })
    const invokeDeferred = createInvokeDeferredTool(
      service,
      { workspacePath: "C:/workspace", threadId: "thread-1" },
      { codeExecRouteEnabled: false, savedToolsEnabled: false, deferredRouteEnabled: true }
    ) as { invoke(input: unknown): Promise<string> }

    const parsed = JSON.parse(
      await invokeDeferred.invoke({
        tool_id: "large_search",
        tool_args: { query: "risk" }
      })
    ) as Record<string, unknown>

    expect(parsed).toEqual({
      ok: true,
      data: payload
    })
  })

  it("reports when saved tool text output cannot apply required_fields", async () => {
    vi.resetModules()
    vi.doMock("../../code-exec/saved-tool-store", () => ({
      getSavedCodeExecTool: () => ({
        toolId: "saved__plain_text",
        enabled: true,
        description: "Plain text saved tool",
        inputSchema: { type: "object", properties: {} },
        code: "return 'plain text'",
        timeoutMs: 1000,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        codeHash: "hash",
        dependencies: [],
        rewriteReady: true
      }),
      listSavedCodeExecTools: () => [],
      parseCodeExecOutputValue: (output: string) => {
        try {
          return JSON.parse(output) as unknown
        } catch {
          return output
        }
      }
    }))
    vi.doMock("../../code-exec/runner", () => ({
      LocalProcessRunner: class {
        async run() {
          return {
            ok: true,
            output: "plain text output",
            logs: []
          }
        }
      }
    }))

    const { createInvokeDeferredTool: createInvokeDeferredToolWithSavedTool } =
      await import("./tool-search-tool")
    const tool = makeLazyTool()
    const { service } = makeService(tool, {
      capabilityId: tool.capabilityId,
      raw: {},
      text: "",
      isError: false
    })
    const invokeDeferred = createInvokeDeferredToolWithSavedTool(
      service,
      { workspacePath: "C:/workspace", threadId: "thread-1" },
      { codeExecRouteEnabled: false, savedToolsEnabled: true, deferredRouteEnabled: true }
    ) as { invoke(input: unknown): Promise<string> }

    const parsed = JSON.parse(
      await invokeDeferred.invoke({
        tool_id: "saved__plain_text",
        tool_args: {},
        required_fields: ["items[].id"]
      })
    ) as {
      ok: boolean
      data: unknown
      _projection?: {
        requiredFieldsIgnored?: boolean
        ignoredReason?: string
      }
    }

    expect(parsed.ok).toBe(true)
    expect(parsed.data).toBe("plain text output")
    expect(parsed._projection).toMatchObject({
      requiredFieldsIgnored: true,
      ignoredReason: "Saved tool output is plain text, so required_fields could not be applied."
    })

    vi.doUnmock("../../code-exec/saved-tool-store")
    vi.doUnmock("../../code-exec/runner")
    vi.resetModules()
  })

  it("rethrows failure fuse halt errors from lazy MCP invocation", async () => {
    const tool = makeLazyTool()
    const haltError = new FailureFuseHaltError({
      action: "halt",
      fingerprint: "large_search|explicit-error|unknown|boom",
      count: 3,
      threshold: 3,
      reason: "same failure repeated",
      toolName: tool.toolId,
      lastError: "boom"
    })
    const service: McpCapabilityService = {
      listTools: async () => [tool],
      getTool: async (idOrAlias) =>
        idOrAlias === tool.toolId || idOrAlias === tool.capabilityId ? tool : null,
      invoke: async () => {
        throw haltError
      },
      invalidate: async () => undefined,
      close: async () => undefined
    }
    const invokeDeferred = createInvokeDeferredTool(
      service,
      { workspacePath: "C:/workspace", threadId: "thread-1" },
      { codeExecRouteEnabled: false, savedToolsEnabled: false, deferredRouteEnabled: true }
    ) as { invoke(input: unknown): Promise<string> }

    await expect(
      invokeDeferred.invoke({
        tool_id: "large_search",
        tool_args: { query: "risk" }
      })
    ).rejects.toBe(haltError)
  })
})

describe("inspect_tool field hints", () => {
  it("returns field_hints for deferred MCP tools from output_schema", async () => {
    const tool = makeLazyTool()
    const { service } = makeService(tool, {
      capabilityId: tool.capabilityId,
      raw: {},
      text: "",
      isError: false
    })
    const inspectTool = createInspectTool(service, {
      codeExecRouteEnabled: false,
      savedToolsEnabled: false,
      deferredRouteEnabled: true
    }) as { invoke(input: unknown): Promise<string> }

    const parsed = JSON.parse(
      await inspectTool.invoke({
        tool_ids: ["large_search"],
        caller: "invoke_deferred_tool"
      })
    ) as { loaded_tools: Array<{ field_hints?: string[] }> }

    expect(parsed.loaded_tools[0]?.field_hints).toEqual([
      "items[].id",
      "items[].name",
      "items[].status",
      "items[].secret",
      "total"
    ])
  })

  it("normalizes root-array stored examples into usable example_field_paths", async () => {
    vi.resetModules()
    vi.doMock("../../mcp/tool-example-store", () => ({
      getStoredToolExample: () => ({
        schemaHash: "test",
        updatedAt: new Date(0).toISOString(),
        resultExample: {
          ok: true,
          data: [{ id: "1", score: 7 }]
        }
      })
    }))

    const { createInspectTool: createInspectToolWithStoredExample } =
      await import("./tool-search-tool")
    const tool = {
      ...makeLazyTool(),
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            score: { type: "number" }
          }
        }
      }
    }
    const { service } = makeService(tool, {
      capabilityId: tool.capabilityId,
      raw: {},
      text: "",
      isError: false
    })
    const inspectTool = createInspectToolWithStoredExample(service, {
      codeExecRouteEnabled: false,
      savedToolsEnabled: false,
      deferredRouteEnabled: true
    }) as { invoke(input: unknown): Promise<string> }

    const parsed = JSON.parse(
      await inspectTool.invoke({
        tool_ids: ["large_search"],
        caller: "invoke_deferred_tool"
      })
    ) as { loaded_tools: Array<{ example_field_paths?: string[] }> }

    expect(parsed.loaded_tools[0]?.example_field_paths).toEqual(["[].id", "[].score"])
    vi.doUnmock("../../mcp/tool-example-store")
    vi.resetModules()
  })
})
