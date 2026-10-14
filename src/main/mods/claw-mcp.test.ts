import { describe, expect, it, vi } from "vitest"
import type { McpCapabilityService, McpCapabilityTool } from "../mcp/capability-types"
import type { ClawSourceEntry } from "../../shared/mods/claw"

vi.mock("../mcp/capability-service", () => ({ readConfiguredClawMcpSources: () => [] }))
import { restrictClawMcpService } from "./claw-mcp"

function fixture() {
  let sources: ClawSourceEntry[] = [
    { id: "a", name: "Same name", digest: "a".repeat(64) },
    { id: "b", name: "Same name", digest: "b".repeat(64) }
  ]
  const tools: McpCapabilityTool[] = sources.map((source) => ({
    capabilityId: `${source.id}:echo`,
    providerKey: source.id,
    providerDisplayName: source.name,
    providerAlias: source.id,
    toolId: `mcp__${source.id}__echo`,
    canonicalToolId: `canonical-${source.id}`,
    toolName: "echo",
    visibility: "eager",
    connectionGeneration: "initial"
  }))
  const invoke = vi.fn(async (id: string, _args: unknown, assertCurrent?: () => void) => {
    assertCurrent?.()
    return { capabilityId: id, raw: {}, text: id, isError: false }
  })
  const service: McpCapabilityService = {
    listTools: vi.fn(async () => tools),
    getTool: vi.fn(async () => tools[1]),
    getSnapshot: vi.fn(async () => ({ fingerprint: "global", tools })),
    configuredServerNames: vi.fn(() => sources.map((entry) => entry.name)),
    peekTools: vi.fn(() => tools),
    invoke,
    invalidate: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  }
  const selection = { mode: "selected" as const, items: [sources[0]] }
  return {
    service,
    tools,
    invoke,
    selection,
    read: () => sources,
    change: () => {
      sources = [{ ...sources[0], digest: "c".repeat(64) }, sources[1]]
    }
  }
}

describe("Claw MCP invocation selection", () => {
  it("leaves absent/all selections on the existing service", () => {
    const { service } = fixture()
    expect(restrictClawMcpService(service, undefined)).toBe(service)
    expect(restrictClawMcpService(service, { mode: "all", items: [] })).toBe(service)
  })

  it("empty selection does not inspect configuration or initialize shared transports", async () => {
    const { service } = fixture()
    const read = vi.fn(() => {
      throw Error("must not read")
    })
    const limited = restrictClawMcpService(service, { mode: "selected", items: [] }, read)
    expect(await limited.listTools()).toEqual([])
    expect(await limited.getTool("b:echo")).toBeNull()
    expect(await limited.getSnapshot?.()).toMatchObject({ tools: [] })
    expect(limited.peekTools?.()).toEqual([])
    expect(limited.configuredServerNames?.()).toEqual([])
    await expect(limited.invoke("b:echo", {})).rejects.toThrow("CLAW_MCP_TOOL_NOT_SELECTED")
    expect(read).not.toHaveBeenCalled()
    expect(service.listTools).not.toHaveBeenCalled()
    expect(service.getSnapshot).not.toHaveBeenCalled()
    expect(service.invoke).not.toHaveBeenCalled()
  })

  it("projects every metadata route and accepts only selected exact identities", async () => {
    const f = fixture()
    const limited = restrictClawMcpService(f.service, f.selection, f.read)
    expect(await limited.listTools()).toEqual([f.tools[0]])
    expect(limited.peekTools?.()).toEqual([f.tools[0]])
    expect((await limited.getSnapshot?.())?.tools).toEqual([f.tools[0]])
    expect(limited.configuredServerNames?.()).toEqual(["Same name"])
    for (const id of ["a:echo", "mcp__a__echo", "canonical-a"])
      expect((await limited.invoke(id, {})).capabilityId).toBe("a:echo")
    for (const id of ["b:echo", "mcp__b__echo", "canonical-b", "echo", "unknown"]) {
      expect(await limited.getTool(id)).toBeNull()
      await expect(limited.invoke(id, {})).rejects.toThrow("CLAW_MCP_TOOL_NOT_SELECTED")
    }
    expect(f.service.getTool).not.toHaveBeenCalled()
    expect(f.invoke).toHaveBeenCalledTimes(3)
  })

  it("copies its selection and refuses changed/disabled configuration", async () => {
    const f = fixture()
    const limited = restrictClawMcpService(f.service, f.selection, f.read)
    f.selection.items.length = 0
    expect(await limited.listTools()).toHaveLength(1)
    f.change()
    expect(() => limited.peekTools?.()).toThrow("CLAW_MCP_SOURCE_CHANGED")
    await expect(limited.invoke("a:echo", {})).rejects.toThrow("CLAW_MCP_SOURCE_CHANGED")
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it("guards the awaited transport boundary and rejects changed results", async () => {
    const f = fixture()
    const limited = restrictClawMcpService(f.service, f.selection, f.read)
    f.invoke.mockImplementationOnce(async (id, _args, guard) => {
      f.change()
      guard?.()
      return { capabilityId: id, raw: {}, text: "unreachable", isError: false }
    })
    await expect(limited.invoke("a:echo", {})).rejects.toThrow("CLAW_MCP_SOURCE_CHANGED")
    const g = fixture()
    const other = restrictClawMcpService(g.service, g.selection, g.read)
    g.invoke.mockImplementationOnce(async (id) => {
      g.change()
      return { capabilityId: id, raw: {}, text: "stale", isError: false }
    })
    await expect(other.invoke("a:echo", {})).rejects.toThrow("CLAW_MCP_SOURCE_CHANGED")
  })

  it("checks connection generation after an asynchronous operation", async () => {
    const f = fixture()
    const limited = restrictClawMcpService(f.service, f.selection, f.read)
    f.invoke.mockImplementationOnce(async (id, _args, guard) => {
      f.tools[0].connectionGeneration = "replacement"
      guard?.()
      return { capabilityId: id, raw: {}, text: "unreachable", isError: false }
    })
    await expect(limited.invoke("a:echo", {})).rejects.toThrow("CLAW_MCP_CONNECTION_CHANGED")
  })

  it("does not close a shared pool and composes an outer caller guard", async () => {
    const f = fixture()
    const limited = restrictClawMcpService(f.service, f.selection, f.read)
    await limited.close()
    await limited.invalidate()
    expect(f.service.close).not.toHaveBeenCalled()
    expect(f.service.invalidate).not.toHaveBeenCalled()
    await expect(
      limited.invoke("a:echo", {}, () => {
        throw Error("outer revoked")
      })
    ).rejects.toThrow("outer revoked")
    expect(f.invoke).not.toHaveBeenCalled()
  })
})
