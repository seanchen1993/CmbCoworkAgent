const browserConfig = vi.hoisted(() => ({ config: vi.fn(), port: vi.fn() }))
vi.mock("../../storage", () => ({ getBrowserCdpConfigAsync: browserConfig.config }))
vi.mock("../../browser/cdp/browser-cdp", () => ({ getCurrentBrowserCdpPort: browserConfig.port }))
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { McpCapabilityTool } from "../../mcp/capability-types"
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  state: vi.fn(),
  prepare: vi.fn(),
  extractIframes: vi.fn(),
  readWpsDocument: vi.fn()
}))
vi.mock("../../browser/cdp/playwright-mcp-bridge", () => ({
  preparePlaywrightInAppBrowser: mocks.prepare
}))
vi.mock("../../browser/core/browser-service-registry", () => ({
  getGlobalBrowserService: () => ({
    extractIframeInformation: mocks.extractIframes,
    readWpsDocumentText: mocks.readWpsDocument
  })
}))
vi.mock("../../browser/record/common/browser-script-library-service", () => ({
  listBrowserScriptLibraryEntries: mocks.list,
  readBrowserScriptLibraryScript: mocks.read
}))
vi.mock("../../browser/record/common/browser-script-execution-service", () => ({
  executeRecordingScriptInBuiltinBrowser: mocks.execute,
  cancelRecordingScriptExecutionInBuiltinBrowser: mocks.cancel,
  getBrowserScriptExecutionState: mocks.state
}))
import { createInAppBrowserTools } from "./in-app-browser-tools"
const capabilities = [
  { providerDisplayName: "In-app-browser", toolName: "browser_snapshot" }
] as McpCapabilityTool[]
const context = { workspacePath: "/workspace", threadId: "thread" }
const input = { fileName: "recording.spec.ts", variableValues: { 变量_企业: "华为技术有限公司" } }
beforeEach(() => {
  vi.resetAllMocks()
  browserConfig.config.mockReturnValue({ enabled: true })
  browserConfig.port.mockReturnValue(9222)
  mocks.list.mockResolvedValue([
    { fileName: input.fileName, displayName: "市场系统查询企业管户信息", description: "按企业查询" }
  ])
  mocks.read.mockResolvedValue(
    'const 变量_企业 = "旧企业"; // 变量-企业\nawait page.fill("input", 变量_企业);'
  )
  mocks.state.mockReturnValue({ status: "idle" })
  mocks.execute.mockResolvedValue(undefined)
  mocks.prepare.mockResolvedValue(undefined)
  mocks.extractIframes.mockResolvedValue({ frames: [] })
  mocks.readWpsDocument.mockResolvedValue({ text: "第一段\n第二段" })
})
describe("in-app browser agent tools", () => {
  it.each([false, undefined])(
    "does not inject without explicit browser opt-in: %s",
    async (enabled) => {
      browserConfig.config.mockReturnValue({ enabled })
      expect(await createInAppBrowserTools(capabilities, context)).toEqual([])
    }
  )
  it("does not inject before the browser endpoint is running", async () => {
    browserConfig.port.mockReturnValue(null)
    expect(await createInAppBrowserTools(capabilities, context)).toEqual([])
  })
  it("injects browser helper tools when enabled and ready", async () => {
    expect((await createInAppBrowserTools(capabilities, context)).map((tool) => tool.name)).toEqual(
      [
        "inAppBrowser_list_recordings",
        "inAppBrowser_execute_recording",
        "inAppBrowser_extract_iframes",
        "inAppBrowser_read_wps_document"
      ]
    )
  })
  it("forwards iframe text and link pagination independently", async () => {
    const extractTool = (await createInAppBrowserTools(capabilities, context))[2]

    await extractTool.invoke({
      frameIndex: 3,
      maxTextCharsPerFrame: 8_000,
      textOffset: 12_000,
      linkOffset: 100
    })

    expect(mocks.extractIframes).toHaveBeenCalledWith({
      frameIndex: 3,
      maxTextCharsPerFrame: 8_000,
      textOffset: 12_000,
      linkOffset: 100
    })
  })
  it("reads the complete WPS document through the browser service", async () => {
    const readWpsTool = (await createInAppBrowserTools(capabilities, context))[3]

    expect(JSON.parse((await readWpsTool.invoke({})) as string)).toEqual({
      text: "第一段\n第二段"
    })
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining(context))
    expect(mocks.readWpsDocument).toHaveBeenCalledOnce()
  })
  it("rejects existing tools after browser control is disabled", async () => {
    const tools = await createInAppBrowserTools(capabilities, context)
    browserConfig.config.mockReturnValue({ enabled: false })
    await expect(tools[0].invoke({})).rejects.toThrow("开启内置浏览器")
    await expect(tools[1].invoke(input)).rejects.toThrow("开启内置浏览器")
    await expect(tools[3].invoke({})).rejects.toThrow("开启内置浏览器")
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it("requires the in-app snapshot capability", async () => {
    expect(await createInAppBrowserTools([], context)).toEqual([])
    expect(
      await createInAppBrowserTools(
        [{ ...capabilities[0], providerDisplayName: "other" }] as McpCapabilityTool[],
        context
      )
    ).toEqual([])
  })
  it("discovers names and exact variables without exposing script source", async () => {
    const result = JSON.parse(
      (await (await createInAppBrowserTools(capabilities, context))[0].invoke({})) as string
    )
    expect(result.recordings[0]).toMatchObject({
      name: "市场系统查询企业管户信息",
      variables: [{ identifier: "变量_企业", displayName: "企业", isArray: false }]
    })
    expect(JSON.stringify(result)).not.toContain("旧企业")
    expect(mocks.list).toHaveBeenCalledWith({ includeVariableInfo: false })
    expect(mocks.read).toHaveBeenCalledOnce()
  })
  it("passes extracted parameters and waits for execution before requesting snapshot", async () => {
    let finish!: () => void
    mocks.execute.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const pending = (await createInAppBrowserTools(capabilities, context))[1].invoke(input)
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalled())
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ ...context, ...input }))
    expect(mocks.list).toHaveBeenCalledWith({ includeVariableInfo: false })
    expect(mocks.read).toHaveBeenCalledOnce()
    finish()
    expect(JSON.parse((await pending) as string)).toMatchObject({
      status: "completed",
      nextStep: expect.stringContaining("先调用 browser_snapshot")
    })
  })
  it.each([
    `  ${input.fileName}  `,
    `/tmp/recordings/${input.fileName}`,
    `C:\\recordings\\${input.fileName}`,
    "市场系统查询企业管户信息"
  ])("resolves a listed recording from a stable reference: %s", async (fileName) => {
    const executeTool = (await createInAppBrowserTools(capabilities, context))[1]

    await executeTool.invoke({ ...input, fileName })

    expect(mocks.read).toHaveBeenCalledWith({ fileName: input.fileName })
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ ...context, ...input, fileName: input.fileName })
    )
  })
  it("does not resolve an ambiguous display name", async () => {
    mocks.list.mockResolvedValue([
      { fileName: input.fileName, displayName: "重复名称" },
      { fileName: "other.spec.ts", displayName: "重复名称" }
    ])

    await expect(
      (await createInAppBrowserTools(capabilities, context))[1].invoke({
        ...input,
        fileName: "重复名称"
      })
    ).rejects.toThrow("录制脚本不存在")
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it.each([
    { variableValues: {} },
    { variableValues: { 企业: "华为" } },
    { variableValues: { 变量_企业: ["华为"] } },
    { fileName: "missing.spec.ts" }
  ])("rejects invalid arguments without running old recorded values: %j", async (overrides) => {
    await expect(
      (await createInAppBrowserTools(capabilities, context))[1].invoke({
        ...input,
        ...overrides
      })
    ).rejects.toThrow()
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it("propagates playback failures instead of reporting completion", async () => {
    mocks.execute.mockRejectedValue(new Error("定位失败"))
    await expect(
      (await createInAppBrowserTools(capabilities, context))[1].invoke(input)
    ).rejects.toThrow("定位失败")
  })
  it("does not cancel an existing manual playback", async () => {
    mocks.state.mockReturnValue({ status: "running" })
    await expect(
      (await createInAppBrowserTools(capabilities, context))[1].invoke(input)
    ).rejects.toThrow("已有回放")
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
  it("cancels owned playback when the agent is stopped and removes the listener", async () => {
    const controller = new AbortController()
    let finish!: () => void
    mocks.execute.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const pending = (
      await createInAppBrowserTools(capabilities, {
        ...context,
        abortSignal: controller.signal
      })
    )[1].invoke(input)
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalled())
    controller.abort()
    expect(mocks.cancel).toHaveBeenCalledOnce()
    finish()
    await expect(pending).rejects.toThrow()
  })
})
