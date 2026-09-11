import { beforeEach, describe, expect, it, vi } from "vitest"

const storageMocks = vi.hoisted(() => ({
  getBrowserCdpConfig: vi.fn(),
  getMcpConnectors: vi.fn(),
  upsertMcpConnector: vi.fn()
}))

vi.mock("../../../src/main/storage", () => storageMocks)

import {
  autoRegisterPlaywrightMcpConnector,
  syncPlaywrightMcpConnectorForBrowserCdpConfig
} from "../../../src/main/browser/cdp/browser-playwright-mcp-connector"
import {
  BROWSER_CDP_PORT_MAX,
  BROWSER_CDP_PORT_MIN,
  configureBrowserCdpEndpoint,
  getCurrentBrowserCdpPort
} from "../../../src/main/browser/cdp/browser-cdp"

describe("browser CDP configuration", () => {
  beforeEach(() => {
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, { enabled: false })
    storageMocks.getBrowserCdpConfig.mockReturnValue({
      enabled: true,
      profileImportEnabled: false
    })
    storageMocks.getMcpConnectors.mockReturnValue([])
    storageMocks.upsertMcpConnector.mockReset()
  })

  it("enables CDP with a random private-range port", () => {
    const appendSwitch = vi.fn()

    const port = configureBrowserCdpEndpoint({ appendSwitch })

    expect(port).toBeGreaterThanOrEqual(BROWSER_CDP_PORT_MIN)
    expect(port).toBeLessThanOrEqual(BROWSER_CDP_PORT_MAX)
    expect(appendSwitch).toHaveBeenCalledOnce()
    expect(appendSwitch).toHaveBeenCalledWith("remote-debugging-port", String(port))
  })

  it("stays disabled when the persisted config turns CDP off", () => {
    const appendSwitch = vi.fn()

    expect(configureBrowserCdpEndpoint({ appendSwitch }, { enabled: false })).toBeNull()
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it("keeps the selected port available to CDP clients during this process", () => {
    const port = configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, { enabled: true })

    expect(getCurrentBrowserCdpPort()).toBe(port)
  })
})

describe("autoRegisterPlaywrightMcpConnector", () => {
  beforeEach(() => {
    storageMocks.getMcpConnectors.mockReset()
    storageMocks.upsertMcpConnector.mockReset()
  })

  it("creates or updates the managed connector with the active CDP port", async () => {
    storageMocks.getMcpConnectors.mockReturnValue([
      {
        id: "connector-1",
        name: "In-app-browser",
        kind: "stdio",
        enabled: true,
        lazyLoad: false,
        command: "npx",
        args: [
          "-y",
          "@playwright/mcp@latest",
          "--cdp-endpoint=http://127.0.0.1:55001"
        ],
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      }
    ])

    await autoRegisterPlaywrightMcpConnector(9222)

    expect(storageMocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: "connector-1",
      name: "In-app-browser",
      kind: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint=http://127.0.0.1:9222"],
      env: undefined,
      enabled: true,
      lazyLoad: false
    })
  })

  it("migrates a synced managed connector away from lazy load", async () => {
    storageMocks.getMcpConnectors.mockReturnValue([
      {
        id: "connector-1",
        name: "In-app-browser",
        kind: "stdio",
        enabled: true,
        lazyLoad: true,
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint=http://127.0.0.1:9222"],
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      }
    ])

    await autoRegisterPlaywrightMcpConnector(9222)

    expect(storageMocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: "connector-1",
      name: "In-app-browser",
      kind: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint=http://127.0.0.1:9222"],
      env: undefined,
      enabled: true,
      lazyLoad: false
    })
  })

  it("disables the managed connector when CDP is turned off", async () => {
    storageMocks.getMcpConnectors.mockReturnValue([
      {
        id: "connector-1",
        name: "In-app-browser",
        kind: "stdio",
        enabled: true,
        lazyLoad: false,
        command: "npx",
        args: [
          "-y",
          "@playwright/mcp@latest",
          "--cdp-endpoint=http://127.0.0.1:55001"
        ],
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      }
    ])

    await autoRegisterPlaywrightMcpConnector(null)

    expect(storageMocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: "connector-1",
      name: "In-app-browser",
      kind: "stdio",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        "--cdp-endpoint=http://127.0.0.1:55001"
      ],
      env: undefined,
      enabled: false,
      lazyLoad: false
    })
  })
})

