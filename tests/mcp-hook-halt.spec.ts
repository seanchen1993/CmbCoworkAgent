/**
 * Unit tests for MCP tool wrappers preserving HookHaltError.
 *
 * Run:
 *   npx tsx tests/mcp-hook-halt.spec.ts
 */

import { createEagerMcpTool } from "../src/main/mcp/langchain-tool.ts"
import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../src/main/mcp/capability-types.ts"
import { createToolSearchTools } from "../src/main/agent/tools/tool-search-tool.ts"
import { HookHaltError, isHookHaltError } from "../src/main/hooks/halt.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const lazyTool: McpCapabilityTool = {
  capabilityId: "connector:test:lazy_tool",
  toolId: "lazy_tool",
  providerKey: "test-provider",
  providerAlias: "test",
  providerDisplayName: "Test Provider",
  toolName: "lazy_tool",
  description: "lazy test tool",
  inputSchema: { type: "object", properties: {} },
  visibility: "lazy"
}

const eagerTool: McpCapabilityTool = {
  ...lazyTool,
  capabilityId: "connector:test:eager_tool",
  toolId: "eager_tool",
  toolName: "eager_tool",
  visibility: "eager"
}

function makeHalt(reason: string): HookHaltError {
  return new HookHaltError({
    hookEvent: "PreToolUse",
    result: {
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: true,
      continue: false,
      stopReason: reason
    },
    fallbackReason: reason
  })
}

function createHaltingService(tool: McpCapabilityTool): McpCapabilityService {
  return {
    listTools: async () => [tool],
    getTool: async (idOrAlias) => (idOrAlias === tool.toolId || idOrAlias === tool.capabilityId ? tool : null),
    invoke: async () => {
      throw makeHalt(`${tool.toolId} halted`)
    },
    invalidate: async () => undefined,
    close: async () => undefined
  }
}

async function expectHookHalt(fn: () => Promise<unknown>, expectedReason: string): Promise<void> {
  let caught: unknown
  try {
    await fn()
  } catch (error) {
    caught = error
  }

  if (!isHookHaltError(caught)) {
    throw new Error("wrapper should rethrow HookHaltError")
  }
  assert(
    caught.reason.includes(expectedReason),
    `halt reason should be preserved, got ${caught.reason}`
  )
}

async function testEagerMcpToolRethrowsHookHalt(): Promise<void> {
  const service = createHaltingService(eagerTool)
  const tool = createEagerMcpTool(service, eagerTool)

  await expectHookHalt(() => tool.invoke({}), "eager_tool halted")
}

async function testInvokeDeferredToolRethrowsHookHalt(): Promise<void> {
  const service = createHaltingService(lazyTool)
  const tools = await createToolSearchTools(
    service,
    { workspacePath: process.cwd(), threadId: "test-thread" },
    { codeExecRouteEnabled: false, savedToolsEnabled: false }
  )
  const invokeDeferred = tools.find(
    (tool) => (tool as { name?: string }).name === "invoke_deferred_tool"
  ) as { invoke(input: unknown): Promise<McpInvocationResult> } | undefined

  assert(invokeDeferred, "invoke_deferred_tool should be created for lazy MCP tools")
  await expectHookHalt(
    () => invokeDeferred!.invoke({ tool_id: "lazy_tool", tool_args: {} }),
    "lazy_tool halted"
  )
}

async function run(): Promise<void> {
  await testEagerMcpToolRethrowsHookHalt()
  console.log("PASS M1 eager MCP wrapper rethrows HookHaltError")
  await testInvokeDeferredToolRethrowsHookHalt()
  console.log("PASS M2 invoke_deferred_tool rethrows HookHaltError")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
