import { beforeEach, describe, expect, it, vi } from "vitest"

const cdpMocks = vi.hoisted(() => ({
  getCurrentBrowserCdpPort: vi.fn()
}))

const registryMocks = vi.hoisted(() => ({
  getGlobalBrowserService: vi.fn()
}))

const playwrightMocks = vi.hoisted(() => ({
  connectOverCDP: vi.fn()
}))

vi.mock("../../src/main/browser/cdp/browser-cdp", () => cdpMocks)
vi.mock("../../src/main/browser/core/browser-service-registry", () => registryMocks)
vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: playwrightMocks.connectOverCDP
  }
}))

import { executeRecordingScriptInBuiltinBrowser } from "../../src/main/browser/record/common/browser-script-execution-service"
import {
  cancelRecordingScriptExecutionInBuiltinBrowser,
  getBrowserScriptExecutionState,
  onBrowserScriptExecutionStateChange
} from "../../src/main/browser/record/common/browser-script-execution-service"

describe("browser script execution service", () => {
  beforeEach(() => {
    cdpMocks.getCurrentBrowserCdpPort.mockReturnValue(38127)
    registryMocks.getGlobalBrowserService.mockReturnValue({
      requestPanel: vi.fn(),
      prepareTarget: vi.fn(async () => ({
        sessionId: "app-browser",
        url: "https://example.com",
        title: "Example",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        visible: true,
        created: true,
        consoleEntries: []
      }))
    })
  })

  it("runs the recorded script against the in-app browser page", async () => {
    const states = [] as Array<ReturnType<typeof getBrowserScriptExecutionState>>
    const dispose = onBrowserScriptExecutionStateChange((state) => {
      states.push(state)
    })
    const click = vi.fn(async () => undefined)
    const getByRole = vi.fn(() => ({
      click
    }))
    const goto = vi.fn(async () => undefined)
    const page = {
      getByRole,
      goto,
      title: vi.fn(async () => "Example"),
      url: vi.fn(() => "https://example.com")
    }
    const context = {
      pages: vi.fn(() => [page])
    }
    const browser = {
      contexts: vi.fn(() => [context]),
      disconnect: vi.fn()
    }
    playwrightMocks.connectOverCDP.mockResolvedValue(browser)

    await executeRecordingScriptInBuiltinBrowser({
      script: `import { test } from "@playwright/test";

const baseUrl = "https://example.com";

test("recorded script flow", async ({ page }) => {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Save" }).click();
});
`,
      threadId: "thread-1",
      workspacePath: "/tmp/workspace"
    })

    expect(registryMocks.getGlobalBrowserService).toHaveBeenCalledOnce()
    expect(cdpMocks.getCurrentBrowserCdpPort).toHaveBeenCalledOnce()
    expect(playwrightMocks.connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:38127")
    expect(goto).toHaveBeenCalledWith("https://example.com")
    expect(getByRole).toHaveBeenCalledWith("button", { name: "Save" })
    expect(click).toHaveBeenCalledOnce()
    expect(browser.disconnect).toHaveBeenCalledOnce()
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "running", progressPercent: 0 }),
        expect.objectContaining({ status: "completed", progressPercent: 100 })
      ])
    )
    expect(
      states.some(
        (state) =>
          state.status === "running" &&
          typeof state.progressPercent === "number" &&
          state.progressPercent > 0 &&
          state.progressPercent < 100
      )
    ).toBe(true)
    dispose()
  })

  it("replays nth-disambiguated locators against the in-app browser page", async () => {
    const click = vi.fn(async () => undefined)
    const nth = vi.fn(() => ({
      click
    }))
    const getByRole = vi.fn(() => ({
      nth
    }))
    const page = {
      getByRole,
      title: vi.fn(async () => "Example"),
      url: vi.fn(() => "https://example.com")
    }
    const context = {
      pages: vi.fn(() => [page])
    }
    const browser = {
      contexts: vi.fn(() => [context]),
      disconnect: vi.fn()
    }
    playwrightMocks.connectOverCDP.mockResolvedValue(browser)

    await executeRecordingScriptInBuiltinBrowser({
      script: `import { test } from "@playwright/test";

test("recorded script flow", async ({ page }) => {
  await page.getByRole("button", { name: "Search" }).nth(1).click();
});
`
    })

    expect(getByRole).toHaveBeenCalledWith("button", { name: "Search" })
    expect(nth).toHaveBeenCalledWith(1)
    expect(click).toHaveBeenCalledOnce()
  })

  it("selects the BrowserPanel target instead of the first Electron page", async () => {
    const appPage = {
      getByRole: vi.fn(),
      title: vi.fn(async () => "CmbCoworkAgent"),
      url: vi.fn(() => "http://localhost:5173")
    }
    const click = vi.fn(async () => undefined)
    const browserPanelPage = {
      getByRole: vi.fn(() => ({ click })),
      title: vi.fn(async () => "Example"),
      url: vi.fn(() => "https://example.com")
    }
    const appContext = {
      pages: vi.fn(() => [appPage])
    }
    const browserPanelContext = {
      pages: vi.fn(() => [browserPanelPage])
    }
    const browser = {
      contexts: vi.fn(() => [appContext, browserPanelContext]),
      disconnect: vi.fn()
    }
    playwrightMocks.connectOverCDP.mockResolvedValue(browser)

    await executeRecordingScriptInBuiltinBrowser({
      script: `import { test } from "@playwright/test";

test("recorded script flow", async ({ page }) => {
  await page.getByRole("button", { name: "Save" }).click();
});
`
    })

    expect(browserPanelPage.getByRole).toHaveBeenCalledWith("button", { name: "Save" })
    expect(click).toHaveBeenCalledOnce()
    expect(appPage.getByRole).not.toHaveBeenCalled()
  })

  it("replaces script variables before executing navigation steps", async () => {
    const goto = vi.fn(async () => undefined)
    const browserPanelPage = {
      goto,
      title: vi.fn(async () => "Example"),
      url: vi.fn(() => "https://example.com")
    }
    const browserPanelContext = {
      pages: vi.fn(() => [browserPanelPage])
    }
    const browser = {
      contexts: vi.fn(() => [browserPanelContext]),
      disconnect: vi.fn()
    }
    playwrightMocks.connectOverCDP.mockResolvedValue(browser)

    await executeRecordingScriptInBuiltinBrowser({
      script: `import { test } from "@playwright/test";

const 变量_目标地址 = ""; // 变量-目标地址

test("recorded script flow", async ({ page }) => {
  await page.goto(变量_目标地址);
});
`,
      variableValues: {
        变量_目标地址: "https://example.com/login"
      }
    })

    expect(goto).toHaveBeenCalledWith("https://example.com/login")
  })

  it("executes legacy scripts with TypeScript array variable annotations", async () => {
    const setInputFiles = vi.fn(async () => undefined)
    const locator = {
      setInputFiles
    }
    const page = {
      locator: vi.fn(() => locator),
      title: vi.fn(async () => "Example"),
      url: vi.fn(() => "https://example.com")
    }
    const context = {
      pages: vi.fn(() => [page])
    }
    const browser = {
      contexts: vi.fn(() => [context]),
      disconnect: vi.fn()
    }
    playwrightMocks.connectOverCDP.mockResolvedValue(browser)

    await executeRecordingScriptInBuiltinBrowser({
      script: `import { test } from "@playwright/test";

const 变量_上传文件路径: string[] = ["/tmp/first.txt", "/tmp/second.txt"]; // 变量-上传文件路径

test("recorded script flow", async ({ page }) => {
  await page.locator("input[type=\\"file\\"]").setInputFiles(变量_上传文件路径);
});
`
    })

    expect(setInputFiles).toHaveBeenCalledWith(["/tmp/first.txt", "/tmp/second.txt"])
  })

  it("supports cancelling a running replay", async () => {
    const waitForTimeout = vi.fn(
      () =>
        new Promise<void>(() => {
          // never resolves until the replay is cancelled
        })
    )
    const browserPanelPage = {
      getByRole: vi.fn(),
      title: vi.fn(async () => "Example"),
      url: vi.fn(() => "https://example.com"),
      waitForTimeout
    }
    const browserPanelContext = {
      pages: vi.fn(() => [browserPanelPage])
    }
    const browser = {
      contexts: vi.fn(() => [browserPanelContext]),
      disconnect: vi.fn()
    }
    playwrightMocks.connectOverCDP.mockResolvedValue(browser)

    const executionPromise = executeRecordingScriptInBuiltinBrowser({
      script: `import { test } from "@playwright/test";

test("recorded script flow", async ({ page }) => {
  await page.waitForTimeout(100000);
});
`
    })

    expect(getBrowserScriptExecutionState()).toMatchObject({
      status: "running",
      progressPercent: 0
    })
    expect(await cancelRecordingScriptExecutionInBuiltinBrowser()).toBe(true)
    await expect(executionPromise).rejects.toThrow("回放已终止")
    expect(getBrowserScriptExecutionState().status).toBe("cancelled")
  })

  it("resolves relative upload paths against the workspace path", async () => {
    const setInputFiles = vi.fn(async () => undefined)
    const locator = {
      setInputFiles
    }
    const page = {
      locator: vi.fn(() => locator),
      title: vi.fn(async () => "Example"),
      url: vi.fn(() => "https://example.com")
    }
    const context = {
      pages: vi.fn(() => [page])
    }
    const browser = {
      contexts: vi.fn(() => [context]),
      disconnect: vi.fn()
    }
    playwrightMocks.connectOverCDP.mockResolvedValue(browser)

    await executeRecordingScriptInBuiltinBrowser({
      script: `import { test } from "@playwright/test";

test("recorded script flow", async ({ page }) => {
  await page.locator("#avatar").setInputFiles("think.webp");
});
`,
      workspacePath: "/tmp/workspace"
    })

    expect(page.locator).toHaveBeenCalledWith("#avatar")
    expect(setInputFiles).toHaveBeenCalledWith("/tmp/workspace/think.webp")
  })
})
