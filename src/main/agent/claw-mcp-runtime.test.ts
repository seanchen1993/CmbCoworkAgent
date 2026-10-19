import { afterEach, expect, it, vi } from "vitest"
import type { McpCapabilityService, McpCapabilityTool } from "../mcp/capability-types"
import { createHookScope } from "../hooks/scope"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import type { PluginMetadata } from "../types"

const binding = vi.hoisted(() => vi.fn(() => () => {}))
vi.mock("../hooks/required-skill", () => ({ runHooksEnriched: async () => null }))
vi.mock("../mcp/tool-example-store", () => ({ recordSuccessfulToolExample: () => {} }))
vi.mock("../mods/manager", async (original) => ({
  ...(await original<typeof import("../mods/manager")>()),
  getModsManager: () => ({ isActive: () => false, isEnabled: () => false, bindMcp: binding })
}))
vi.mock("../browser/cdp/browser-cdp", async (original) => ({
  ...(await original<typeof import("../browser/cdp/browser-cdp")>()),
  getCurrentBrowserCdpPort: () => 9222
}))
import { createScopedMcpCapabilityService } from "./runtime"
import { restrictClawMcpService } from "../mods/claw-mcp"
import { CodeExecBridge } from "../code-exec/bridge"
import { autoSelectPlaywrightInAppBrowserTab } from "../browser/cdp/playwright-mcp-bridge"

afterEach(() => {
  vi.clearAllMocks()
})

function fixture(includeB = false, invokeOverride?: McpCapabilityService["invoke"]) {
  const tools: McpCapabilityTool[] = ["a", "b"].map((id) => ({
    capabilityId: `${id}:echo`,
    providerKey: id,
    providerAlias: id,
    providerDisplayName: id,
    toolName: "echo",
    toolId: `mcp__${id}__echo`,
    canonicalToolId: `mcp__${id}__echo`,
    sourceKind: id === "a" ? "plugin" : "connector",
    visibility: "eager",
    inputSchema: { type: "object" },
    ...(id === "a" ? { fallback: { enabled: true, to: "global", safeToRetry: true } as const } : {})
  }))
  const invoke = vi.fn<McpCapabilityService["invoke"]>(
    invokeOverride ??
      (async (id: string) => ({
        capabilityId: id,
        raw: {},
        text: id,
        isError: false
      }))
  )
  const service: McpCapabilityService = {
    listTools: async () => tools,
    getTool: async (id) =>
      tools.find((tool) => tool.capabilityId === id || tool.toolId === id) ?? null,
    peekTools: () => tools,
    invoke,
    invalidate: async () => {},
    close: async () => {}
  }
  const sources = ["a", "b"].map((id) => ({ id, name: id, digest: id.repeat(64) }))
  const restricted = restrictClawMcpService(
    service,
    {
      mode: "selected",
      items: includeB ? sources : [sources[0]]
    },
    () => sources
  )
  const scoped = createScopedMcpCapabilityService(
    restricted,
    createHookScope(),
    () => [],
    undefined,
    undefined,
    { workspacePath: process.cwd(), threadId: "claw-mcp-runtime" }
  )
  return { tools, invoke, restricted, scoped }
}

it("keeps scoped raw fallback and SDK-bound discovery/invocation within the provider selection", async () => {
  const f = fixture()
  const args = binding.mock.calls[0] as unknown as [
    unknown,
    McpCapabilityService["invoke"],
    McpCapabilityService["listTools"]
  ]
  expect((await args[2]()).map((tool) => tool.providerKey)).toEqual(["a"])
  await expect(args[1]("b:echo", {})).rejects.toThrow("CLAW_MCP_TOOL_NOT_SELECTED")
  await expect(f.scoped.invoke("mcp__b__echo", {})).rejects.toThrow("CLAW_MCP_TOOL_NOT_SELECTED")
  expect(await f.scoped.getTool("b:echo")).toBeNull()
  expect(f.invoke).not.toHaveBeenCalled()
  expect((await args[1]("a:echo", {})).text).toBe("a:echo")
})

