import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesignSystemResult } from "../../shared/design-system"
import { createDesignModel } from "../services/design/model"
import { DesignSystemLibrary } from "../services/design/system-library"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  capture: vi.fn(),
  getModel: vi.fn(),
  stream: vi.fn(),
  save: vi.fn(),
  openDialog: vi.fn(),
  saveDialog: vi.fn()
}))
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn)
  },
  dialog: { showOpenDialog: mocks.openDialog, showSaveDialog: mocks.saveDialog },
  BrowserWindow: { fromWebContents: () => null }
}))
vi.mock("../services/design/page-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/design/page-capture")>()),
  captureDesignPage: mocks.capture
}))
vi.mock("../services/design/capture-assets", () => ({
  capturePublicUrl: (value: string) => {
    const url = new URL(value)
    url.search = ""
    url.hash = ""
    return url.href
  }
}))
import { registerDesignSystemLibraryHandlers } from "./design-system-library"

function extract(event: unknown, request: unknown): Promise<DesignSystemResult> {
  return mocks.handlers.get("design:extract-system")!(event, request) as Promise<DesignSystemResult>
}
const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function sender(id: number) {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: vi.fn() })
}
const style = {
  color: "rgb(20, 20, 20)",
  background: "rgb(250, 250, 250)",
  fontFamily: "sans-serif",
  fontSize: "14px",
  fontWeight: "400",
  lineHeight: "20px",
  padding: "8px",
  gap: "8px",
  borderRadius: "4px",
  border: "1px solid gray",
  boxShadow: "none"
}
function captured(restrictedReason?: string) {
  return {
    snapshot: {
      title: "团队工作台",
      url: "https://example.com/app?token=secret",
      html: "<main>Private account data</main>",
      restrictedReason
    },
    screenshot: Buffer.from("screenshot bytes"),
    styles: {
      body: style,
      elements: { button: style },
      colors: [style.color],
      spacing: ["8px"],
      radius: ["4px"],
      viewport: { width: 1440, height: 1000 },
      layout: { main: { width: 960, left: 240, display: "grid" } }
    },
    assertCurrent: vi.fn(),
    dispose: vi.fn()
  }
}

