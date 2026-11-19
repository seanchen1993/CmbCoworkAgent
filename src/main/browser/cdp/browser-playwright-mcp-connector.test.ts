import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  connectors: [] as any[],
  upsertMcpConnector: vi.fn(),
  cdpPort: null as number | null
}))

vi.mock("../../storage", () => ({
  getMcpConnectors: () => mocks.connectors,
  upsertMcpConnector: mocks.upsertMcpConnector
}))

vi.mock("./browser-cdp", () => ({
  getCurrentBrowserCdpPort: () => mocks.cdpPort
}))

import {
  autoRegisterPlaywrightMcpConnector,
  resolveBundledPlaywrightMcpCliPath,
  syncPlaywrightMcpConnectorForBrowserCdpConfig
} from "./browser-playwright-mcp-connector"

describe("managed Playwright MCP connector", () => {
  beforeEach(() => {
    mocks.connectors = []
    mocks.cdpPort = null
    mocks.upsertMcpConnector.mockReset()
  })

  it("uses the bundled MCP with Electron's Node runtime", async () => {
    await autoRegisterPlaywrightMcpConnector(19222)

    expect(mocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: undefined,
      name: "In-app-browser",
      kind: "stdio",
      command: process.execPath,
      args: [
        resolveBundledPlaywrightMcpCliPath(),
        "--cdp-endpoint=http://127.0.0.1:19222"
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      enabled: true,
      lazyLoad: false
    })
  })

  it("migrates the former npx connector and preserves custom environment variables", async () => {
    mocks.connectors = [
      {
        id: "builtin-browser",
        name: "In-app-browser",
        kind: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.82"],
        env: { HTTPS_PROXY: "http://proxy.example" },
        enabled: true,
        lazyLoad: false
      }
    ]

    await autoRegisterPlaywrightMcpConnector(19223)

    expect(mocks.upsertMcpConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "builtin-browser",
        command: process.execPath,
        args: [
          resolveBundledPlaywrightMcpCliPath(),
          "--cdp-endpoint=http://127.0.0.1:19223"
        ],
        env: {
          HTTPS_PROXY: "http://proxy.example",
          ELECTRON_RUN_AS_NODE: "1"
        }
      })
    )
  })

  it("does not rewrite an already synchronized connector", async () => {
    mocks.connectors = [
      {
        id: "builtin-browser",
        name: "In-app-browser",
        kind: "stdio",
        command: process.execPath,
        args: [
          resolveBundledPlaywrightMcpCliPath(),
          "--cdp-endpoint=http://127.0.0.1:19224"
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        enabled: true,
        lazyLoad: false
      }
    ]

    await autoRegisterPlaywrightMcpConnector(19224)

    expect(mocks.upsertMcpConnector).not.toHaveBeenCalled()
  })

  it("publishes the bundled connector when an enabled runtime CDP port exists", async () => {
    mocks.cdpPort = 19225

    await expect(
      syncPlaywrightMcpConnectorForBrowserCdpConfig({
        enabled: true,
        profileImportEnabled: false
      })
    ).resolves.toEqual({ invalidateCapabilities: true })

    expect(mocks.upsertMcpConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        enabled: true
      })
    )
  })
})
