import { afterEach, describe, expect, it, vi } from "vitest"
import { setImmediate as waitForImmediate } from "node:timers/promises"
import { BROWSER_SESSION_ID, type BrowserState } from "../../shared/browser-types"
import { createScopedMcpCapabilityService } from "../agent/runtime"
import { configureBrowserCdpEndpoint } from "../browser/cdp/browser-cdp"
import {
  autoSelectPlaywrightInAppBrowserTab,
  invokeMcpToolWithPlaywrightInAppBrowserSupport
} from "../browser/cdp/playwright-mcp-bridge"
import { runHooks } from "../hooks/runner"
import { createHookScope } from "../hooks/scope"
import type { HookConfig, HookEvent, HookResult } from "../hooks/types"
import { closeGlobalMcpCapabilityService, getGlobalMcpCapabilityService } from "./capability-service"

const { getClient, providers, executeHttpHook, resolveStage } = vi.hoisted(() => ({
  getClient: vi.fn(),
  providers: { plugin: "", connector: "In-app-browser" },
  executeHttpHook: vi.fn(),
  resolveStage: vi.fn()
}))

vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: class {
    getClient = getClient
    async initializeConnections(): Promise<void> {}
    async close(): Promise<void> {}
  }
}))

vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getEnabledMcpConnectors: () => [
    { id: "connector", name: providers.connector, kind: "stdio", command: "unused" }
  ],
  getPlugins: () => providers.plugin
    ? [{ id: "plugin", path: "/plugin", enabled: true, mcpServerCount: 1 }]
    : [],
  getUserInfo: () => null,
  parseMcpJsonFile: () => ({
    [providers.plugin]: {
      command: "unused",
      scope: "plugin-installed",
      fallback: { enabled: true, safeToRetry: true }
    }
  })
}))

vi.mock("./tool-example-store", () => ({ recordSuccessfulToolExample: vi.fn() }))
vi.mock("../hooks/http-runner", () => ({ executeHttpHook }))
vi.mock("../services/harness-stage-attribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/harness-stage-attribution")>()),
  resolveHarnessExecutionStage: resolveStage
}))

const state: BrowserState = {
  sessionId: BROWSER_SESSION_ID,
  url: "about:blank",
  title: "",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  visible: false,
  created: true,
  consoleEntries: []
}

function browserService() {
  return { getState: () => state, prepareTarget: async () => state, requestPanel: vi.fn() }
}

function response(text: string) {
  return { content: [{ type: "text", text }] }
}

function scopeService(abortSignal?: AbortSignal) {
  return createScopedMcpCapabilityService(
    getGlobalMcpCapabilityService(),
    createHookScope({ disabled: true }),
    () => [],
    undefined,
    undefined,
    { workspacePath: "/workspace", threadId: "thread", abortSignal }
  )
}

async function loadTools(callTool: ReturnType<typeof vi.fn>) {
  configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, { enabled: true })
  const server = {
    listTools: async () => ({ tools: [{ name: "browser_navigate" }, { name: "browser_tabs" }] }),
    callTool
  }
  getClient.mockResolvedValue(server)
  const capabilityService = getGlobalMcpCapabilityService()
  const tools = await capabilityService.listTools()
  return {
    capabilityService,
    navigate: tools.find(tool => tool.toolName === "browser_navigate")!,
    tabs: tools.find(tool => tool.toolName === "browser_tabs")!,
    server
  }
}

async function loadFallbackTools(
  browserProvider: "primary" | "fallback",
  callPrimary: ReturnType<typeof vi.fn>,
  callFallback: ReturnType<typeof vi.fn>,
  sideSignal?: AbortSignal
) {
  providers.plugin = browserProvider === "primary" ? "In-app-browser" : "BrowserProxy"
  providers.connector = browserProvider === "fallback" ? "In-app-browser" : "BrowserProxy"
  configureBrowserCdpEndpoint({ appendSwitch: vi.fn() }, { enabled: true })
  // browser_tabs is dispatched directly without tab auto-selection.
  const listTools = async () => ({ tools: [{ name: "browser_tabs" }] })
  getClient.mockImplementation(async (providerKey: string) => ({
    listTools,
    callTool: providerKey.startsWith("plugin:") ? callPrimary : callFallback
  }))
  const service = scopeService(sideSignal)
  const tools = await service.listTools()
  const primary = tools.find(tool => tool.sourceKind === "plugin")!
  const fallback = tools.find(tool => tool.sourceKind === "connector")!
  return { service, primary, fallback }
}

