import { describe, expect, it } from "vitest"
import type { BrowserWindow } from "electron"
import { BrowserService, deviceViewportMatchesRequested } from "./browser-service"

describe("deviceViewportMatchesRequested", () => {
  it("accepts a renderer-recomputed preview scale for the requested CSS viewport", () => {
    expect(
      deviceViewportMatchesRequested(
        { width: 390, height: 844, scale: 0.7 },
        { width: 390, height: 844, scale: 0.625 }
      )
    ).toBe(true)
  })

  it("does not accept a different emulated viewport size", () => {
    expect(
      deviceViewportMatchesRequested(
        { width: 393, height: 852, scale: 0.625 },
        { width: 390, height: 844, scale: 0.625 }
      )
    ).toBe(false)
  })

  it("requires both sides to be absent when there is no device preview", () => {
    expect(deviceViewportMatchesRequested(null, undefined)).toBe(false)
    expect(deviceViewportMatchesRequested(undefined, undefined)).toBe(true)
  })
})

describe("BrowserService device viewport lifecycle", () => {
  it("clears an unacknowledged replay viewport when returning home", () => {
    const window = {
      isDestroyed: () => false,
      webContents: { send: () => undefined }
    } as unknown as BrowserWindow
    const service = new BrowserService(() => window)

    service.requestPanel(undefined, undefined, false, {
      width: 390,
      height: 844,
      scale: 0.625
    })
    expect(service.getState().pendingDeviceViewport).toEqual({
      width: 390,
      height: 844,
      scale: 0.625
    })

    expect(service.detach().pendingDeviceViewport).toBeUndefined()
  })

  it("stops waiting for viewport synchronization as soon as playback is cancelled", async () => {
    const service = new BrowserService(() => null)

    await expect(
      service.waitForDeviceViewport({ width: 390, height: 844, scale: 0.625 }, () => true)
    ).resolves.toBeUndefined()
  })
})
