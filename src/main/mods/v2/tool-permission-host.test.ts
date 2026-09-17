import { beforeEach, expect, it, vi } from "vitest"
import { queryFunctionToolPermission } from "./tool-permission-host"
import type { ModsManager } from "../manager"
import type { ModGrant } from "../control-store"
import type { McpCapabilityTool } from "../../mcp/capability-types"

const { probe, query, peek, discover } = vi.hoisted(() => ({
  probe: vi.fn(),
  query: vi.fn(),
  peek: vi.fn(),
  discover: vi.fn()
}))
vi.mock("../../agent/local-sandbox", () => ({ LocalSandbox: { createPermissionProbe: probe } }))
vi.mock("../../storage", () => ({ getWindowsSandboxMode: () => "readonly" }))
vi.mock("../../mcp/capability-service", () => ({
  getGlobalMcpCapabilityService: () => ({ peekTools: peek, listTools: discover })
}))
const grant = {
  workspace: "/project",
  modId: "function:demo",
  digest: "digest",
  enabled: true,
  epoch: 1
} as ModGrant
const plain = vi.fn()
const manager = {
  queryFunctionTool: vi.fn<ModsManager["queryFunctionTool"]>(
    async (_w, _t, _g, tool, args, _signal, fallback) => fallback(tool, args)
  )
}
const call = (tool: string, input = {}) =>
  queryFunctionToolPermission(
    manager as unknown as ModsManager,
    plain,
    "/project",
    "thread",
    grant,
    { tool, input },
    new AbortController().signal
  )
beforeEach(() => {
  vi.clearAllMocks()
  probe.mockReturnValue(query)
  query.mockResolvedValue({ decision: "allow" })
  peek.mockReturnValue(null)
})

it("uses only an inert native probe with the current sandbox mode", async () => {
  expect(await call("read_file", { file_path: "a" })).toEqual({ decision: "allow" })
  expect(query).toHaveBeenCalledWith("read_file", { file_path: "a" })
  expect(plain).toHaveBeenCalledWith("thread")
  expect(probe).toHaveBeenCalledWith(
    expect.objectContaining({ windowsSandbox: process.platform === "win32" ? "readonly" : "none" })
  )
  expect(peek).not.toHaveBeenCalled()
  expect(discover).not.toHaveBeenCalled()
})

it("does not open an MCP connection to answer a query or pretend missing metadata allows a call", async () => {
  expect(await call("mcp__server__tool")).toEqual({
    decision: "deny",
    reason: "MODS_TOOL_CONTEXT_REQUIRED"
  })
  expect(manager.queryFunctionTool).not.toHaveBeenCalled()
  expect(discover).not.toHaveBeenCalled()
  expect(probe).not.toHaveBeenCalled()
})

it("resolves cached MCP metadata exactly and denies ambiguous aliases without probing a server", async () => {
  const tool = {
    toolId: "mcp__server__tool",
    canonicalToolId: "mcp__canonical",
    capabilityId: "server/tool"
  } as McpCapabilityTool
  peek.mockReturnValue([tool])
  expect(await call("mcp__canonical", { value: 1 })).toEqual({ decision: "allow" })
  expect(manager.queryFunctionTool).toHaveBeenCalledWith(
    "/project",
    "thread",
    grant,
    "mcp:server/tool",
    { value: 1 },
    expect.any(AbortSignal),
    expect.any(Function)
  )
  peek.mockReturnValue([tool, { ...tool, capabilityId: "other/tool" }])
  expect(await call("mcp__server__tool")).toEqual({
    decision: "deny",
    reason: "MODS_TOOL_AMBIGUOUS"
  })
  expect(discover).not.toHaveBeenCalled()
  expect(probe).not.toHaveBeenCalled()
})