describe("side conversation MCP dispatch", () => {
  afterEach(async () => {
    await closeGlobalMcpCapabilityService()
    getClient.mockReset()
    executeHttpHook.mockReset()
    resolveStage.mockReset()
    providers.plugin = ""
    providers.connector = "In-app-browser"
  })

  it("skips an asynchronous hook that has yet to dispatch when its stage lookup is pending", async () => {
    const controller = new AbortController()
    const stage = Promise.withResolvers<undefined>()
    resolveStage.mockReturnValue(stage.promise)
    const hook: HookConfig = {
      id: "waiting",
      event: "PreToolUse",
      type: "http",
      url: "https://fixture.test/hook",
      async: true,
      enabled: true,
      createdAt: "",
      updatedAt: ""
    }
    const onHookResult = vi.fn()
    await runHooks(
      [hook],
      "PreToolUse",
      {
        abortSignal: controller.signal,
        stopPendingHooksOnAbort: true,
        harnessProjectId: "fixture",
        featureId: "tool"
      },
      onHookResult
    )
    expect(resolveStage).toHaveBeenCalledOnce()
    expect(onHookResult).toHaveBeenCalledExactlyOnceWith(
      "PreToolUse", hook, expect.objectContaining({ asyncStatus: "pending" })
    )

    controller.abort()
    stage.resolve(undefined)
    await waitForImmediate()

    expect(executeHttpHook).not.toHaveBeenCalled()
    expect(onHookResult).toHaveBeenCalledOnce()
  })

  it.each(["PreToolUse", "PostToolUse"] as const)(
    "stops waiting for %s and lets only the active hook finish",
    async (event) => {
      providers.connector = "Fixture"
      const controller = new AbortController()
      const active = Promise.withResolvers<void>()
      const hookResult = Promise.withResolvers<HookResult>()
      const callTool = vi.fn().mockResolvedValue({ ...response("fixture result"), isError: true })
      getClient.mockResolvedValue({
        listTools: async () => ({ tools: [{ name: "fixture_write" }] }),
        callTool
      })
      const completed = { exitCode: 0, stdout: "", stderr: "", blocked: false }
      executeHttpHook
        .mockImplementationOnce(() => {
          active.resolve()
          return hookResult.promise
        })
        .mockResolvedValue(completed)
      function makeHook(hookEvent: HookEvent, id: string): HookConfig {
        return {
          id,
          event: hookEvent,
          type: "http",
          url: "https://fixture.test/hook",
          enabled: true,
          createdAt: "",
          updatedAt: ""
        }
      }
      const hooksFor = vi.fn((hookEvent: HookEvent) => {
        if (hookEvent === event) return [makeHook(event, "active"), makeHook(event, "next")]
        if (hookEvent === "PostToolUseFailure") return [makeHook(hookEvent, "failure")]
        return []
      })
      const onHookResult = vi.fn()
      const service = createScopedMcpCapabilityService(
        getGlobalMcpCapabilityService(),
        createHookScope(),
        hooksFor,
        onHookResult,
        undefined,
        { workspacePath: "/workspace", threadId: "side", abortSignal: controller.signal }
      )
      const [tool] = await service.listTools()
      const outcome = expect(service.invoke(tool.capabilityId, {})).rejects.toMatchObject({
        name: "AbortError"
      })
      await active.promise
      controller.abort()
      await outcome
      expect(onHookResult).not.toHaveBeenCalled()

      hookResult.resolve(completed)
      await waitForImmediate()
      expect(executeHttpHook).toHaveBeenCalledOnce()
      expect(onHookResult).toHaveBeenCalledExactlyOnceWith(
        event,
        expect.objectContaining({ id: "active" }),
        expect.objectContaining(completed)
      )
      expect(callTool).toHaveBeenCalledTimes(event === "PreToolUse" ? 0 : 1)
      expect(hooksFor.mock.calls.map(([name]) => name)).toEqual(
        event === "PreToolUse" ? ["PreToolUse"] : ["PreToolUse", "PostToolUse"]
      )
    }
  )

  it("stops waiting for shared connector discovery without dispatching the cancelled call", async () => {
    providers.connector = "Fixture"
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const discovery = Promise.withResolvers<{ tools: { name: string }[] }>()
    const callTool = vi.fn().mockResolvedValue(response("written"))
    getClient.mockResolvedValue({
      listTools: () => {
        started.resolve()
        return discovery.promise
      },
      callTool
    })
    const sideService = scopeService(controller.signal)
    const ordinaryService = scopeService()
    const outcome = expect(sideService.invoke("mcp__fixture__fixture_write", {}))
      .rejects.toMatchObject({ name: "AbortError" })

    await started.promise
    const ordinaryTools = ordinaryService.listTools()
    controller.abort()
    await outcome
    expect(callTool).not.toHaveBeenCalled()

    discovery.resolve({ tools: [{ name: "fixture_write" }] })
    const [tool] = await ordinaryTools
    await expect(ordinaryService.invoke(tool.capabilityId, {})).resolves.toMatchObject({
      text: "written"
    })
    expect(callTool).toHaveBeenCalledExactlyOnceWith({ name: "fixture_write", arguments: {} })
  })

  it("cancels an active connector call without affecting the main session's request", async () => {
    providers.connector = "Fixture"
    const controller = new AbortController()
    const started = Promise.withResolvers<AbortSignal | undefined>()
    const ordinaryStarted = Promise.withResolvers<unknown>()
    const sideResult = Promise.withResolvers<unknown>()
    const ordinaryResult = Promise.withResolvers<unknown>()
    const callTool = vi.fn()
      .mockImplementationOnce((_request, _schema, options?: { signal: AbortSignal }) => {
        started.resolve(options?.signal)
        return sideResult.promise
      })
      .mockImplementationOnce((...args) => {
        ordinaryStarted.resolve(args)
        return ordinaryResult.promise
      })
    getClient.mockResolvedValue({
      listTools: async () => ({ tools: [{ name: "fixture_write" }] }),
      callTool
    })
    const sideService = scopeService(controller.signal)
    const [tool] = await sideService.listTools()
    const rejected = expect(sideService.invoke(tool.capabilityId, { side: true }))
      .rejects.toMatchObject({ name: "AbortError" })
    const requestSignal = await started.promise
    const ordinary = scopeService().invoke(tool.capabilityId, { side: false })
    expect(await ordinaryStarted.promise).toEqual([
      { name: "fixture_write", arguments: { side: false } }
    ])

    controller.abort()
    await rejected
    expect(requestSignal?.aborted).toBe(true)
    sideResult.reject(new Error("late disconnected result"))
    ordinaryResult.resolve(response("written"))
    await expect(ordinary).resolves.toMatchObject({ text: "written" })
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it("stops tab selection before dispatch when the side closes during client acquisition", async () => {
    const controller = new AbortController()
    const callTool = vi.fn().mockResolvedValue(
      response("- 0: (current) [Other](https://example.com)\n- 1: [](about:blank)")
    )
    const { capabilityService, navigate, tabs, server } = await loadTools(callTool)
    const selecting = Promise.withResolvers<void>()
    const connection = Promise.withResolvers<typeof server>()
    getClient.mockResolvedValueOnce(server).mockImplementationOnce(() => {
      selecting.resolve()
      return connection.promise
    })

    const outcome = autoSelectPlaywrightInAppBrowserTab({
      tool: navigate,
      tabsTool: tabs,
      capabilityService,
      workspacePath: "/workspace",
      signal: controller.signal,
      browserService: browserService()
    }).then(() => "completed", (error: Error) => error.name)

    await selecting.promise
    controller.abort()
    connection.resolve(server)

    expect(callTool.mock.calls.map(([request]) => request.arguments.action)).toEqual(["list"])
    expect(callTool.mock.calls[0][2].signal.aborted).toBe(false)
    expect(await outcome).toBe("AbortError")
  })

  it("stops a browser retry when the side closes during reconnect backoff", async () => {
    const controller = new AbortController()
    const first = Promise.withResolvers<void>()
    const callTool = vi.fn().mockImplementationOnce(async () => {
      first.resolve()
      throw new Error("browser client disconnected")
    }).mockResolvedValue(response("navigated"))
    const { capabilityService, navigate } = await loadTools(callTool)
    const browser = browserService()
    const outcome = invokeMcpToolWithPlaywrightInAppBrowserSupport({
      tool: navigate,
      workspacePath: "/workspace",
      signal: controller.signal,
      browserService: browser,
      invoke: signal => capabilityService.invoke(navigate.capabilityId, { url: "https://example.com" }, signal)
    }).then(() => "completed", (error: Error) => error.name)

    await first.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    controller.abort()

    expect(await outcome).toBe("AbortError")
    expect(callTool).toHaveBeenCalledOnce()
    expect(browser.requestPanel).toHaveBeenCalledOnce()
  })

  it("keeps reconnect retries for calls without a side signal", async () => {
    const callTool = vi.fn()
      .mockRejectedValueOnce(new Error("browser client disconnected"))
      .mockResolvedValueOnce(response("navigated"))
    const { capabilityService, navigate } = await loadTools(callTool)
    const args = { url: "https://example.com" }

    await expect(capabilityService.invoke(navigate.capabilityId, args)).resolves.toMatchObject({
      text: "navigated"
    })
    const request = { name: navigate.toolName, arguments: args }
    expect(callTool.mock.calls).toEqual([[request], [request]])
  })

  it.each(["primary", "fallback"] as const)(
    "keeps ordinary plugin fallback when the built-in browser is the %s",
    async (browserProvider) => {
      const callPrimary = vi.fn().mockRejectedValue(new Error("502 Bad Gateway"))
      const callFallback = vi.fn().mockResolvedValue(response("tab list"))
      const { service, primary, fallback } = await loadFallbackTools(
        browserProvider, callPrimary, callFallback
      )

      await expect(service.invoke(primary.capabilityId, { action: "list" })).resolves.toMatchObject({
        fallbackCapabilityId: fallback.capabilityId,
        text: expect.stringContaining("tab list")
      })
      const request = { name: "browser_tabs", arguments: { action: "list" } }
      expect(callPrimary).toHaveBeenCalledExactlyOnceWith(request)
      expect(callFallback).toHaveBeenCalledExactlyOnceWith(request)
    }
  )

  it.each(["primary", "fallback"] as const)(
    "blocks fallback after side closure when the built-in browser is the %s",
    async (browserProvider) => {
      const controller = new AbortController()
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<unknown>()
      const callPrimary = vi.fn(() => {
        started.resolve()
        return pending.promise
      })
      const callFallback = vi.fn().mockResolvedValue(response("tab list"))
      const { service, primary } = await loadFallbackTools(
        browserProvider, callPrimary, callFallback, controller.signal
      )
      const rejected = expect(service.invoke(primary.capabilityId, { action: "list" }))
        .rejects.toMatchObject({ name: "AbortError" })

      await started.promise
      controller.abort()
      pending.reject(new Error("502 Bad Gateway"))

      await rejected
      expect(callFallback).not.toHaveBeenCalled()
    }
  )

  it("passes side closure to the active built-in browser fallback", async () => {
    const controller = new AbortController()
    const started = Promise.withResolvers<AbortSignal | undefined>()
    const pending = Promise.withResolvers<unknown>()
    const callPrimary = vi.fn().mockRejectedValue(new Error("502 Bad Gateway"))
    const callFallback = vi.fn((_request, _schema, options?: { signal: AbortSignal }) => {
      started.resolve(options?.signal)
      return pending.promise
    })
    const { service, primary } = await loadFallbackTools(
      "fallback", callPrimary, callFallback, controller.signal
    )
    const rejected = expect(service.invoke(primary.capabilityId, { action: "list" }))
      .rejects.toMatchObject({ name: "AbortError" })

    const requestSignal = await started.promise
    controller.abort()
    pending.resolve(response("tab list"))

    await rejected
    expect(requestSignal?.aborted).toBe(true)
  })
})
