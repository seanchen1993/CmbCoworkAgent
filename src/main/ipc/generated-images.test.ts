import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerGeneratedImageHandlers } from "./generated-images"

const { dialog, loadThread, loadGroup } = vi.hoisted(() => ({
  dialog: { showSaveDialog: vi.fn() },
  loadThread: vi.fn(),
  loadGroup: vi.fn()
}))
vi.mock("electron", () => ({ dialog }))
vi.mock("../generated-images", () => ({ readGeneratedImage: loadThread }))
vi.mock("../bots/generated-image-delivery", () => ({ readDeliveredGeneratedImage: loadGroup }))
vi.mock("../main-log-forwarding", () => ({ isTrustedRendererUrl: vi.fn() }))

const buffers: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  for (const path of buffers.splice(0)) await rm(path, { recursive: true, force: true })
})

function bridge() {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  const handlers = new Map<string, Handler>()
  const webContents = { isDestroyed: () => false, mainFrame: {} }
  const win = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  const event = {
    sender: webContents,
    senderFrame: webContents.mainFrame
  } as unknown as IpcMainInvokeEvent
  registerGeneratedImageHandlers(
    {
      handle: (name: string, handler: Handler) => handlers.set(name, handler)
    } as unknown as IpcMain,
    () => win
  )
  const invoke = (method: string, ...args: unknown[]) =>
    handlers.get("generated-images:" + method)!(event, ...args)
  return { handlers, invoke, event }
}

describe("generated image desktop IPC", () => {
  it("requires the main frame and one authority, and returns only authorized media", async () => {
    const { invoke, event, handlers } = bridge()
    const source = {
      groupId: "group",
      messageId: "group-message",
      fileIndex: 0,
      actionId: randomUUID()
    }
    loadGroup.mockImplementation(async (_, variant, verify) => {
      verify()
      return {
        bytes: Buffer.from("group"),
        mimeType: variant === "original" ? "image/png" : "image/webp"
      }
    })
    expect(await invoke("read", source, "original")).toBe("data:image/png;base64,Z3JvdXA=")
    await expect(invoke("read", { ...source, threadId: "private" }, "original")).rejects.toThrow()
    await expect(invoke("read", source, "unbounded")).rejects.toThrow()
    await expect(
      handlers.get("generated-images:read")!(
        { ...event, senderFrame: {} } as IpcMainInvokeEvent,
        source,
        "thumbnail"
      )
    ).rejects.toThrow("主窗口")
    expect(loadGroup).toHaveBeenCalledTimes(1)
    expect(loadThread).not.toHaveBeenCalled()
  })

  it("exports once, preserves the old destination on revocation, and removes failed staging files", async () => {
    const { invoke } = bridge()
    const source = { threadId: "private", messageId: "message", actionId: randomUUID() }
    const path = await mkdtemp(join(tmpdir(), "generated-export-"))
    buffers.push(path)
    const output = join(path, "image.png")
    await writeFile(output, "original destination")
    const assertCurrent = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw Error("撤回")
      })
    loadThread.mockResolvedValue({
      bytes: Buffer.from("PNG output"),
      mimeType: "image/png",
      assertCurrent
    })
    dialog.showSaveDialog.mockResolvedValue({ filePath: output })
    await expect(invoke("save", source)).rejects.toThrow("撤回")
    expect(await readFile(output, "utf8")).toBe("original destination")
    expect(await readdir(path)).toEqual(["image.png"])
    expect(await invoke("save", source)).toBe(true)
    expect(await readFile(output, "utf8")).toBe("PNG output")
    expect(loadThread).toHaveBeenCalledTimes(2)
    dialog.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await invoke("save", source)).toBe(false)
    loadThread.mockRejectedValue(new Error("无回执"))
    await expect(invoke("save", source)).rejects.toThrow("无回执")
    expect(dialog.showSaveDialog).toHaveBeenCalledTimes(3)
  })
})
