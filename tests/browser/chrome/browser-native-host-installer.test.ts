import { describe, expect, it } from "vitest"
import { createWindowsNativeHostWrapper } from "../../../src/main/browser/chrome/browser-native-host-installer"

describe("Windows browser native host wrapper", () => {
  it("uses UTF-8 before launching from a path containing Chinese characters", () => {
    const wrapper = createWindowsNativeHostWrapper(
      "C:\\Users\\80327443\\Desktop\\CMBDevClaw-win-unpacked-1.4.10-内置浏览器4\\CMBDevClaw.exe",
      "C:\\Users\\80327443\\Desktop\\CMBDevClaw-win-unpacked-1.4.10-内置浏览器4\\resources\\app.asar\\out\\main\\browser-native-host.js"
    )

    expect(wrapper).toContain("@echo off\r\nchcp 65001 >nul\r\nsetlocal")
    expect(wrapper).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(wrapper).toContain(
      '"C:\\Users\\80327443\\Desktop\\CMBDevClaw-win-unpacked-1.4.10-内置浏览器4\\CMBDevClaw.exe"'
    )
    expect(wrapper).toContain(
      '"C:\\Users\\80327443\\Desktop\\CMBDevClaw-win-unpacked-1.4.10-内置浏览器4\\resources\\app.asar\\out\\main\\browser-native-host.js"'
    )
  })

  it("escapes percent characters in Windows paths", () => {
    const wrapper = createWindowsNativeHostWrapper(
      "C:\\100%\\CMBDevClaw.exe",
      "C:\\100%\\browser-native-host.js"
    )

    expect(wrapper).toContain('"C:\\100%%\\CMBDevClaw.exe"')
    expect(wrapper).toContain('"C:\\100%%\\browser-native-host.js"')
  })
})