describe("design system extraction IPC", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.handlers.clear()
    mocks.getModel.mockReturnValue({ stream: mocks.stream })
    const library = new DesignSystemLibrary("/unused")
    library.save = mocks.save
    registerDesignSystemLibraryHandlers(
      () => library,
      () => ({}),
      mocks.getModel
    )
  })
  it("reads native file selections into drafts and does not save until requested", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-system-file-"))
    temporary.push(dir)
    const file = path.join(dir, "DESIGN.md")
    fs.writeFileSync(file, "# 上传规范\n\n字体 14px")
    mocks.openDialog.mockResolvedValue({ canceled: false, filePaths: [file] })
    const selected = (await mocks.handlers.get("design:select-system-file")!({
      sender: sender(1)
    })) as DesignSystemResult
    expect(selected.draft).toMatchObject({ name: "上传规范", content: "# 上传规范\n\n字体 14px" })
    expect(mocks.save).not.toHaveBeenCalled()
    fs.writeFileSync(file, "\0binary")
    const invalid = (await mocks.handlers.get("design:select-system-file")!({
      sender: sender(1)
    })) as DesignSystemResult
    expect(invalid.success).toBe(false)
  })
  it("exports the edited Markdown through the save dialog and respects cancellation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-system-export-"))
    temporary.push(dir)
    const file = path.join(dir, "design.md")
    mocks.saveDialog.mockResolvedValue({ canceled: false, filePath: file })
    const result = await mocks.handlers.get("design:export-system")!(
      { sender: sender(1) },
      "# 修改后的规范"
    )
    expect(result).toMatchObject({ success: true })
    expect(fs.readFileSync(file, "utf8")).toBe("# 修改后的规范")
    mocks.saveDialog.mockResolvedValue({ canceled: true })
    expect(
      await mocks.handlers.get("design:export-system")!({ sender: sender(1) }, "# 不保存")
    ).toMatchObject({ canceled: true })
    expect(fs.readFileSync(file, "utf8")).toBe("# 修改后的规范")
  })
  it("generates an editable style draft without saving it or leaking source tokens", async () => {
    const page = captured()
    mocks.capture.mockResolvedValue(page)
    const result = await extract(
      { sender: sender(1) },
      { requestId: "extract-1", source: "url", url: "https://example.com/app" }
    )
    expect(result.success).toBe(true)
    expect(result.draft?.sourceUrl).toBe("https://example.com/app")
    expect(result.draft?.content).toContain("8px")
    expect(result.draft?.content).toContain("当前页面未观察到")
    expect(result.draft?.content).not.toContain("secret")
    expect(mocks.getModel).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(page.dispose).toHaveBeenCalledOnce()
  })
  it("generates and previews a reusable spec from style and layout data through the selected model", async () => {
    const markdown = [
      "# 工作台设计规范",
      "## 设计方向\n保持紧凑、中性的页面层次。",
      "## 色彩\n将 rgb(250, 250, 250) 用作页面背景。",
      "## 字体与排版\n正文使用 14px 和 20px 行高。",
      "## 布局与间距\n桌面主区实测宽 960px，内边距使用 8px。",
      "## 组件规范\n按钮沿用 4px 圆角。",
      "## 交互与可访问性\n建议为键盘焦点提供可见轮廓。",
      "## 实现示例\n```css\n:root { --radius: 4px; }\nbutton { border-radius: var(--radius); }\n```"
    ].join("\n\n")
    const body = (finishReason: string) =>
      [
        {
          delta: { role: "assistant", reasoning_content: "private reasoning" },
          finish_reason: null
        },
        {
          delta: {
            content: ["<think>inline reasoning</think>", "", "```md", markdown, "```"].join("\n")
          },
          finish_reason: null
        },
        { delta: {}, finish_reason: finishReason }
      ]
        .map(
          (choice) =>
            `data: ${JSON.stringify({ id: "spec", choices: [{ index: 0, ...choice }] })}\n\n`
        )
        .join("") + "data: [DONE]\n\n"
    const page = captured()
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(body("stop"), { headers: { "content-type": "text/event-stream" } })
    )
    mocks.getModel.mockReturnValue(
      createDesignModel({ model: "test", apiKey: "test", baseUrl: "http://mock.invalid/v1" }, fetch)
    )
    mocks.capture.mockResolvedValue(page)
    const owner = sender(1)
    const result = await extract(
      { sender: owner },
      { requestId: "extract-ai", source: "current-browser", mode: "ai", modelId: "custom:test" }
    )
    expect(mocks.getModel).toHaveBeenCalledWith("custom:test")
    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body))
    expect(JSON.parse(payload.messages[1].content)).toEqual(page.styles)
    expect(JSON.stringify(payload)).not.toMatch(
      /团队工作台|example\.com|secret|Private account|screenshot bytes/
    )
    expect(result.draft?.content).toBe(`${markdown}\n\n## 来源\n\nhttps://example.com/app\n`)
    expect(owner.send).toHaveBeenCalledWith(
      "design:system-extraction-progress",
      expect.objectContaining({ requestId: "extract-ai", message: expect.stringContaining("生成") })
    )
    expect(page.dispose).toHaveBeenCalledOnce()
    expect(mocks.save).not.toHaveBeenCalled()

    fetch.mockResolvedValueOnce(
      new Response(body("length"), { headers: { "content-type": "text/event-stream" } })
    )
    const truncated = await extract(
      { sender: owner },
      { requestId: "extract-truncated", source: "current-browser", mode: "ai" }
    )
    expect(truncated).toMatchObject({ success: false, error: expect.stringContaining("长度上限") })
    expect(truncated.draft).toBeUndefined()
  })
  it("reports unavailable or invalid AI output and lets users retry with styles only", async () => {
    const owner = sender(1)
    const request = { requestId: "extract-retry", source: "url", url: "https://example.com" }
    mocks.getModel.mockReturnValueOnce(null)
    const unavailable = await extract({ sender: owner }, { ...request, mode: "ai" })
    expect(unavailable.error).toContain("配置模型")
    expect(mocks.capture).not.toHaveBeenCalled()

    mocks.capture.mockImplementation(async () => captured())
    mocks.stream.mockResolvedValue([{ content: "# 未完成", response_metadata: {} }])
    const invalid = await extract({ sender: owner }, { ...request, mode: "ai" })
    expect(invalid).toMatchObject({
      success: false,
      error: expect.stringContaining("完整的设计规范")
    })
    const fallback = await extract({ sender: owner }, { ...request, mode: "styles" })
    expect(fallback.draft?.content).toContain("常用内边距")
    expect(mocks.stream).toHaveBeenCalledOnce()
  })
  it("cancels AI generation, releases the extraction slot and discards a late model reply", async () => {
    const owner = sender(1)
    const request = { requestId: "extract-model-cancel", source: "current-browser" }
    const page = captured()
    mocks.capture.mockResolvedValueOnce(page).mockImplementation(async () => captured())
    let finish!: (value: unknown) => void
    mocks.stream.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = extract({ sender: owner }, { ...request, mode: "ai" })
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledOnce())
    expect(page.dispose).toHaveBeenCalledOnce()
    const signal = mocks.stream.mock.calls[0][1].signal as AbortSignal
    expect(
      mocks.handlers.get("design:cancel-system-extraction")!({ sender: owner }, request.requestId)
    ).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(await pending).toEqual({ success: false, canceled: true })
    expect(await extract({ sender: owner }, { ...request, mode: "styles" })).toMatchObject({
      success: true
    })
    finish([{ content: "# 迟到的输出", response_metadata: {} }])
  })
  it("returns restricted pages for browser confirmation instead of importing a login style", async () => {
    const page = captured("请完成登录")
    mocks.capture.mockResolvedValue(page)
    const result = await extract(
      { sender: sender(1) },
      { requestId: "extract-login", source: "current-browser", mode: "ai" }
    )
    expect(result).toMatchObject({ success: false, needsUserAction: true, error: "请完成登录" })
    expect(result.draft).toBeUndefined()
    expect(mocks.stream).not.toHaveBeenCalled()
    expect(page.dispose).toHaveBeenCalledOnce()
  })
  it("restricts cancellation to the owner and discards late results after cancellation", async () => {
    let finish!: (page: ReturnType<typeof captured>) => void
    mocks.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const owner = sender(1)
    const pending = extract(
      { sender: owner },
      { requestId: "extract-slow", source: "current-browser" }
    )
    expect(
      mocks.handlers.get("design:cancel-system-extraction")!({ sender: sender(2) }, "extract-slow")
    ).toBe(false)
    expect(
      mocks.handlers.get("design:cancel-system-extraction")!({ sender: owner }, "extract-slow")
    ).toBe(true)
    const page = captured()
    finish(page)
    expect(await pending).toMatchObject({ success: false, canceled: true })
    expect(page.dispose).toHaveBeenCalledOnce()
  })
  it("cancels work when the owning window is destroyed and rejects invalid links", async () => {
    const owner = sender(1)
    let finish!: (page: ReturnType<typeof captured>) => void
    mocks.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = extract(
      { sender: owner },
      { requestId: "extract-destroy", source: "current-browser" }
    )
    owner.emit("destroyed")
    finish(captured())
    expect(await pending).toMatchObject({ canceled: true })
    const invalid = await extract(
      { sender: sender(2) },
      { requestId: "extract-bad", source: "url", url: "file:///etc/passwd" }
    )
    expect(invalid.success).toBe(false)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
  })
})
