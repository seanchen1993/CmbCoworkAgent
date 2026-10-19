import { afterEach, expect, it, vi } from "vitest"
import type { HookContext } from "../hooks/runner"
import type { HookConfig, HookEvent } from "../hooks/types"
import { hookExecutionResult } from "../hooks/execution-result"
import { createHookScope } from "../hooks/scope"
import type { McpCapabilityService, McpCapabilityTool } from "../mcp/capability-types"

const observed = vi.hoisted(() => vi.fn())
vi.mock("../hooks/required-skill", () => ({ runHooksEnriched: observed }))
vi.mock("../mods/manager", async (original) => ({
  ...(await original<typeof import("../mods/manager")>()),
  getModsManager: () => null
}))
vi.mock("../mods/adapters", async (original) => ({
  ...(await original<typeof import("../mods/adapters")>()),
  publishCurrentModResult: async (value: unknown) =>
    typeof value === "string" ? "published" : { ...(value as object), text: "published" }
}))
import { createScopedMcpCapabilityService } from "./runtime"
import { LocalSandbox } from "./local-sandbox"
import { createToolHookMiddleware } from "./tool-hooks"

afterEach(() => {
  observed.mockReset()
  vi.restoreAllMocks()
})

it.each(["sandbox", "middleware", "mcp"])(
  "binds raw %s execution before applying result publication",
  async (kind) => {
    observed.mockResolvedValue(null)
    if (kind === "sandbox") {
      const sandbox = new LocalSandbox({
        rootDir: process.cwd(),
        runId: "thread",
        windowsSandbox: "none"
      })
      const host = sandbox as unknown as {
        resolveHooks(event: HookEvent, context: HookContext): HookConfig[]
        runHooks(event: HookEvent, context: HookContext): Promise<unknown>
      }
      vi.spyOn(host, "resolveHooks").mockReturnValue([])
      await host.runHooks("PostToolUse", {
        sessionId: "thread",
        workspacePath: process.cwd(),
        toolName: "read_file",
        toolResult: "native-execution"
      })
    } else if (kind === "middleware") {
      const middleware = createToolHookMiddleware({
        workspacePath: process.cwd(),
        threadId: "thread",
        hookScope: createHookScope(),
        resolveHooksForContext: () => []
      })
      const invoke = middleware.wrapToolCall as unknown as (
        request: { toolCall: { id: string; name: string; args: object } },
        handler: (request: object) => Promise<string>
      ) => Promise<unknown>
      await invoke(
        { toolCall: { id: "call", name: "inspect", args: {} } },
        async () => "native-execution"
      )
    } else {
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
          text: "native-execution",
          isError: false,
          raw: "native-execution"
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
      await scoped.invoke(tool.capabilityId, {})
    }
    const post = observed.mock.calls.find(
      ([, event]) => event === "PostToolUse"
    )?.[2] as HookContext
    expect(post.toolResult).toBe("published")
    expect(hookExecutionResult(post)).toBe("native-execution")
    expect(JSON.stringify(post)).not.toContain("native-execution")
  }
)
