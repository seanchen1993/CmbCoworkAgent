import type { BrowserWindow, IpcMain, WebContents } from "electron"
import {
  WINDOW_PRESENTATION_CHANGED,
  WINDOW_PRESENTATION_READ,
  type WindowPresentationSnapshot
} from "../shared/window-presentation"

const registries = new WeakMap<IpcMain, Map<WebContents, () => WindowPresentationSnapshot>>()

/** Read-only, own top-level window state; no cross-window IDs or window controls. */
export function registerWindowPresentation(ipc: IpcMain, window: BrowserWindow): void {
  let registry = registries.get(ipc)
  if (!registry) {
    registry = new Map()
    registries.set(ipc, registry)
    const entries = registry
    ipc.handle(WINDOW_PRESENTATION_READ, (event) => {
      const read = entries.get(event.sender)
      if (!read || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
        throw new Error("WINDOW_PRESENTATION_SENDER_INVALID")
      }
      return read()
    })
  }
  const entries = registry
  const contents = window.webContents
  if (registry.has(contents)) return
  let version = 0
  const read = (): WindowPresentationSnapshot => ({
    version,
    presentable: !window.isDestroyed() && window.isVisible() && !window.isMinimized()
  })
  registry.set(contents, read)
  const changed = (): void => {
    version++
    if (!contents.isDestroyed()) contents.send(WINDOW_PRESENTATION_CHANGED, read())
  }
  window.on("show", changed)
  window.on("hide", changed)
  window.on("minimize", changed)
  window.on("restore", changed)
  const cleanup = (): void => {
    entries.delete(contents)
    window.removeListener("show", changed)
    window.removeListener("hide", changed)
    window.removeListener("minimize", changed)
    window.removeListener("restore", changed)
    window.removeListener("closed", cleanup)
    contents.removeListener("destroyed", cleanup)
  }
  window.once("closed", cleanup)
  contents.once("destroyed", cleanup)
}
