import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesignSystemResult } from "../../shared/design-system"
import { DesignSystemLibrary } from "../services/design/system-library"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  capture: vi.fn(),
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
vi.mock("../services/design/page-capture", () => ({ captureDesignPage: mocks.capture }))
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
      restrictedReason
    },
    styles: {
      body: style,
      elements: { button: style },
      colors: [style.color],
      spacing: ["8px"],
      radius: ["4px"],
      viewport: { width: 1440, height: 1000 }
    },
    assertCurrent: vi.fn(),
    dispose: vi.fn()
  }
}

describe("design system extraction IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    const library = new DesignSystemLibrary("/unused")
    library.save = mocks.save
    registerDesignSystemLibraryHandlers(
      () => library,
      () => ({})
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
    expect(mocks.save).not.toHaveBeenCalled()
    expect(page.dispose).toHaveBeenCalledOnce()
  })
  it("returns restricted pages for browser confirmation instead of importing a login style", async () => {
    const page = captured("请完成登录")
    mocks.capture.mockResolvedValue(page)
    const result = await extract(
      { sender: sender(1) },
      { requestId: "extract-login", source: "current-browser" }
    )
    expect(result).toMatchObject({ success: false, needsUserAction: true, error: "请完成登录" })
    expect(result.draft).toBeUndefined()
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
