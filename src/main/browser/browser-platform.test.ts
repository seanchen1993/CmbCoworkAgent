import { describe, expect, it } from "vitest"
import {
  getNativePipeKind,
  getOfficialBrowserUseIabPipePath,
  getOfficialBrowserUsePipeBasePath,
  isOfficialBrowserUsePipePath,
  shouldUseBrowserNativePipeDiscoveryServer
} from "./browser-platform"

describe("browser platform native pipe paths", () => {
  it("uses discoverable official named pipe paths for Windows iab backends", () => {
    const basePath = getOfficialBrowserUsePipeBasePath("win32")
    const pipePath = getOfficialBrowserUseIabPipePath("thread-win32", "win32")

    expect(basePath).toBe("\\\\.\\pipe\\codex-browser-use")
    expect(pipePath).toContain(`${basePath}-cmb-iab-`)
    expect(getNativePipeKind(pipePath)).toBe("windows-named-pipe")
    expect(isOfficialBrowserUsePipePath(pipePath, "win32")).toBe(true)
    expect(shouldUseBrowserNativePipeDiscoveryServer(pipePath, "win32")).toBe(true)
    expect(shouldUseBrowserNativePipeDiscoveryServer(pipePath, "darwin")).toBe(false)
  })

  it("keeps Unix iab discovery on marker files instead of named pipe servers", () => {
    const pipePath = getOfficialBrowserUseIabPipePath("thread-linux", "linux")

    expect(pipePath).toContain("/tmp/codex-browser-use/cmb-iab-")
    expect(isOfficialBrowserUsePipePath(pipePath, "linux")).toBe(true)
    expect(shouldUseBrowserNativePipeDiscoveryServer(pipePath, "linux")).toBe(false)
  })
})
