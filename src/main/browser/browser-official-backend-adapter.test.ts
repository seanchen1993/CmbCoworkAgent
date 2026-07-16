import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { pathToFileURL } from "url"
import { describe, expect, it, vi } from "vitest"
import type { BrowserService } from "./browser-service"
import { DEFAULT_BROWSER_PERFORMANCE_BUDGET } from "./browser-performance-budget"
import { createBrowserOfficialBackendAdapter } from "./browser-official-backend-adapter"
import type { BrowserNativePipeTransport } from "./browser-native-pipe-server"

const EMPTY_TRANSPORT: BrowserNativePipeTransport = {
  sendNotification: () => undefined
}

function state() {
  return {
    canGoBack: false,
    canGoForward: false,
    consoleEntries: [],
    created: true,
    isLoading: false,
    sessionId: "adapter-session",
    title: "",
    url: "about:blank",
    visible: false
  }
}

function createFakeService(): BrowserService {
  const browserState = state()
  return {
    attach: vi.fn(() => browserState),
    click: vi.fn(async () => browserState),
    evaluateInPage: vi.fn(async () => ({ title: "from-service" })),
    getState: vi.fn(() => browserState),
    mouseDown: vi.fn(async () => browserState),
    mouseUp: vi.fn(async () => browserState),
    moveMouse: vi.fn(async () => browserState),
    press: vi.fn(() => browserState),
    readRenderedState: vi.fn(async () => ({
      success: true,
      state: {
        html: undefined,
        sessionId: "adapter-session",
        text: "Service rendered text",
        title: "Service Rendered",
        truncated: false,
        url: "about:blank"
      }
    })),
    requestPanel: vi.fn(),
    scroll: vi.fn(async () => browserState),
    typeText: vi.fn(async () => browserState)
  } as unknown as BrowserService
}

function createAdapter(service: BrowserService) {
  return createBrowserOfficialBackendAdapter({
    budget: DEFAULT_BROWSER_PERFORMANCE_BUDGET,
    getService: () => service,
    sessionId: "adapter-session",
    threadId: "adapter-thread",
    workspacePath: "/tmp/workspace"
  })
}

