import { readFileSync } from "node:fs"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { registerDirectoryPickerHandler } from "./directory-picker"
import { resolveTrustedAppRendererUrl } from "../main-log-forwarding"

const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock("electron", () => ({ dialog: { showOpenDialog: mocks.open } }))

function fixture() {
  const url = "file:///app/renderer/index.html"
  const contents = { isDestroyed: () => false, mainFrame: { url }, getURL: () => url }
  const owner = { isDestroyed: () => false, webContents: contents } as BrowserWindow
  let current: BrowserWindow | null = owner
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, options?: unknown) => Promise<unknown>
  >()
  registerDirectoryPickerHandler(
    { handle: (name, run) => { handlers.set(name, run) } } as IpcMain,
    () => current,
    resolveTrustedAppRendererUrl(false, undefined, url)
  )
  const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent
  const select = (options?: unknown, sender = event) =>
    handlers.get("file:selectDirectory")!(sender, options)
  return {
    contents,
    owner,
    event,
    select,
    replace: () => {
      current = null
    }
  }
}

beforeEach(() => mocks.open.mockReset())

describe("native directory selection used by project creation", () => {
  it("registers the exact preload channel at normal application startup", () => {
    const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
    const preload = readFileSync(new URL("../../preload/index.ts", import.meta.url), "utf8")
    expect(main).toContain(
      "registerDirectoryPickerHandler(ipcMain, () => mainWindow, trustedMainRendererUrl)"
    )
    expect(main).toContain("const trustedMainRendererUrl = resolveTrustedAppRendererUrl(")
    expect(preload).toContain('ipcRenderer.invoke("file:selectDirectory", options)')
  })
  it("returns the user-picked directory without workspace mutation or read grants", async () => {
    const f = fixture()
    mocks.open.mockResolvedValue({ canceled: false, filePaths: ["C:\\验收工程"] })
    expect(await f.select({ title: "选择任务工作目录" })).toEqual({
      canceled: false,
      filePaths: ["C:\\验收工程"]
    })
    expect(mocks.open).toHaveBeenCalledWith(f.owner, {
      title: "选择任务工作目录",
      properties: ["openDirectory"]
    })
  })
  it("does not expose stale paths after cancellation", async () => {
    mocks.open.mockResolvedValue({ canceled: true, filePaths: ["C:\\old"] })
    expect(await fixture().select()).toEqual({ canceled: true, filePaths: [] })
  })
  it("rejects other renderers and subframes before opening the picker", async () => {
    const f = fixture()
    await expect(
      f.select({}, { ...f.event, senderFrame: {} } as IpcMainInvokeEvent)
    ).rejects.toThrow("UNTRUSTED_SENDER")
    await expect(f.select({}, { ...f.event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow(
      "UNTRUSTED_SENDER"
    )
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it.each(["frame", "window"])("rejects a changed %s while the dialog was open", async (kind) => {
    const f = fixture()
    mocks.open.mockImplementation(async () => {
      if (kind === "frame") f.contents.mainFrame = { url: f.contents.mainFrame.url }
      else f.replace()
      return { canceled: false, filePaths: ["C:\\private"] }
    })
    await expect(f.select()).rejects.toThrow("UNTRUSTED_SENDER")
  })
  it("bounds caller-supplied dialog text", async () => {
    await expect(fixture().select({ title: "x".repeat(201) })).rejects.toThrow("INVALID_INPUT")
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it.each(["before", "during"])(
    "rejects navigation to an external URL %s selection",
    async (when) => {
      const f = fixture()
      const navigate = () => {
        f.contents.mainFrame.url = "https://example.test/untrusted"
      }
      if (when === "before") navigate()
      mocks.open.mockImplementation(async () => {
        navigate()
        return { canceled: false, filePaths: ["C:\\private"] }
      })
      await expect(f.select()).rejects.toThrow("UNTRUSTED_SENDER")
      if (when === "before") expect(mocks.open).not.toHaveBeenCalled()
    }
  )
})
