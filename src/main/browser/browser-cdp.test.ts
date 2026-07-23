import { describe, expect, it, vi } from "vitest"
import {
  BROWSER_CDP_PORT_ENV,
  configureBrowserCdpEndpoint,
  parseBrowserCdpPort
} from "./browser-cdp"

describe("browser CDP configuration", () => {
  it("stays disabled when the port environment variable is absent", () => {
    const appendSwitch = vi.fn()

    expect(configureBrowserCdpEndpoint({ appendSwitch }, {})).toBeNull()
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it("enables Electron remote debugging with the configured port", () => {
    const appendSwitch = vi.fn()

    expect(
      configureBrowserCdpEndpoint({ appendSwitch }, { [BROWSER_CDP_PORT_ENV]: " 9222 " })
    ).toBe(9222)
    expect(appendSwitch).toHaveBeenCalledOnce()
    expect(appendSwitch).toHaveBeenCalledWith("remote-debugging-port", "9222")
  })

  it.each(["0", "65536", "abc", "9222.5"])("rejects invalid port %s", (value) => {
    expect(() => parseBrowserCdpPort(value)).toThrow(
      `${BROWSER_CDP_PORT_ENV} must be an integer between 1 and 65535`
    )
  })
})