it("allows configured transport fallback only when its destination provider was selected", async () => {
  const f = fixture()
  f.invoke.mockImplementation(async (id) => {
    if (id === "a:echo") throw Error("ECONNRESET")
    return { capabilityId: id, raw: {}, text: id, isError: false }
  })
  await expect(f.scoped.invoke("a:echo", {})).rejects.toThrow("ECONNRESET")
  expect(f.invoke.mock.calls.map(([id]) => id)).toEqual(["a:echo"])
  const g = fixture(true)
  g.invoke.mockImplementation(f.invoke.getMockImplementation()!)
  expect((await g.scoped.invoke("a:echo", {})).fallbackCapabilityId).toBe("b:echo")
  expect(g.invoke.mock.calls.map(([id]) => id)).toEqual(["a:echo", "b:echo"])
})

it("uses the same restriction through the real HTTP code-exec bridge", async () => {
  const f = fixture()
  const bridge = new CodeExecBridge(f.scoped)
  const { bridgeUrl, token } = await bridge.start()
  const post = (path: string, body: unknown) =>
    fetch(`${bridgeUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  try {
    const metadata = (await (await post("/meta", {})).json()) as { tools: McpCapabilityTool[] }
    expect(metadata.tools.map((tool) => tool.providerKey)).toEqual(["a"])
    expect((await post("/call", { idOrAlias: "a:echo" })).status).toBe(200)
    const denied = await post("/call", { idOrAlias: "b:echo" })
    expect(denied.status).toBe(500)
    expect(await denied.text()).toContain("CLAW_MCP_TOOL_NOT_SELECTED")
    expect(f.invoke.mock.calls.map(([id]) => id)).toEqual(["a:echo"])
  } finally {
    await bridge.close()
  }
})

it("rejects an unselected provider even when invoked by the real browser tab helper", async () => {
  const f = fixture()
  const browserTool = { ...f.tools[0], providerAlias: "inAppBrowser", toolName: "browser_navigate" }
  const state = { created: true, url: "about:blank", title: "" }
  await expect(
    autoSelectPlaywrightInAppBrowserTab({
      tool: browserTool,
      tabsTool: f.tools[1],
      capabilityService: f.restricted,
      workspacePath: process.cwd(),
      browserService: {
        getState: () =>
          state as ReturnType<
            NonNullable<
              Parameters<typeof autoSelectPlaywrightInAppBrowserTab>[0]["browserService"]
            >["getState"]
          >,
        prepareTarget: async () =>
          state as ReturnType<
            NonNullable<
              Parameters<typeof autoSelectPlaywrightInAppBrowserTab>[0]["browserService"]
            >["getState"]
          >,
        requestPanel: () => {}
      }
    })
  ).rejects.toThrow("CLAW_MCP_TOOL_NOT_SELECTED")
  expect(f.invoke).not.toHaveBeenCalled()
})

it.each(["authorization", "fallback"])(
  "retains the source fence through delayed MCP %s",
  async (scenario) => {
    let changed = false
    const token = issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        threadId: "thread",
        incarnationKey: "incarnation",
        projectId: "composition-legacy:run:unit",
        operationId: "run",
        workspace: process.cwd(),
        packageDigest: "c".repeat(64),
        stageId: "stage",
        plugin: { id: "plugin", path: process.cwd() } as PluginMetadata
      },
      () => {
        if (changed) throw Error("SOURCE_CHANGED_BEFORE_MCP")
      }
    )
    let entered!: () => void, release!: () => void
    const authorizationEntered = new Promise<void>((done) => {
      entered = done
    })
    const authorization = new Promise<void>((done) => {
      release = done
    })
    const callTool = vi.fn()
    const f = withRuntimePluginSource(token, () =>
      fixture(true, async (id, _args, assertCurrent) => {
        if (id === "a:echo") {
          entered()
          await authorization
          if (scenario === "fallback") throw Error("ECONNRESET")
        }
        assertCurrent?.()
        callTool()
        return { capabilityId: id, raw: {}, text: id, isError: false }
      })
    )
    const pending = withRuntimePluginSource(undefined, () => f.scoped.invoke("a:echo", {}))
    const rejected = expect(pending).rejects.toThrow("SOURCE_CHANGED_BEFORE_MCP")
    await authorizationEntered
    changed = true
    release()
    await rejected
    expect(callTool).not.toHaveBeenCalled()
    // The forwarded fence may reject fallback before even reaching the lower service.
    expect(f.invoke.mock.calls.map(([id]) => id)).toEqual(["a:echo"])
  }
)
