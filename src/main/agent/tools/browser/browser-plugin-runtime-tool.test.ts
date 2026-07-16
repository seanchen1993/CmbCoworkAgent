import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { pathToFileURL } from "url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setGlobalBrowserService } from "../../../browser/browser-service-registry"
import {
  clearBrowserPluginRuntimeToolSessionsForTests,
  createBrowserPluginRuntimeTool
} from "./browser-plugin-runtime-tool"

function createPluginFixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), "cmb-browser-runtime-tool-"))
  const scripts = join(root, "scripts")
  mkdirSync(scripts, { recursive: true })
  const clientPath = join(scripts, "browser-client.mjs")
  writeFileSync(clientPath, script, "utf-8")
  return {
    root,
    plugin: {
      pluginId: "plugin-browser",
      pluginName: "browser",
      pluginRoot: root,
      clientPath
    }
  }
}

const CLIENT_SCRIPT = `
let setupCount = 0;
export async function setupBrowserRuntime({ globals }) {
  setupCount += 1;
  globals.__browserRuntimeSetupCount = setupCount;
  globals.agent = {
    documentation: {
      async get(name) {
        return "doc:" + name;
      }
    },
    browsers: {
      async list() {
        return [];
      },
      async getDefault() {
        return {
          async documentation() {
            return "browser docs";
          }
        };
      }
    }
  };
}
`