describe("browser official iab backend adapter", () => {
  it("maps official mouse CDP events to BrowserService mouse events", async () => {
    const service = createFakeService()
    const adapter = createAdapter(service)

    await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { type: "mouseMoved", x: 42, y: 24 },
        method: "Input.dispatchMouseEvent",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { button: "left", clickCount: 2, type: "mousePressed", x: 42, y: 24 },
        method: "Input.dispatchMouseEvent",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { button: "left", clickCount: 2, type: "mouseReleased", x: 42, y: 24 },
        method: "Input.dispatchMouseEvent",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )

    expect(service.moveMouse).toHaveBeenCalledWith("adapter-session", { x: 42, y: 24 })
    expect(service.mouseDown).toHaveBeenCalledWith("adapter-session", { x: 42, y: 24 }, "left", 2)
    expect(service.mouseUp).toHaveBeenCalledWith("adapter-session", { x: 42, y: 24 }, "left", 2)
    expect(service.click).not.toHaveBeenCalled()
  })

  it("maps official moveMouse RPC and scroll CDP events to BrowserService input", async () => {
    const service = createFakeService()
    const adapter = createAdapter(service)

    await adapter.handleRequest("moveMouse", { tabId: 1, x: 12, y: 34 }, EMPTY_TRANSPORT)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { x: 80, xDistance: -15, y: 90, yDistance: -240 },
        method: "Input.synthesizeScrollGesture",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )

    expect(service.moveMouse).toHaveBeenCalledWith("adapter-session", { x: 12, y: 34 })
    expect(service.scroll).toHaveBeenCalledWith("adapter-session", {
      x: 80,
      y: 90,
      deltaX: 15,
      deltaY: 240
    })
  })

  it("maps official text input CDP events to BrowserService text insertion", async () => {
    const service = createFakeService()
    const adapter = createAdapter(service)

    await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { text: "hello" },
        method: "Input.insertText",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { key: "a", text: "a", type: "keyDown" },
        method: "Input.dispatchKeyEvent",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )

    expect(service.typeText).toHaveBeenNthCalledWith(1, "adapter-session", "hello")
    expect(service.typeText).toHaveBeenNthCalledWith(2, "adapter-session", "a")
    expect(service.press).not.toHaveBeenCalled()
  })

  it("maps official control key CDP events to BrowserService key presses", async () => {
    const service = createFakeService()
    const adapter = createAdapter(service)

    await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { code: "Enter", key: "Enter", text: "\r", type: "keyDown" },
        method: "Input.dispatchKeyEvent",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )

    expect(service.press).toHaveBeenCalledWith("adapter-session", "Enter")
    expect(service.typeText).not.toHaveBeenCalled()
  })

  it("passes readonly Runtime.evaluate calls through to BrowserService when available", async () => {
    const service = createFakeService()
    const adapter = createAdapter(service)

    const result = await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { expression: "document.title", returnByValue: true },
        method: "Runtime.evaluate",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )

    expect(service.evaluateInPage).toHaveBeenCalledWith("adapter-session", "document.title")
    expect(result).toEqual({
      result: {
        type: "object",
        value: { title: "from-service" }
      }
    })
  })

  it("falls back to nested canvas or image data when getElementById(...).toDataURL is not available", async () => {
    const service = createFakeService()
    const evaluateInPage = vi.mocked(service.evaluateInPage)
    evaluateInPage
      .mockRejectedValueOnce(new Error("c.toDataURL is not a function"))
      .mockResolvedValueOnce("data:image/png;base64,captcha")
    const adapter = createAdapter(service)
    const expression = `(() => {
      "use strict";
      const __playwrightFunction = () => {
        const c = document.getElementById('captchaCanvas');
        if (!c) return null;
        return c.toDataURL('image/png');
      };
      return __playwrightFunction();
    }).call(windowObject)`

    const result = await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { expression, returnByValue: true },
        method: "Runtime.evaluate",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )

    expect(result).toEqual({
      result: {
        type: "string",
        value: "data:image/png;base64,captcha"
      }
    })
    expect(evaluateInPage).toHaveBeenNthCalledWith(1, "adapter-session", expression)
    expect(evaluateInPage).toHaveBeenNthCalledWith(
      2,
      "adapter-session",
      expect.stringContaining('document.getElementById("captchaCanvas")')
    )
    expect(evaluateInPage.mock.calls[1]?.[1]).toContain('querySelector("canvas")')
    expect(evaluateInPage.mock.calls[1]?.[1]).toContain('querySelector("img")')
  })

  it("supports the Runtime binding methods required by official locator fill", async () => {
    const service = createFakeService()
    const adapter = createAdapter(service)

    await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { name: "__browserUseClipboard_test" },
        method: "Runtime.addBinding",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    const scriptResult = await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: {
          runImmediately: true,
          source: "globalThis.__browserUseClipboardBridge = { bindingName: '__browserUseClipboard_test', cleanup(){} };"
        },
        method: "Page.addScriptToEvaluateOnNewDocument",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { name: "__browserUseClipboard_test" },
        method: "Runtime.removeBinding",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { identifier: "iab-script-1" },
        method: "Page.removeScriptToEvaluateOnNewDocument",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { objectId: "object-1" },
        method: "Runtime.releaseObject",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )

    expect(scriptResult).toEqual({ identifier: "iab-script-1" })
    expect(service.evaluateInPage).toHaveBeenCalledWith(
      "adapter-session",
      expect.stringContaining("__cmbBrowserUseVirtualClipboardItems")
    )
    expect(service.evaluateInPage).toHaveBeenCalledWith(
      "adapter-session",
      "globalThis.__browserUseClipboardBridge = { bindingName: '__browserUseClipboard_test', cleanup(){} };"
    )
    expect(service.evaluateInPage).toHaveBeenCalledWith(
      "adapter-session",
      "Reflect.deleteProperty(globalThis, \"__browserUseClipboard_test\")"
    )
  })

  it("advertises and backs the pageAssets list and bundle CDP subsets", async () => {
    const adapter = createBrowserOfficialBackendAdapter({
      budget: DEFAULT_BROWSER_PERFORMANCE_BUDGET,
      getService: () => null,
      sessionId: "adapter-session",
      workspacePath: "/tmp/workspace"
    })
    const evaluate = (expression: string): Promise<unknown> =>
      adapter.handleRequest(
        "executeCdp",
        {
          commandParams: { expression, returnByValue: true },
          method: "Runtime.evaluate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )

    await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { url: "about:blank" },
        method: "Page.navigate",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    await evaluate(`(() => {
      "use strict";
      document.body.innerHTML = '<img src="https://assets.example/logo.png"><link rel="stylesheet" href="https://assets.example/site.css"><svg aria-label="Brand"><title>Ignored</title><path></path></svg>';
    }).call(windowObject)`)

    const info = await adapter.handleRequest("getInfo", {}, EMPTY_TRANSPORT)
    const snapshot = await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: {
          computedStyles: [
            "background-image",
            "border-image-source",
            "cursor",
            "list-style-image",
            "mask-image"
          ],
          includeDOMRects: false
        },
        method: "DOMSnapshot.captureSnapshot",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    const resources = await evaluate(`performance.getEntriesByType("resource").map((entry) => ({
      initiatorType: "initiatorType" in entry ? entry.initiatorType : undefined,
      name: entry.name,
    }))`)
    const svgs = await evaluate(`Array.from(document.querySelectorAll("svg")).map((svg, index) => ({
      markup: svg.outerHTML,
      name:
        svg.getAttribute("aria-label") ||
        svg.querySelector("title")?.textContent?.trim() ||
        svg.id ||
        "svg-" + (index + 1),
    }))`)
    const resourceTree = await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: {},
        method: "Page.getResourceTree",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    const stylesheetContent = (await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { frameId: "frame-1", url: "https://assets.example/site.css" },
        method: "Page.getResourceContent",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )) as { base64Encoded?: boolean; content?: string }

    expect(info).toEqual(
      expect.objectContaining({
        capabilities: expect.objectContaining({
          tab: [expect.objectContaining({ id: "pageAssets" })]
        })
      })
    )
    expect(snapshot).toEqual(
      expect.objectContaining({
        documents: [
          expect.objectContaining({
            nodes: expect.objectContaining({
              backendNodeId: expect.arrayContaining([1])
            })
          })
        ],
        strings: expect.arrayContaining(["img", "link", "src", "href"])
      })
    )
    expect(resourceTree).toEqual(
      expect.objectContaining({
        frameTree: expect.objectContaining({
          resources: expect.arrayContaining([
            expect.objectContaining({
              mimeType: "image/png",
              url: "https://assets.example/logo.png"
            }),
            expect.objectContaining({
              mimeType: "text/css",
              url: "https://assets.example/site.css"
            })
          ])
        })
      })
    )
    expect(stylesheetContent.base64Encoded).toBe(true)
    expect(
      stylesheetContent.content
        ? Buffer.from(stylesheetContent.content, "base64").toString("utf8")
        : ""
    ).toContain("Bundled stylesheet placeholder")
    expect(resources).toEqual({
      result: {
        type: "object",
        value: expect.arrayContaining([
          { initiatorType: "img", name: "https://assets.example/logo.png" },
          { initiatorType: "css", name: "https://assets.example/site.css" }
        ])
      }
    })
    expect(svgs).toEqual({
      result: {
        type: "object",
        value: [
          expect.objectContaining({
            markup: expect.stringContaining("<svg"),
            name: "Brand"
          })
        ]
      }
    })
  })

  it("provides a bounded local readonly evaluation fallback for file URLs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-browser-local-eval-"))
    try {
      const filePath = join(root, "page.html")
      writeFileSync(
        filePath,
        "<!doctype html><title>Local Eval</title><body><h1>Hello</h1><p>Fallback text</p><script>ignored()</script></body>",
        "utf8"
      )
      const adapter = createBrowserOfficialBackendAdapter({
        budget: DEFAULT_BROWSER_PERFORMANCE_BUDGET,
        getService: () => null,
        sessionId: "adapter-session",
        workspacePath: root
      })
      const url = pathToFileURL(filePath).href

      await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
      await adapter.handleRequest(
        "executeCdp",
        {
          commandParams: { url },
          method: "Page.navigate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )
      const result = await adapter.handleRequest(
        "executeCdp",
        {
          commandParams: {
            expression: "(() => ({ title: document.title, href: location.href, text: document.body.innerText }))()",
            returnByValue: true
          },
          method: "Runtime.evaluate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )

      expect(result).toEqual({
        result: {
          type: "object",
          value: {
            href: url,
            text: "Hello Fallback text",
            title: "Local Eval"
          }
        }
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("provides a bounded local ARIA snapshot fallback for official domSnapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-browser-local-snapshot-"))
    try {
      const filePath = join(root, "page.html")
      writeFileSync(
        filePath,
        "<!doctype html><title>Snapshot Page</title><body><main><h1>Hello</h1><p>Snapshot text</p></main></body>",
        "utf8"
      )
      const adapter = createBrowserOfficialBackendAdapter({
        budget: DEFAULT_BROWSER_PERFORMANCE_BUDGET,
        getService: () => null,
        sessionId: "adapter-session",
        workspacePath: root
      })
      const url = pathToFileURL(filePath).href

      await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
      await adapter.handleRequest(
        "executeCdp",
        {
          commandParams: { url },
          method: "Page.navigate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )
      const result = await adapter.handleRequest(
        "executeCdp",
        {
          commandParams: {
            expression: `(() => {
              const injected = window.__codexPlaywrightInjected;
              return ((helper) => helper.incrementalAriaSnapshot(document.body, { mode: "ai" }))(injected);
            })()`,
            returnByValue: true
          },
          method: "Runtime.evaluate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )

      expect(result).toEqual({
        result: {
          type: "object",
          value: {
            full: '- document "Snapshot Page":\n  - text "Hello Snapshot text"',
            iframeDepths: {},
            iframeRefs: []
          }
        }
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("provides bounded local Playwright locator read fallbacks for file URLs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-browser-local-locator-"))
    try {
      const filePath = join(root, "page.html")
      writeFileSync(
        filePath,
        '<!doctype html><title>Locator Page</title><body><main><p data-kind="first">Alpha</p><p class="target">Beta</p></main></body>',
        "utf8"
      )
      const adapter = createBrowserOfficialBackendAdapter({
        budget: DEFAULT_BROWSER_PERFORMANCE_BUDGET,
        getService: () => null,
        sessionId: "adapter-session",
        workspacePath: root
      })
      const url = pathToFileURL(filePath).href

      await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
      await adapter.handleRequest(
        "executeCdp",
        {
          commandParams: { url },
          method: "Page.navigate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )

      const count = await adapter.handleRequest(
        "executeCdp",
        {
          commandParams: {
            expression: `(() => {
              const initialInjected = window.__codexPlaywrightInjected;
              const parsed = initialInjected.parseSelector("p");
              const scope = selectorScopeFor(initialInjected, parsed);
              const elements = scope ? scope.injected.querySelectorAll(scope.parsed, scope.root) : [];
              return (r=>r.length)(elements);
            })()`,
            returnByValue: true
          },
          method: "Runtime.evaluate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )
      const text = await adapter.handleRequest(
        "executeCdp",
        {
          commandParams: {
            expression: `(() => {
              const initialInjected = window.__codexPlaywrightInjected;
              const parsed = initialInjected.parseSelector("p >> nth=1");
              const scope = selectorScopeFor(initialInjected, parsed);
              const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
              return (r=>r.textContent)(element);
            })()`,
            returnByValue: true
          },
          method: "Runtime.evaluate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )
      const attribute = await adapter.handleRequest(
        "executeCdp",
        {
          commandParams: {
            expression: `(() => {
              const initialInjected = window.__codexPlaywrightInjected;
              const parsed = initialInjected.parseSelector("p");
              const scope = selectorScopeFor(initialInjected, parsed);
              const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
              return ((r,n,o)=>r.getAttribute(o.name))(element, initialInjected, {"name":"data-kind"});
            })()`,
            returnByValue: true
          },
          method: "Runtime.evaluate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )

      expect(count).toEqual({ result: { type: "number", value: 2 } })
      expect(text).toEqual({ result: { type: "string", value: "Beta" } })
      expect(attribute).toEqual({ result: { type: "string", value: "first" } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("provides bounded local Playwright semantic locator read fallbacks for file URLs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-browser-local-semantic-locator-"))
    try {
      const filePath = join(root, "page.html")
      writeFileSync(
        filePath,
        '<!doctype html><title>Semantic Locator Page</title><body><button>Submit</button><a href="/docs">Docs</a><main><p>Nested Alpha</p></main><input aria-label="Search"><textarea placeholder="发消息..."></textarea></body>',
        "utf8"
      )
      const adapter = createBrowserOfficialBackendAdapter({
        budget: DEFAULT_BROWSER_PERFORMANCE_BUDGET,
        getService: () => null,
        sessionId: "adapter-session",
        workspacePath: root
      })
      const url = pathToFileURL(filePath).href
      const countExpression = (selector: string): string => `(() => {
        const initialInjected = window.__codexPlaywrightInjected;
        const parsed = initialInjected.parseSelector(${JSON.stringify(selector)});
        const scope = selectorScopeFor(initialInjected, parsed);
        const elements = scope ? scope.injected.querySelectorAll(scope.parsed, scope.root) : [];
        return (r=>r.length)(elements);
      })()`
      const textExpression = (selector: string): string => `(() => {
        const initialInjected = window.__codexPlaywrightInjected;
        const parsed = initialInjected.parseSelector(${JSON.stringify(selector)});
        const scope = selectorScopeFor(initialInjected, parsed);
        const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
        return (r=>r.textContent)(element);
      })()`
      const evaluate = (expression: string): Promise<unknown> =>
        adapter.handleRequest(
          "executeCdp",
          {
            commandParams: { expression, returnByValue: true },
            method: "Runtime.evaluate",
            target: { tabId: 1 }
          },
          EMPTY_TRANSPORT
        )

      await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
      await adapter.handleRequest(
        "executeCdp",
        {
          commandParams: { url },
          method: "Page.navigate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )

      const textCount = await evaluate(countExpression('internal:text="Nested"i'))
      const scopedText = await evaluate(textExpression('main >> internal:text="Nested"i'))
      const buttonCount = await evaluate(countExpression('internal:role=button[name="Submit"i]'))
      const linkCount = await evaluate(countExpression('internal:role=link[name="Docs"i]'))
      const textboxCount = await evaluate(countExpression('internal:role=textbox[name="Search"i]'))
      const placeholderCount = await evaluate(countExpression('internal:attr=[placeholder="发消息..."s]'))

      expect(textCount).toEqual({ result: { type: "number", value: 1 } })
      expect(scopedText).toEqual({ result: { type: "string", value: "Nested Alpha" } })
      expect(buttonCount).toEqual({ result: { type: "number", value: 1 } })
      expect(linkCount).toEqual({ result: { type: "number", value: 1 } })
      expect(textboxCount).toEqual({ result: { type: "number", value: 1 } })
      expect(placeholderCount).toEqual({ result: { type: "number", value: 1 } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("provides bounded local Playwright locator action fallbacks", async () => {
    const adapter = createBrowserOfficialBackendAdapter({
      budget: DEFAULT_BROWSER_PERFORMANCE_BUDGET,
      getService: () => null,
      sessionId: "adapter-session",
      workspacePath: "/tmp/workspace"
    })
    const evaluate = (expression: string): Promise<unknown> =>
      adapter.handleRequest(
        "executeCdp",
        {
          commandParams: { expression, returnByValue: true },
          method: "Runtime.evaluate",
          target: { tabId: 1 }
        },
        EMPTY_TRANSPORT
      )

    await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { url: "about:blank" },
        method: "Page.navigate",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    await evaluate(`(() => {
      "use strict";
      document.body.innerHTML = "<input aria-label=\\"Name\\"><button>Save</button><input type=\\"checkbox\\" aria-label=\\"Agree\\"><select aria-label=\\"Color\\"><option value=\\"red\\">Red</option><option value=\\"green\\">Green</option></select><button disabled>Disabled</button>";
    }).call(windowObject)`)

    const stateExpression = (selector: string, stateName: string): string => `(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector(${JSON.stringify(selector)});
      const scope = selectorScopeFor(initialInjected, parsed);
      const elements = scope ? scope.injected.querySelectorAll(scope.parsed, scope.root) : [];
      return ((r,n,o)=>{let s=r[0]??null;if(!s)return false;let a=n.elementState(s,o.stateName);return a.received==="error:notconnected" ? false : !!a.matches;})(elements, scope.injected, {"stateName":${JSON.stringify(stateName)}});
    })()`
    const checkedExpression = (selector: string): string => `(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector(${JSON.stringify(selector)});
      const scope = selectorScopeFor(initialInjected, parsed);
      const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
      return ((r,n)=>{let o=n.elementState(r,"checked");if(o.received==="error:notconnected")throw new Error("Element is not connected");return {checked:!!o.matches,isRadio:!!o.isRadio};})(element, scope.injected);
    })()`

    const fill = await evaluate(`(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector("internal:role=textbox[name=\\\"Name\\\"i]");
      const scope = selectorScopeFor(initialInjected, parsed);
      const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
      return ((a,u,l)=>{let d=u.fill(a,l.value); return d;})(element, scope.injected, {"value":"Alice"}, scope);
    })()`)
    const value = await evaluate(`(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector("internal:role=textbox[name=\\\"Name\\\"i]");
      const scope = selectorScopeFor(initialInjected, parsed);
      const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
      return ((r,n,o)=>r.getAttribute(o.name))(element, initialInjected, {"name":"value"});
    })()`)
    const point = await evaluate(`(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector("internal:role=button[name=\\\"Save\\\"i]");
      const scope = selectorScopeFor(initialInjected, parsed);
      const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
      const helper = { async waitForStableBoundingRect(){ return element.getBoundingClientRect(); } };
      const rect = await helper.waitForStableBoundingRect();
      return scope.prepareFrameChainForPointerAction({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, { block: "center", inline: "center" });
    })()`)
    const enabled = await evaluate(stateExpression('internal:role=textbox[name="Name"i]', "enabled"))
    const disabled = await evaluate(stateExpression('internal:role=button[name="Disabled"i]', "enabled"))
    const checkboxBefore = await evaluate(checkedExpression('internal:role=checkbox[name="Agree"i]'))
    const checkboxPoint = await evaluate(`(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector("internal:role=checkbox[name=\\\"Agree\\\"i]");
      const scope = selectorScopeFor(initialInjected, parsed);
      const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
      const helper = { async waitForStableBoundingRect(){ return element.getBoundingClientRect(); } };
      const rect = await helper.waitForStableBoundingRect();
      return scope.prepareFrameChainForPointerAction({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, {"requiredStates":["visible","enabled"]});
    })()`)
    const checkboxAfter = await evaluate(checkedExpression('internal:role=checkbox[name="Agree"i]'))
    const select = await evaluate(`(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector("internal:role=combobox[name=\\\"Color\\\"i]");
      const scope = selectorScopeFor(initialInjected, parsed);
      const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
      return ((r,n,o)=>{let i=n.elementState(r,"enabled");if(i.received==="error:notconnected")throw new Error("Element is not connected");if(!i.matches)throw new Error("Element is not enabled");let s=n.selectOptions(r,o.selections);if(typeof s==="string"&&s.startsWith("error:"))throw new Error(s);return true;})(element, scope.injected, {"selections":[{"value":"green"}]});
    })()`)
    const selectedValue = await evaluate(`(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector("internal:role=combobox[name=\\\"Color\\\"i]");
      const scope = selectorScopeFor(initialInjected, parsed);
      const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
      return ((r,n,o)=>r.getAttribute(o.name))(element, initialInjected, {"name":"value"});
    })()`)

    expect(fill).toEqual({ result: { type: "string", value: "done" } })
    expect(value).toEqual({ result: { type: "string", value: "Alice" } })
    expect(point).toEqual({
      result: {
        type: "object",
        value: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number)
        })
      }
    })
    expect(enabled).toEqual({ result: { type: "boolean", value: true } })
    expect(disabled).toEqual({ result: { type: "boolean", value: false } })
    expect(checkboxBefore).toEqual({
      result: { type: "object", value: { checked: false, isRadio: false } }
    })
    expect(checkboxPoint).toEqual({
      result: {
        type: "object",
        value: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number)
        })
      }
    })
    expect(checkboxAfter).toEqual({
      result: { type: "object", value: { checked: true, isRadio: false } }
    })
    expect(select).toEqual({ result: { type: "boolean", value: true } })
    expect(selectedValue).toEqual({ result: { type: "string", value: "green" } })
  })

  it("provides bounded local Playwright locator waitFor state fallbacks", async () => {
    const adapter = createBrowserOfficialBackendAdapter({
      budget: DEFAULT_BROWSER_PERFORMANCE_BUDGET,
      getService: () => null,
      sessionId: "adapter-session",
      workspacePath: "/tmp/workspace"
    })

    await adapter.handleRequest("createTab", {}, EMPTY_TRANSPORT)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { url: "about:blank" },
        method: "Page.navigate",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )

    const waitForExpression = (selector: string, state: string): string => `(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector(${JSON.stringify(selector)});
      const scope = selectorScopeFor(initialInjected, parsed);
      const elements = scope ? scope.injected.querySelectorAll(scope.parsed, scope.root) : [];
      const scopedInjected = scope ? scope.injected : initialInjected;
      return ((n,o,i)=>{
        let s=n[0]??null;
        if(i.state==="attached"){if(s)return true;throw new Error("Element is not attached")}
        if(i.state==="detached"){if(!s)return true;throw new Error("Element is still attached")}
        if(!s){if(i.state==="hidden")return true;throw new Error("Element is not attached")}
        let a=o.elementState(s,i.state);
        if(a.matches)return true;
        throw new Error("Element is not "+i.state)
      })(elements, scopedInjected, {"state":${JSON.stringify(state)}});
    })()`

    const attached = await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { expression: waitForExpression("body", "attached"), returnByValue: true },
        method: "Runtime.evaluate",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    const detached = await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: {
          expression: waitForExpression("no-such-element", "detached"),
          returnByValue: true
        },
        method: "Runtime.evaluate",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )
    const hidden = await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { expression: waitForExpression("body", "hidden"), returnByValue: true },
        method: "Runtime.evaluate",
        target: { tabId: 1 }
      },
      EMPTY_TRANSPORT
    )

    expect(attached).toEqual({ result: { type: "boolean", value: true } })
    expect(detached).toEqual({ result: { type: "boolean", value: true } })
    expect(hidden).toEqual({
      result: { type: "undefined" },
      exceptionDetails: {
        text: "Element is not hidden",
        exception: {
          type: "object",
          subtype: "error",
          description: "Element is not hidden",
          value: "Element is not hidden"
        }
      }
    })
  })

  it("provides a bounded local Playwright download event fallback", async () => {
    const notifications: Array<{ method: string; params?: unknown }> = []
    const transport: BrowserNativePipeTransport = {
      sendNotification: (method, params) => notifications.push({ method, params })
    }
    const adapter = createBrowserOfficialBackendAdapter({
      budget: DEFAULT_BROWSER_PERFORMANCE_BUDGET,
      getService: () => null,
      sessionId: "adapter-session",
      workspacePath: "/tmp/workspace"
    })
    const evaluate = (expression: string): Promise<unknown> =>
      adapter.handleRequest(
        "executeCdp",
        {
          commandParams: { expression, returnByValue: true },
          method: "Runtime.evaluate",
          target: { tabId: 1 }
        },
        transport
      )

    await adapter.handleRequest("createTab", {}, transport)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { url: "about:blank" },
        method: "Page.navigate",
        target: { tabId: 1 }
      },
      transport
    )
    await evaluate(`(() => {
      "use strict";
      document.body.innerHTML = "<a download=\\"hello.txt\\" href=\\"data:text/plain;base64,aGVsbG8tZG93bmxvYWQ=\\">Download</a>";
    }).call(windowObject)`)

    const result = await evaluate(`(() => {
      const initialInjected = window.__codexPlaywrightInjected;
      const parsed = initialInjected.parseSelector("internal:role=link[name=\\\"Download\\\"i]");
      const scope = selectorScopeFor(initialInjected, parsed);
      const element = scope ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root) : null;
      return ((r)=>{r.scrollIntoView({block:"center",inline:"nearest"});let n=r.closest?.("img, video, source, a[href]")??r.querySelector?.("img, video, source, a[href]")??r;let i=n.currentSrc??n.src??n.href??"";let s=document.createElement("a");s.href=i;s.download=i.split("/").pop()?.split("?")[0]||"download";s.click();return true;})(element);
    })()`)

    const paused = notifications.find((entry) => {
      const params = entry.params as { method?: string } | undefined
      return entry.method === "onCDPEvent" && params?.method === "Fetch.requestPaused"
    })?.params as
      | {
          params?: { request?: { url?: string }; requestId?: string }
        }
      | undefined
    const requestId = paused?.params?.requestId
    const url = paused?.params?.request?.url

    expect(result).toEqual({ result: { type: "boolean", value: true } })
    expect(requestId).toMatch(/^download-request-/)
    expect(url).toBe("data:text/plain;base64,aGVsbG8tZG93bmxvYWQ=")

    await adapter.handleRequest("allowDownload", { tabId: 1, url }, transport)
    await adapter.handleRequest(
      "executeCdp",
      {
        commandParams: { requestId },
        method: "Fetch.continueResponse",
        target: { tabId: 1 }
      },
      transport
    )

    const completed = notifications.find((entry) => {
      const params = entry.params as { status?: string } | undefined
      return entry.method === "onDownloadChange" && params?.status === "complete"
    })?.params as { filename?: string } | undefined
    const filename = completed?.filename

    expect(filename).toMatch(/hello\.txt$/)
    expect(filename && existsSync(filename)).toBe(true)
    expect(filename && readFileSync(filename, "utf8")).toBe("hello-download")
    if (filename) rmSync(dirname(filename), { recursive: true, force: true })
  })
})
