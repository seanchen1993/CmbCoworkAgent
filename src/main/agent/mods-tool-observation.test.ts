import { afterEach, expect, it, vi } from "vitest"
import type { HookContext } from "../hooks/runner"
import { createHookScope } from "../hooks/scope"
import type { McpCapabilityService, McpCapabilityTool } from "../mcp/capability-types"

const hooks = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ enabled: false }))
vi.mock("../hooks/required-skill", () => ({ runHooksEnriched: hooks }))
vi.mock("../mods/manager", async (original) => ({
  ...(await original<typeof import("../mods/manager")>()),
  getModsManager: () =>
    state.enabled
      ? { isActive: () => false, isEnabled: () => true, bindMcp: () => () => undefined }
      : null
}))
import { createScopedMcpCapabilityService } from "./runtime"
import { LocalSandbox } from "./local-sandbox"
import { clearFailureFiredState, markFailureFired } from "../hooks/tool-failure"

afterEach(() => {
  state.enabled = false
  vi.restoreAllMocks()
  hooks.mockReset()
  clearFailureFiredState()
})

it.each([false, true])(
  "measures actual MCP invocation excluding pre/post hooks (isError=%s)",
  async (isError) => {
    let clock = 10
    vi.spyOn(performance, "now").mockImplementation(() => clock)
    hooks.mockImplementation(async (_hooks, event) => {
      clock += event === "PreToolUse" ? 1000 : 500
      return null
    })
    const tool: McpCapabilityTool = {
      capabilityId: "connector:test:probe",
      toolId: "probe",
      toolName: "probe",
      providerKey: "test",
      providerAlias: "test",
      providerDisplayName: "test",
      visibility: "eager",
      inputSchema: { type: "object" }
    }
    const service: McpCapabilityService = {
      listTools: async () => [tool],
      getTool: async () => tool,
      invoke: async () => {
        clock += 25
        return { capabilityId: tool.capabilityId, text: "native", raw: "native", isError }
      },
      invalidate: async () => undefined,
      close: async () => undefined
    }
    const scoped = createScopedMcpCapabilityService(
      service,
      createHookScope(),
      () => [],
      undefined,
      undefined,
      { workspacePath: process.cwd(), threadId: "thread" }
    )
    expect((await scoped.invoke(tool.capabilityId, {})).isError).toBe(isError)
    const contexts = hooks.mock.calls
      .filter(([, event]) => event !== "PreToolUse")
      .map(([, event, context]) => ({ event, context }))
    expect(contexts).toHaveLength(isError ? 2 : 1)
    for (const { context } of contexts) expect(context.toolDurationMs).toBe(25)
  }
)

it("native result failure uses host call identity, never tool arguments for deduplication", async () => {
  hooks.mockResolvedValue(null)
  const sandbox = new LocalSandbox({
    rootDir: process.cwd(),
    runId: "thread",
    windowsSandbox: "none"
  })
  const observe = sandbox as unknown as {
    maybeFirePostToolUseFailureFromResult(context: HookContext): void
  }
  markFailureFired("attacker-id")
  const context: HookContext = {
    sessionId: "thread",
    workspacePath: process.cwd(),
    toolName: "execute",
    toolCallId: "real-id",
    toolArgs: { tool_call_id: "attacker-id", tool_use_id: "attacker-id" },
    toolResult: JSON.stringify({ exitCode: 1, error: "native failure" })
  }
  observe.maybeFirePostToolUseFailureFromResult(context)
  observe.maybeFirePostToolUseFailureFromResult(context)
  expect(hooks).toHaveBeenCalledTimes(1)
  expect(hooks.mock.calls[0][2].toolCallId).toBe("real-id")
  expect(JSON.parse(hooks.mock.calls[0][2].toolResult).tool_use_id).toBe("real-id")
})

it.each([false, true])(
  "settles the live MCP failure observer before returning only when Mods are enabled (%s)",
  async (enabled) => {
    state.enabled = enabled
    let finish!: () => void
    let observed = false,
      returned = false
    const pending = new Promise<null>((resolve) => {
      finish = () => resolve(null)
    })
    hooks.mockImplementation(async (_hooks, event) => {
      if (event === "PostToolUseFailure") {
        observed = true
        return pending
      }
      return null
    })
    const tool: McpCapabilityTool = {
      capabilityId: "connector:test:probe",
      toolId: "probe",
      toolName: "probe",
      providerKey: "test",
      providerAlias: "test",
      providerDisplayName: "test",
      visibility: "eager",
      inputSchema: { type: "object" }
    }
    const service: McpCapabilityService = {
      listTools: async () => [tool],
      getTool: async () => tool,
      invoke: async () => ({
        capabilityId: tool.capabilityId,
        text: "failed",
        raw: "failed",
        isError: true
      }),
      invalidate: async () => undefined,
      close: async () => undefined
    }
    const scoped = createScopedMcpCapabilityService(
      service,
      createHookScope(),
      () => [],
      undefined,
      undefined,
      { workspacePath: process.cwd(), threadId: "thread" }
    )
    const invocation = scoped.invoke(tool.capabilityId, {}).then((result) => {
      returned = true
      return result
    })
    try {
      await vi.waitFor(() => expect(observed).toBe(true))
      expect(returned).toBe(!enabled)
    } finally {
      finish()
      await invocation
    }
  }
)