describe("browser plugin official runtime tool", () => {
  beforeEach(() => {
    setGlobalBrowserService(null)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    clearBrowserPluginRuntimeToolSessionsForTests()
    setGlobalBrowserService(null)
    vi.restoreAllMocks()
  })

  it("loads setupBrowserRuntime once and exposes the nodeRepl contract", async () => {
    const { root, plugin } = createPluginFixture(CLIENT_SCRIPT)
    try {
      const runtimeTool = createBrowserPluginRuntimeTool({
        plugin,
        workspacePath: "/tmp/workspace",
        threadId: "runtime-contract"
      })

      const firstOutput = String(
        await runtimeTool.invoke({
          code: `
            ({
              setupCount: globalThis.__browserRuntimeSetupCount,
              agentType: typeof agent,
              browsersType: typeof agent.browsers,
              cwd: nodeRepl.cwd,
              tmpDirType: typeof nodeRepl.tmpDir,
              writeType: typeof nodeRepl.write,
              setResponseMetaType: typeof nodeRepl.setResponseMeta,
              emitImageType: typeof nodeRepl.emitImage,
              createElicitationType: typeof nodeRepl.createElicitation,
              nativePipeType: typeof nodeRepl.nativePipe.createConnection,
              fetchType: typeof nodeRepl.fetch
            })
          `
        })
      )

      const secondOutput = String(
        await runtimeTool.invoke({
          code: `
            globalThis.persistedValue = (globalThis.persistedValue || 0) + 1;
            ({
              setupCount: globalThis.__browserRuntimeSetupCount,
              persistedValue: globalThis.persistedValue
            })
          `
        })
      )

      expect(firstOutput).toContain('"setupCount": 1')
      expect(firstOutput).toContain('"agentType": "object"')
      expect(firstOutput).toContain('"browsersType": "object"')
      expect(firstOutput).toContain('"writeType": "function"')
      expect(firstOutput).toContain('"setResponseMetaType": "function"')
      expect(firstOutput).toContain('"emitImageType": "function"')
      expect(firstOutput).toContain('"createElicitationType": "function"')
      expect(firstOutput).toContain('"nativePipeType": "function"')
      expect(firstOutput).toContain('"tmpDirType": "string"')
      expect(firstOutput).toContain('"fetchType": "function"')
      expect(secondOutput).toContain('"setupCount": 1')
      expect(secondOutput).toContain('"persistedValue": 1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns nodeRepl.write output from the official globals", async () => {
    const { root, plugin } = createPluginFixture(CLIENT_SCRIPT)
    try {
      const runtimeTool = createBrowserPluginRuntimeTool({
        plugin,
        workspacePath: "/tmp/workspace",
        threadId: "runtime-write"
      })

      const output = String(
        await runtimeTool.invoke({
          code: `nodeRepl.write(await agent.documentation.get("browser-safety"));`
        })
      )

      expect(output).toBe("doc:browser-safety")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("prints stable Phase 1 runtime lifecycle logs", async () => {
    const logSpy = vi.mocked(console.log)
    const { root, plugin } = createPluginFixture(CLIENT_SCRIPT)
    try {
      const runtimeTool = createBrowserPluginRuntimeTool({
        plugin,
        workspacePath: "/tmp/workspace",
        threadId: "runtime-log"
      })

      await runtimeTool.invoke({ code: `typeof agent.browsers;` })
      await runtimeTool.invoke({ code: `typeof agent.browsers;` })

      expect(logSpy).toHaveBeenCalledWith(
        "[BrowserRuntime] official runtime bootstrapping for runtime-log."
      )
      expect(logSpy).toHaveBeenCalledWith(
        "[BrowserRuntime] official runtime ready for runtime-log."
      )
      expect(
        logSpy.mock.calls.filter(
          (call) => call[0] === "[BrowserRuntime] official runtime ready for runtime-log."
        )
      ).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("maps official response meta into BrowserToolState", async () => {
    const { root, plugin } = createPluginFixture(CLIENT_SCRIPT)
    try {
      const runtimeTool = createBrowserPluginRuntimeTool({
        plugin,
        workspacePath: "/tmp/workspace",
        threadId: "runtime-meta"
      })

      const output = String(
        await runtimeTool.invoke({
          code: `
            nodeRepl.setResponseMeta({
              "codex/browserUse": true,
              "codex/toolSurface": {
                kind: "browserUse",
                backend: "extension",
                browserId: "browser-1",
                openTabIds: ["tab-1"],
                screenshot: {
                  tabId: "tab-1",
                  url: "data:image/png;base64,AA=="
                }
              },
              browser_use: {
                url: "https://example.com/"
              }
            });
          `
        })
      )

      expect(output).toContain('"runtime": "official"')
      expect(output).toContain('"bootstrapState": "ready"')
      expect(output).toContain('"backend": "chrome"')
      expect(output).toContain('"browserId": "browser-1"')
      expect(output).toContain('"currentUrl": "https://example.com/"')
      expect(output).toContain('"openTabIds"')
      expect(output).toContain('"selectedTabId": "tab-1"')
      expect(output).toContain('"screenshotUrl": "data:image/png;base64,AA=="')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("accepts image bytes through nodeRepl.emitImage", async () => {
    const { root, plugin } = createPluginFixture(CLIENT_SCRIPT)
    try {
      const runtimeTool = createBrowserPluginRuntimeTool({
        plugin,
        workspacePath: "/tmp/workspace",
        threadId: "runtime-image"
      })

      const output = String(
        await runtimeTool.invoke({
          code: `await nodeRepl.emitImage(new Uint8Array([0]));`
        })
      )

      expect(output).toBe("[image/png 1 bytes]")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("maps Browser runtime elicitation to the app approval flow", async () => {
    const requestApproval = vi.fn(async (request) => ({
      type: "approve_permanent" as const,
      tool_call_id: request.tool_call.id
    }))
    const { root, plugin } = createPluginFixture(CLIENT_SCRIPT)
    try {
      const runtimeTool = createBrowserPluginRuntimeTool({
        plugin,
        requestApproval,
        workspacePath: "/tmp/workspace",
        threadId: "runtime-elicitation"
      })

      const output = String(
        await runtimeTool.invoke({
          code: `
            const response = await nodeRepl.createElicitation({
              message: "Allow Browser Use to access https://example.com?",
              meta: {
                codex_approval_kind: "mcp_tool_call",
                connector_id: "browser-use",
                origin: "https://example.com",
                tool_params: { origin: "https://example.com" }
              }
            });
            nodeRepl.write(response);
          `
        })
      )

      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "browser access https://example.com",
          reason: "Allow Browser Use to access https://example.com?"
        })
      )
      expect(output).toContain('"action": "accept"')
      expect(output).toContain('"persist": "always"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails clearly when output exceeds the configured budget", async () => {
    const { root, plugin } = createPluginFixture(CLIENT_SCRIPT)
    try {
      const runtimeTool = createBrowserPluginRuntimeTool({
        plugin,
        workspacePath: "/tmp/workspace",
        threadId: "runtime-budget",
        budget: {
          maxRuntimeInstancesPerSession: 1,
          maxActiveBackendsPerSession: 1,
          maxOpenTabsPerSession: 1,
          maxConcurrentOperations: 1,
          maxMessageBytes: 16,
          maxResponseMetaBytes: 16,
          maxScreenshotBytes: 16,
          maxScreenshotsPerMinute: 1,
          maxDomSnapshotBytes: 16,
          maxLogEntriesPerSession: 4,
          bootstrapTimeoutMs: 1000,
          operationTimeoutMs: 1000,
          idleShutdownMs: 1000
        }
      })

      const output = String(
        await runtimeTool.invoke({
          code: `nodeRepl.write("x".repeat(64));`
        })
      )

      expect(output).toContain("Browser runtime output exceeds Browser budget")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("restores host process globals after importing the official client", async () => {
    const originalProcess = globalThis.process
    const originalGlobalProcess = globalThis.global.process
    const { root, plugin } = createPluginFixture(`
      const processShim = { env: {}, exit() { throw new Error("blocked"); } };
      globalThis.process = processShim;
      globalThis.global = globalThis.global ?? globalThis;
      globalThis.global.process = processShim;
      export async function setupBrowserRuntime({ globals }) {
        globals.agent = { browsers: {} };
      }
    `)
    try {
      const runtimeTool = createBrowserPluginRuntimeTool({
        plugin,
        workspacePath: "/tmp/workspace",
        threadId: "runtime-process-restore"
      })

      const output = String(await runtimeTool.invoke({ code: `typeof agent.browsers;` }))

      expect(output).toBe("object")
      expect(globalThis.process).toBe(originalProcess)
      expect(globalThis.global.process).toBe(originalGlobalProcess)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("lets the official browser client discover the iab backend through native pipe", async () => {
    const logSpy = vi.mocked(console.log)
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      workspacePath: process.cwd(),
      threadId: "runtime-iab-discovery"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browsers = await agent.browsers.list();
          nodeRepl.write(JSON.stringify(browsers.map((browser) => ({
            id: browser.id,
            name: browser.name,
            session: browser.metadata?.codexSessionId,
            type: browser.type
          }))));
        `
      })
    )

    expect(output).toContain('"type":"iab"')
    expect(output).toContain('"name":"In-app Browser"')
    expect(output).toContain('"session":"thread-runtime-iab-discovery"')
    expect(logSpy).toHaveBeenCalledWith(
      "[BrowserRuntime] iab backend registered for thread-runtime-iab-discovery."
    )
    expect(logSpy).toHaveBeenCalledWith(
      "[BrowserRuntime] native pipe connected for thread-runtime-iab-discovery."
    )
  })

  it("supports the official iab tab smoke path without the legacy shim", async () => {
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      workspacePath: process.cwd(),
      threadId: "runtime-iab-tab-smoke"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browser = await agent.browsers.get("iab");
          const tab = await browser.tabs.new();
          await tab.goto("about:blank");
          const tabs = await browser.tabs.list();
          const screenshot = await tab.screenshot();
          nodeRepl.write(JSON.stringify({
            browserId: browser.browserId,
            screenshotBytes: screenshot.byteLength,
            tabId: tab.id,
            tabIds: tabs.map((item) => item.id),
            title: await tab.title(),
            url: await tab.url()
          }));
        `
      })
    )

    expect(output).toContain('"tabId":"1"')
    expect(output).toContain('"tabIds":["1"]')
    expect(output).toContain('"url":"about:blank"')
    expect(output).toContain('"screenshotBytes":')
  }, 15_000)

  it("supports approved local HTML navigation through the official iab URL policy", async () => {
    const requestApproval = vi.fn(async (request) => ({
      type: "approve" as const,
      tool_call_id: request.tool_call.id
    }))
    const pageRoot = mkdtempSync(join(tmpdir(), "cmb-browser-local-html-"))
    const pagePath = join(pageRoot, "login.html")
    writeFileSync(
      pagePath,
      "<!doctype html><title>Local Login</title><main>Local login form</main>",
      "utf-8"
    )
    const fileUrl = pathToFileURL(pagePath).href
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    try {
      const runtimeTool = createBrowserPluginRuntimeTool({
        plugin: {
          pluginId: "plugin-browser",
          pluginName: "browser",
          pluginRoot: root,
          clientPath
        },
        requestApproval,
        workspacePath: process.cwd(),
        threadId: "runtime-iab-local-html-smoke"
      })

      const output = String(
        await runtimeTool.invoke({
          code: `
            const browser = await agent.browsers.get("iab");
            const tab = await browser.tabs.new();
            await tab.goto(${JSON.stringify(fileUrl)});
            nodeRepl.write(JSON.stringify({
              tabId: tab.id,
              title: await tab.title(),
              url: await tab.url()
            }));
          `
        })
      )

      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          command: `browser access ${fileUrl}`,
          reason: `Allow Browser use to access ${fileUrl}?`
        })
      )
      expect(output).toContain('"tabId":"1"')
      expect(output).toContain(`"url":"${fileUrl}"`)
      expect(output).toContain('"title":"Local Login"')
    } finally {
      rmSync(pageRoot, { recursive: true, force: true })
    }
  }, 15_000)

  it("supports the official iab Playwright domSnapshot smoke path", async () => {
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      workspacePath: process.cwd(),
      threadId: "runtime-iab-dom-snapshot-smoke"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browser = await agent.browsers.get("iab");
          const tab = await browser.tabs.new();
          await tab.goto("about:blank");
          const snapshot = await tab.playwright.domSnapshot();
          nodeRepl.write(JSON.stringify({
            length: snapshot.length,
            snapshot,
            tabId: tab.id,
            url: await tab.url()
          }));
        `
      })
    )

    expect(output).toContain('"tabId":"1"')
    expect(output).toContain('"url":"about:blank"')
    expect(output).toContain('"length":0')
  }, 15_000)

  it("supports a minimal official iab pageAssets list smoke path", async () => {
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      workspacePath: process.cwd(),
      threadId: "runtime-iab-page-assets-smoke"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browser = await agent.browsers.get("iab");
          const tab = await browser.tabs.new();
          await tab.goto("about:blank");
          await tab.playwright.evaluate(() => {
            document.body.innerHTML = '<img src="https://assets.example/logo.png"><link rel="stylesheet" href="https://assets.example/site.css"><svg aria-label="Brand"><title>Ignored</title><path></path></svg>';
          });
          const pageAssets = await tab.capabilities.get("pageAssets");
          const inventory = await pageAssets.list();
          nodeRepl.write(JSON.stringify({
            assetCount: inventory.assets.length,
            inlineSvgCount: inventory.inlineSvgs.length,
            kinds: inventory.assets.map((asset) => asset.kind).sort(),
            names: inventory.assets.map((asset) => asset.name).sort(),
            pageUrl: inventory.pageUrl,
            tabId: tab.id,
            totalCount: inventory.summary.totalCount,
            url: await tab.url()
          }));
        `
      })
    )

    expect(output).toContain('"tabId":"1"')
    expect(output).toContain('"url":"about:blank"')
    expect(output).toContain('"pageUrl":"about:blank"')
    expect(output).toContain('"assetCount":2')
    expect(output).toContain('"totalCount":2')
    expect(output).toContain('"inlineSvgCount":1')
    expect(output).toContain('"image"')
    expect(output).toContain('"stylesheet"')
    expect(output).toContain('"logo.png"')
    expect(output).toContain('"site.css"')
  }, 45_000)

  it("supports a minimal official iab pageAssets bundle smoke path", async () => {
    const requestApproval = vi.fn(async (request) => ({
      type: "approve" as const,
      tool_call_id: request.tool_call.id
    }))
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      requestApproval,
      workspacePath: process.cwd(),
      threadId: "runtime-iab-page-assets-bundle-smoke"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browser = await agent.browsers.get("iab");
          const tab = await browser.tabs.new();
          await tab.goto("https://example.com/");
          await tab.playwright.evaluate(() => {
            document.body.innerHTML = '<img src="https://example.com/logo.png"><link rel="stylesheet" href="https://example.com/site.css"><svg aria-label="Brand"><title>Ignored</title><path></path></svg>';
          });
          const pageAssets = await tab.capabilities.get("pageAssets");
          const inventory = await pageAssets.list();
          const bundle = await pageAssets.bundle({
            inventoryId: inventory.id,
            kinds: ["image", "stylesheet"]
          });
          nodeRepl.write(JSON.stringify({
            assetNames: bundle.assets.map((asset) => asset.name).sort(),
            assetPaths: bundle.assets.map((asset) => asset.path).sort(),
            downloadedCount: bundle.summary.downloadedCount,
            failedCount: bundle.summary.failedCount,
            manifestPath: bundle.manifestPath,
            pageUrl: inventory.pageUrl,
            requestedCount: bundle.summary.requestedCount,
            tabId: tab.id,
            url: await tab.url()
          }));
        `
      })
    )
    const result = JSON.parse(output) as { assetPaths: string[]; manifestPath: string }

    expect(output).toContain('"tabId":"1"')
    expect(output).toContain('"url":"https://example.com/"')
    expect(output).toContain('"pageUrl":"https://example.com/"')
    expect(output).toContain('"downloadedCount":3')
    expect(output).toContain('"failedCount":0')
    expect(output).toContain('"requestedCount":3')
    expect(result.assetPaths.every((assetPath) => existsSync(assetPath))).toBe(true)
    expect(existsSync(result.manifestPath)).toBe(true)
    expect(output).toContain('"Brand"')
    expect(output).toContain('"logo.png"')
    expect(output).toContain('"site.css"')
  }, 45_000)

  it("supports a minimal official iab Playwright locator read smoke path", async () => {
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      workspacePath: process.cwd(),
      threadId: "runtime-iab-locator-read-smoke"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browser = await agent.browsers.get("iab");
          const tab = await browser.tabs.new();
          await tab.goto("about:blank");
          const count = await tab.playwright.locator("body").count();
          const text = await tab.playwright.locator("body").textContent();
          nodeRepl.write(JSON.stringify({
            count,
            tabId: tab.id,
            text,
            url: await tab.url()
          }));
        `
      })
    )

    expect(output).toContain('"tabId":"1"')
    expect(output).toContain('"url":"about:blank"')
    expect(output).toContain('"count":1')
    expect(output).toContain('"text":""')
  }, 15_000)

  it("supports a minimal official iab Playwright locator waitFor state smoke path", async () => {
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      workspacePath: process.cwd(),
      threadId: "runtime-iab-locator-waitfor-smoke"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browser = await agent.browsers.get("iab");
          const tab = await browser.tabs.new();
          await tab.goto("about:blank");
          const result = {};
          await tab.playwright.locator("body").waitFor({ state: "attached", timeout: 1000 });
          result.attached = true;
          await tab.playwright.locator("no-such-element").waitFor({ state: "detached", timeout: 1000 });
          result.detached = true;
          try {
            await tab.playwright.locator("body").waitFor({ state: "hidden", timeout: 100 });
            result.hidden = true;
          } catch (error) {
            result.hiddenError = error instanceof Error ? error.message : String(error);
          }
          nodeRepl.write(JSON.stringify({
            result,
            tabId: tab.id,
            url: await tab.url()
          }));
        `
      })
    )

    expect(output).toContain('"tabId":"1"')
    expect(output).toContain('"url":"about:blank"')
    expect(output).toContain('"attached":true')
    expect(output).toContain('"detached":true')
    expect(output).toContain('"hiddenError"')
  }, 15_000)

  it("supports a minimal official iab Playwright locator action smoke path", async () => {
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      workspacePath: process.cwd(),
      threadId: "runtime-iab-locator-action-smoke"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browser = await agent.browsers.get("iab");
          const tab = await browser.tabs.new();
          await tab.goto("about:blank");
          await tab.playwright.evaluate(() => {
            document.body.innerHTML = '<input aria-label="Name"><input type="checkbox" aria-label="Agree"><select aria-label="Color"><option value="red">Red</option><option value="green">Green</option></select><button>Save</button><button disabled>Disabled</button>';
          });
          const input = tab.playwright.getByRole("textbox", { name: "Name" });
          await input.fill("Alice", { timeoutMs: 1000 });
          const value = await input.getAttribute("value");
          const color = tab.playwright.getByRole("combobox", { name: "Color" });
          await color.selectOption("green", { timeoutMs: 1000 });
          const selectedColor = await color.getAttribute("value");
          const checkbox = tab.playwright.getByRole("checkbox", { name: "Agree" });
          const checkboxVisible = await checkbox.isVisible();
          const checkboxEnabled = await checkbox.isEnabled();
          await checkbox.setChecked(true, { timeoutMs: 1000 });
          await checkbox.setChecked(false, { timeoutMs: 1000 });
          await checkbox.check({ timeoutMs: 1000 });
          await checkbox.uncheck({ timeoutMs: 1000 });
          const disabledEnabled = await tab.playwright.getByRole("button", { name: "Disabled" }).isEnabled();
          await tab.playwright.getByRole("button", { name: "Save" }).click({ timeoutMs: 1000 });
          nodeRepl.write(JSON.stringify({
            checkboxEnabled,
            checkboxVisible,
            disabledEnabled,
            selectedColor,
            tabId: tab.id,
            url: await tab.url(),
            value
          }));
        `
      })
    )

    expect(output).toContain('"tabId":"1"')
    expect(output).toContain('"url":"about:blank"')
    expect(output).toContain('"value":"Alice"')
    expect(output).toContain('"checkboxVisible":true')
    expect(output).toContain('"checkboxEnabled":true')
    expect(output).toContain('"disabledEnabled":false')
    expect(output).toContain('"selectedColor":"green"')
  }, 45_000)

  it("supports a minimal official iab Playwright download smoke path", async () => {
    const requestApproval = vi.fn(async (request) => ({
      type: "approve" as const,
      tool_call_id: request.tool_call.id
    }))
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      requestApproval,
      workspacePath: process.cwd(),
      threadId: "runtime-iab-download-smoke"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browser = await agent.browsers.get("iab");
          const tab = await browser.tabs.new();
          await tab.goto("https://example.com/");
          await tab.playwright.evaluate(() => {
            document.body.innerHTML = '<a download="hello.txt" href="data:text/plain;base64,aGVsbG8tZG93bmxvYWQ=">Download</a>';
          });
          const downloadPromise = tab.playwright.waitForEvent("download", { timeoutMs: 2000 });
          await tab.playwright.getByRole("link", { name: "Download" }).downloadMedia({ timeoutMs: 2000 });
          const download = await downloadPromise;
          const path = await download.path({ timeoutMs: 2000 });
          nodeRepl.write(JSON.stringify({
            path,
            tabId: tab.id,
            url: await tab.url()
          }));
        `
      })
    )

    expect(output).toContain('"tabId":"1"')
    expect(output).toContain('"url":"https://example.com/"')
    expect(output).toContain("hello.txt")
  }, 45_000)

  it("uses approval before the official iab backend navigates to an external origin", async () => {
    const requestApproval = vi.fn(async (request) => ({
      type: "approve" as const,
      tool_call_id: request.tool_call.id
    }))
    const root = join(process.cwd(), "plugins/broswer")
    const clientPath = join(root, "scripts/browser-client.mjs")
    expect(existsSync(clientPath)).toBe(true)

    const runtimeTool = createBrowserPluginRuntimeTool({
      plugin: {
        pluginId: "plugin-browser",
        pluginName: "browser",
        pluginRoot: root,
        clientPath
      },
      requestApproval,
      workspacePath: process.cwd(),
      threadId: "runtime-iab-external-origin"
    })

    const output = String(
      await runtimeTool.invoke({
        code: `
          const browser = await agent.browsers.get("iab");
          const tab = await browser.tabs.new();
          await tab.goto("https://example.com/");
          nodeRepl.write(JSON.stringify({
            tabId: tab.id,
            title: await tab.title(),
            url: await tab.url()
          }));
        `
      })
    )

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser access https://example.com",
        reason: "Allow Browser use to access https://example.com?"
      })
    )
    expect(output).toContain('"tabId":"1"')
    expect(output).toContain('"url":"https://example.com/"')
  }, 15_000)
})
