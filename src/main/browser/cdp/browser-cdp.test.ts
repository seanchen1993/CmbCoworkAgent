import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_BROWSER_CDP_PORT } from "../../../shared/browser-types"

const storageMocks = vi.hoisted(() => ({
  getBrowserCdpConfig: vi.fn(),
  getMcpConnectors: vi.fn(),
  upsertMcpConnector: vi.fn()
}))

vi.mock("../../storage", () => storageMocks)

import {
  autoRegisterPlaywrightMcpConnector,
  syncPlaywrightMcpConnectorForBrowserCdpConfig
} from "./browser-playwright-mcp-connector"
import {
  configureBrowserCdpEndpoint,
  resolveBrowserCdpPort
} from "./browser-cdp"

describe("browser CDP configuration", () => {
  beforeEach(() => {
    storageMocks.getBrowserCdpConfig.mockReturnValue({
      enabled: true,
      profileImportEnabled: false,
      port: DEFAULT_BROWSER_CDP_PORT
    })
    storageMocks.getMcpConnectors.mockReturnValue([])
    storageMocks.upsertMcpConnector.mockReset()
  })

  it("enables CDP with the default port when persisted config is available", () => {
    const appendSwitch = vi.fn()

    expect(configureBrowserCdpEndpoint({ appendSwitch })).toBe(DEFAULT_BROWSER_CDP_PORT)
    expect(appendSwitch).toHaveBeenCalledOnce()
    expect(appendSwitch).toHaveBeenCalledWith(
      "remote-debugging-port",
      String(DEFAULT_BROWSER_CDP_PORT)
    )
  })

  it("stays disabled when the persisted config turns CDP off", () => {
    const appendSwitch = vi.fn()

    expect(configureBrowserCdpEndpoint({ appendSwitch }, { enabled: false })).toBeNull()
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it("uses the configured CDP port when set", () => {
    const appendSwitch = vi.fn()

    expect(configureBrowserCdpEndpoint({ appendSwitch }, { port: 9222 })).toBe(9222)
    expect(appendSwitch).toHaveBeenCalledOnce()
    expect(appendSwitch).toHaveBeenCalledWith("remote-debugging-port", "9222")
  })
})

describe("resolveBrowserCdpPort", () => {
  beforeEach(() => {
    storageMocks.getBrowserCdpConfig.mockReturnValue({
      enabled: true,
      profileImportEnabled: false,
      port: DEFAULT_BROWSER_CDP_PORT
    })
  })

  it("returns the default port when persisted config is absent", () => {
    expect(resolveBrowserCdpPort({})).toBe(DEFAULT_BROWSER_CDP_PORT)
  })

  it("returns null when CDP is disabled", () => {
    expect(resolveBrowserCdpPort({ enabled: false })).toBeNull()
  })

  it("uses the configured port when set", () => {
    expect(resolveBrowserCdpPort({ port: 9333 })).toBe(9333)
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
          `--cdp-endpoint=http://127.0.0.1:${DEFAULT_BROWSER_CDP_PORT}`
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
          `--cdp-endpoint=http://127.0.0.1:${DEFAULT_BROWSER_CDP_PORT}`
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
        `--cdp-endpoint=http://127.0.0.1:${DEFAULT_BROWSER_CDP_PORT}`
      ],
      env: undefined,
      enabled: false,
      lazyLoad: false
    })
  })
})

describe("syncPlaywrightMcpConnectorForBrowserCdpConfig", () => {
  beforeEach(() => {
    storageMocks.getMcpConnectors.mockReset()
    storageMocks.upsertMcpConnector.mockReset()
  })

  it("enables the managed connector when the card is enabled while CDP is live", async () => {
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, {
      enabled: true,
      port: DEFAULT_BROWSER_CDP_PORT
    })
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
          `--cdp-endpoint=http://127.0.0.1:${DEFAULT_BROWSER_CDP_PORT}`
        ],
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      }
    ])

    const result = await syncPlaywrightMcpConnectorForBrowserCdpConfig({
      enabled: true,
      profileImportEnabled: false,
      port: 9222
    })

    expect(storageMocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: "connector-1",
      name: "In-app-browser",
      kind: "stdio",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        `--cdp-endpoint=http://127.0.0.1:${DEFAULT_BROWSER_CDP_PORT}`
      ],
      env: undefined,
      enabled: true,
      lazyLoad: false
    })
    expect(result).toEqual({ invalidateCapabilities: true })
  })

  it("disables the managed connector when the card is disabled", async () => {
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, {
      enabled: true,
      port: DEFAULT_BROWSER_CDP_PORT
    })
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
          `--cdp-endpoint=http://127.0.0.1:${DEFAULT_BROWSER_CDP_PORT}`
        ],
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      }
    ])

    const result = await syncPlaywrightMcpConnectorForBrowserCdpConfig({
      enabled: false,
      profileImportEnabled: false,
      port: DEFAULT_BROWSER_CDP_PORT
    })

    expect(storageMocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: "connector-1",
      name: "In-app-browser",
      kind: "stdio",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        `--cdp-endpoint=http://127.0.0.1:${DEFAULT_BROWSER_CDP_PORT}`
      ],
      env: undefined,
      enabled: false,
      lazyLoad: false
    })
    expect(result).toEqual({ invalidateCapabilities: true })
  })

  it("persists the connector enabled state without reloading capabilities when runtime CDP is off", async () => {
    configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, { enabled: false })
    storageMocks.getMcpConnectors.mockReturnValue([])

    const result = await syncPlaywrightMcpConnectorForBrowserCdpConfig({
      enabled: true,
      profileImportEnabled: false,
      port: 9222
    })

    expect(storageMocks.upsertMcpConnector).toHaveBeenCalledWith({
      id: undefined,
      name: "In-app-browser",
      kind: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint=http://127.0.0.1:9222"],
      env: undefined,
      enabled: true,
      lazyLoad: false
    })
    expect(result).toEqual({ invalidateCapabilities: false })
  })
})
