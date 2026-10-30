import { afterEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  connectors: vi.fn(),
  plugins: vi.fn(),
  config: vi.fn(),
  client: vi.fn(function () {
    throw Error("Metadata must not initialize an MCP client")
  })
}))
vi.mock("../storage", () => ({
  getEnabledMcpConnectors: mocks.connectors,
  getPlugins: mocks.plugins,
  getUserInfo: () => ({}),
  parseMcpJsonFile: mocks.config
}))
vi.mock("../ipc/mcp", () => ({ buildMcpServerConfig: (value: unknown) => value }))
vi.mock("@langchain/mcp-adapters", () => ({ MultiServerMCPClient: mocks.client }))
vi.mock("../mods/manager", () => ({ authorizeCurrentModInput: vi.fn() }))
vi.mock("../mods/adapters", () => ({ withRawModMcp: vi.fn(), publishCurrentModResult: vi.fn() }))
vi.mock("../browser/cdp/in-app-browser-mcp-tools", () => ({
  shouldSuppressInAppBrowserMcpTool: () => false
}))
import {
  closeGlobalMcpCapabilityService,
  getGlobalMcpCapabilityService
} from "./capability-service"

afterEach(async () => {
  await closeGlobalMcpCapabilityService()
  vi.clearAllMocks()
})

it("exposes fresh configured names before discovery without a transport or credential projection", () => {
  mocks.connectors.mockReturnValue([
    {
      id: "connector",
      name: "Company Mail",
      kind: "stdio",
      command: "fixture",
      env: { KEY: "private" }
    }
  ])
  mocks.plugins.mockReturnValue([
    { id: "plugin", enabled: true, mcpServerCount: 1, path: "/plugins/demo" }
  ])
  mocks.config.mockReturnValue({
    "Private Server": { command: "fixture", env: { KEY: "private" } }
  })
  const service = getGlobalMcpCapabilityService()
  expect(service.configuredServerNames?.()).toEqual(["Company Mail", "Private Server"])
  expect(service.peekTools?.()).toBeNull()
  mocks.connectors.mockReturnValue([])
  mocks.plugins.mockReturnValue([])
  expect(service.configuredServerNames?.()).toEqual([])
  expect(mocks.client).not.toHaveBeenCalled()
})