describe("syncPlaywrightMcpConnectorForBrowserCdpConfig", () => {
  beforeEach(() => {
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, { enabled: false })
    storageMocks.getMcpConnectors.mockReset()
    storageMocks.upsertMcpConnector.mockReset()
  })

  it("enables the managed connector when the card is enabled while CDP is live", async () => {
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, {
      enabled: true
    })
    const runtimePort = getCurrentBrowserCdpPort()
    storageMocks.getMcpConnectors.mockReturnValue([
      {
        id: "connector-1",
        name: "In-app-browser",
        kind: "stdio",
        enabled: false,
        lazyLoad: false,
        command: "npx",
        args: [
          "-y",
          "@playwright/mcp@latest",
          `--cdp-endpoint=http://127.0.0.1:${runtimePort}`
        ],
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      }
    ])

    const result = await syncPlaywrightMcpConnectorForBrowserCdpConfig({
      enabled: true,
      profileImportEnabled: false
    })

    expect(storageMocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: "connector-1",
      name: "In-app-browser",
      kind: "stdio",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        `--cdp-endpoint=http://127.0.0.1:${runtimePort}`
      ],
      env: undefined,
      enabled: true,
      lazyLoad: false
    })
    expect(result).toEqual({ invalidateCapabilities: true })
  })

  it("migrates an enabled runtime connector away from lazy load", async () => {
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, {
      enabled: true
    })
    const runtimePort = getCurrentBrowserCdpPort()
    storageMocks.getMcpConnectors.mockReturnValue([
      {
        id: "connector-1",
        name: "In-app-browser",
        kind: "stdio",
        enabled: true,
        lazyLoad: true,
        command: "npx",
        args: [
          "-y",
          "@playwright/mcp@latest",
          `--cdp-endpoint=http://127.0.0.1:${runtimePort}`
        ],
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      }
    ])

    const result = await syncPlaywrightMcpConnectorForBrowserCdpConfig({
      enabled: true,
      profileImportEnabled: false
    })

    expect(storageMocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: "connector-1",
      name: "In-app-browser",
      kind: "stdio",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        `--cdp-endpoint=http://127.0.0.1:${runtimePort}`
      ],
      env: undefined,
      enabled: true,
      lazyLoad: false
    })
    expect(result).toEqual({ invalidateCapabilities: true })
  })

  it("disables the managed connector when the card is disabled", async () => {
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, {
      enabled: true
    })
    const runtimePort = getCurrentBrowserCdpPort()
    storageMocks.getMcpConnectors.mockReturnValue([
      {
        id: "connector-1",
        name: "In-app-browser",
        kind: "stdio",
        enabled: true,
        lazyLoad: false,
        command: "npx",
        args: [
          "-y",
          "@playwright/mcp@latest",
          `--cdp-endpoint=http://127.0.0.1:${runtimePort}`
        ],
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      }
    ])

    const result = await syncPlaywrightMcpConnectorForBrowserCdpConfig({
      enabled: false,
      profileImportEnabled: false
    })

    expect(storageMocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: "connector-1",
      name: "In-app-browser",
      kind: "stdio",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        `--cdp-endpoint=http://127.0.0.1:${runtimePort}`
      ],
      env: undefined,
      enabled: false,
      lazyLoad: false
    })
    expect(result).toEqual({ invalidateCapabilities: true })
  })

  it("waits for restart before enabling the connector when runtime CDP is off", async () => {
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, { enabled: false })
    storageMocks.getMcpConnectors.mockReturnValue([])

    const result = await syncPlaywrightMcpConnectorForBrowserCdpConfig({
      enabled: true,
      profileImportEnabled: false
    })

    expect(storageMocks.upsertMcpConnector).not.toHaveBeenCalled()
    expect(result).toEqual({ invalidateCapabilities: false })
  })
})
