import { readFileSync } from "fs"
import { resolve } from "path"
import { runInNewContext } from "vm"
import { describe, expect, it, vi } from "vitest"

class FakeElement {
  textContent = ""
  hidden = false
  disabled = false
  readonly dataset: Record<string, string> = {}
  private readonly listeners = new Map<string, Array<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    const current = this.listeners.get(type) ?? []
    current.push(listener)
    this.listeners.set(type, current)
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener()
  }
}

function loadPopup({
  permissionGranted,
  userAgent
}: {
  permissionGranted: boolean
  userAgent: string
}) {
  const status = new FakeElement()
  const result = new FakeElement()
  const authorize = new FakeElement()
  authorize.textContent = "授权读取网站 Cookie"
  const reconnect = new FakeElement()
  const statusCard = new FakeElement()
  const elements = new Map<string, FakeElement>([
    ["#status", status],
    ["#result", result],
    ["#authorize", authorize],
    ["#reconnect", reconnect],
    ["#status-card", statusCard]
  ])

  const sendMessage = vi.fn(
    (
      message: { type: string },
      callback: (value: {
        connected: boolean
        nativeHostError: string
        permissionGranted: boolean
      }) => void
    ) => {
      if (message.type === "popup-status") {
        callback({
          connected: true,
          nativeHostError: "",
          permissionGranted
        })
        return
      }
      callback({
        connected: true,
        nativeHostError: "",
        permissionGranted
      })
    }
  )
  const permissionRequest = vi.fn(
    (_details: { origins: string[] }, callback: (granted: boolean) => void) => callback(true)
  )

  const chrome = {
    permissions: {
      request: permissionRequest
    },
    runtime: {
      id: "lnfdbegfbhhlfimnojpalnkmhkgfahin",
      lastError: undefined as { message: string } | undefined,
      sendMessage
    }
  }

  const source = readFileSync(resolve(process.cwd(), "chrome-extension/popup.js"), "utf8")
  runInNewContext(source, {
    chrome,
    document: {
      querySelector: (selector: string) => elements.get(selector) ?? null
    },
    navigator: { userAgent },
    setInterval: vi.fn(() => 1),
    setTimeout: (callback: () => void) => {
      callback()
      return 1
    }
  })

  return { authorize, permissionRequest, result, sendMessage, status }
}

describe("Chrome extension popup authorization flow", () => {
  it("shows a manual authorization guide on Chrome 94 instead of requesting runtime permissions", () => {
    const popup = loadPopup({
      permissionGranted: false,
      userAgent: "Mozilla/5.0 Chrome/94.0.4606.81 Safari/537.36"
    })

    expect(popup.status.textContent).toBe("已连接，等待 Chrome 站点访问授权")
    expect(popup.authorize.textContent).toBe("查看授权步骤")

    popup.authorize.click()

    expect(popup.permissionRequest).not.toHaveBeenCalled()
    expect(popup.status.textContent).toBe("请在扩展详情页授予站点访问")
    expect(popup.authorize.textContent).toBe("我已完成，重新检查")
  })

  it("requests runtime permissions on modern Chrome", () => {
    const popup = loadPopup({
      permissionGranted: false,
      userAgent: "Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36"
    })

    expect(popup.status.textContent).toBe("已连接，等待 Cookie 授权")

    popup.authorize.click()

    expect(popup.permissionRequest).toHaveBeenCalledWith(
      { origins: ["http://*/*", "https://*/*"] },
      expect.any(Function)
    )
  })
})
