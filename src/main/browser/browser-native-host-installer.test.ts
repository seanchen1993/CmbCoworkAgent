import { describe, expect, it } from "vitest"
import { CMB_BROWSER_NATIVE_HOST_FLAG } from "./browser-native-messaging-host"
import { createWindowsNativeHostWrapper } from "./browser-native-host-installer"

describe("browser native host installer", () => {
  it("creates a quiet wrapper that runs only the dedicated host entry", () => {
    const wrapper = createWindowsNativeHostWrapper(
      "C:\\Program Files\\CMBDevClaw\\CMBDevClaw.exe",
      "C:\\Program Files\\CMBDevClaw\\resources\\app.asar\\out\\main\\browser-native-host.js"
    )

    expect(wrapper).toContain("@echo off\r\n")
    expect(wrapper).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(wrapper).toContain(`browser-native-host.js" ${CMB_BROWSER_NATIVE_HOST_FLAG} %*`)
    expect(wrapper).not.toContain("out\\main\\index.js")
  })

  it("escapes percent signs so batch variable expansion cannot change a path", () => {
    const wrapper = createWindowsNativeHostWrapper("C:\\Apps\\100%\\app.exe", "C:\\host.js")
    expect(wrapper).toContain('"C:\\Apps\\100%%\\app.exe"')
  })
})
