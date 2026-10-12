import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ManagedMcpCapabilityService, type CapabilitySource } from "./capability-core"

const f = vi.hoisted(() => ({
  init: vi.fn(),
  list: vi.fn(),
  call: vi.fn(),
  capabilities: vi.fn(),
  resources: vi.fn(),
  templates: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
  clients: vi.fn()
}))
vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: function (...args: unknown[]) {
    f.clients(...args)
    const server = {
      listTools: f.list,
      callTool: f.call,
      getServerCapabilities: f.capabilities,
      listResources: f.resources,
      listResourceTemplates: f.templates,
      readResource: f.read
    }
    return {
      initializeConnections: f.init,
      close: f.close,
      getClient: async () => server
    }
  }
}))
let sources: CapabilitySource[]
let service: ManagedMcpCapabilityService | undefined
beforeEach(() => {
  vi.resetAllMocks()
  sources = [
    {
      kind: "connector",
      providerKey: "notes",
      providerDisplayName: "Notes",
      visibility: "eager",
      priority: 100,
      scope: "global",
      serverConfig: { url: "http://localhost/test" }
    }
  ]
  f.init.mockResolvedValue(undefined)
  f.close.mockResolvedValue(undefined)
  f.list.mockResolvedValue({ tools: [{ name: "save", inputSchema: { type: "object" } }] })
  f.call.mockResolvedValue({ content: [{ type: "text", text: "saved" }] })
  f.capabilities.mockReturnValue({ tools: {}, resources: {} })
  f.resources.mockResolvedValue({
    resources: [{ name: "Handbook", uri: "notes://handbook" }],
    nextCursor: "next"
  })
  f.templates.mockResolvedValue({
    resourceTemplates: [{ name: "Issue", uriTemplate: "notes://issues/{id}" }]
  })
  f.read.mockResolvedValue({ contents: [{ uri: "notes://handbook", text: "Notes" }] })
})
afterEach(async () => {
  await service?.close()
  service = undefined
})

it("retains the desktop invocation hooks and passes their amended arguments to the same connection", async () => {
  const authorize = vi.fn(),
    publish = vi.fn()
  service = new ManagedMcpCapabilityService({
    readSources: () => sources,
    aroundInvoke: async (target, args, invoke) => {
      authorize(target.capabilityId, args)
      const result = await invoke({ ...args, authorized: true })
      publish(result)
      return result
    }
  })
  const [target] = await service.listTools()
  expect((await service.invoke(target.toolId, { text: "note" })).text).toBe("saved")
  expect(authorize).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenCalledOnce()
  expect(f.call.mock.calls[0][0]).toEqual({
    name: "save",
    arguments: { text: "note", authorized: true }
  })
})

it("rechecks credentials and connection generation after a pending authorization", async () => {
  service = new ManagedMcpCapabilityService({
    readSources: () => sources,
    aroundInvoke: async (_target, args, invoke) => {
      sources = [{ ...sources[0], serverConfig: { url: "http://localhost/replacement" } }]
      return invoke(args)
    }
  })
  const [target] = await service.listTools()
  await expect(service.invoke(target.toolId, {})).rejects.toThrow("connection changed")
  expect(f.call).not.toHaveBeenCalled()
})

it("does not publish a connection that finished initializing after close", async () => {
  let release!: () => void
  f.init.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  service = new ManagedMcpCapabilityService({ readSources: () => sources })
  const pending = service.listTools()
  await vi.waitFor(() => expect(f.init).toHaveBeenCalledOnce())
  await service.close()
  release()
  await expect(pending).rejects.toThrow("configuration changed")
  expect(f.close).toHaveBeenCalledOnce()
  expect(service.peekTools()).toBeNull()
})

it("rejects stale generations and cancellation before transport, and does not retry lost replies", async () => {
  service = new ManagedMcpCapabilityService({ readSources: () => sources })
  const [target] = await service.listTools()
  await expect(
    service.invoke(target.toolId, {}, { expectedConnectionGeneration: "old" })
  ).rejects.toThrow("connection changed")
  await expect(
    service.invoke(target.toolId, {}, { signal: AbortSignal.abort(new Error("stopped")) })
  ).rejects.toThrow("stopped")
  expect(f.call).not.toHaveBeenCalled()
  f.call.mockRejectedValue(new Error("disconnected after remote write"))
  await expect(service.invoke(target.toolId, {})).rejects.toThrow("disconnected")
  expect(f.call).toHaveBeenCalledOnce()
})

it("stops a provider that cycles discovery cursors and releases the connection", async () => {
  f.list.mockResolvedValue({ tools: [], nextCursor: "cycle" })
  service = new ManagedMcpCapabilityService({ readSources: () => sources })
  await expect(service.listTools()).rejects.toThrow("page or size limit")
  expect(f.list).toHaveBeenCalledTimes(2)
  expect(f.close).toHaveBeenCalledOnce()
})

it("supports resource-only providers and keeps resource cursors and templates scoped to a negotiated connection", async () => {
  f.capabilities.mockReturnValue({ resources: {} })
  service = new ManagedMcpCapabilityService({ readSources: () => sources })
  expect(await service.listTools()).toEqual([])
  expect(f.list).not.toHaveBeenCalled()
  const provider = await service.resourceProvider("notes")
  const options = { expectedConnectionGeneration: provider.connectionGeneration }
  expect((await service.listResources("notes", "resources", "page", options)).nextCursor).toBe(
    "next"
  )
  expect(f.resources.mock.calls[0][0]).toEqual({ cursor: "page" })
  await service.listResources("notes", "templates", undefined, options)
  expect(f.templates).toHaveBeenCalledOnce()
  await service.readResource("notes", "notes://handbook", options)
  expect(f.read.mock.calls[0][0]).toEqual({ uri: "notes://handbook" })
  await service.invalidate()
  await expect(service.readResource("notes", "notes://handbook", options)).rejects.toThrow(
    "connection changed"
  )
  expect(f.read).toHaveBeenCalledOnce()
})

it("rejects foreign providers, cancellation, revoked results and lost reads without retrying", async () => {
  service = new ManagedMcpCapabilityService({ readSources: () => sources })
  await expect(service.resourceProvider("foreign")).rejects.toThrow("unavailable")
  await expect(
    service.readResource("notes", "notes://handbook", {
      signal: AbortSignal.abort(new Error("cancelled"))
    })
  ).rejects.toThrow("cancelled")
  expect(f.init).not.toHaveBeenCalled()
  f.read.mockImplementationOnce(async () => {
    sources = []
    return { contents: [] }
  })
  await expect(service.readResource("notes", "notes://handbook")).rejects.toThrow(
    "connection changed"
  )
  expect(f.read).toHaveBeenCalledOnce()
})

it("does not retry a resource read after a transport failure", async () => {
  service = new ManagedMcpCapabilityService({ readSources: () => sources })
  f.read.mockRejectedValue(new Error("reply lost"))
  await expect(service.readResource("notes", "notes://handbook")).rejects.toThrow("reply lost")
  expect(f.read).toHaveBeenCalledOnce()
})
