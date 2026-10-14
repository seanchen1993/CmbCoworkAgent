import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { BrowserWindow } from "electron"
import type { FunctionDesktopBroker } from "../mods/v2/desktop-broker"
import type { DesktopResponse } from "../../shared/mods/v2/desktop-actions"

export function registerDesktopHandlers(
  ipc: IpcMain,
  broker: FunctionDesktopBroker,
  scope: (event: IpcMainInvokeEvent, threadId: string) => string
): void {
  const observed = new WeakSet<IpcMainInvokeEvent["sender"]>()
  const windows = new WeakSet<BrowserWindow>()
  ipc.handle("mods:desktop-attach", (event, input: { threadId: string; owner: string }) => {
    scope(event, input?.threadId)
    if (event.sender.isDestroyed()) throw Error("MODS_DESKTOP_OWNER")
    const window = BrowserWindow.fromWebContents(event.sender)
    broker.attach(input.threadId, input.owner, event.sender.id, (request) => {
      if (event.sender.isDestroyed()) throw Error("MODS_DESKTOP_OWNER")
      event.sender.send("mods:desktop-request", request)
    }, () => Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()))
    if (!observed.has(event.sender)) {
      observed.add(event.sender)
      const sender = event.sender.id
      event.sender.once("destroyed", () => broker.closeSender(sender))
    }
    if (window && !windows.has(window)) {
      windows.add(window)
      const sender = event.sender.id
      window.on("hide", () => broker.pauseSender(sender))
      window.on("minimize", () => broker.pauseSender(sender))
    }
  })
  ipc.handle("mods:desktop-detach", (event, input: { threadId: string; owner: string }) => {
    if (
      !input ||
      typeof input.threadId !== "string" ||
      typeof input.owner !== "string" ||
      input.threadId.length > 200 ||
      input.owner.length > 100
    )
      throw Error("MODS_DESKTOP_OWNER")
    broker.detach(input.threadId, input.owner, event.sender.id)
  })
  ipc.handle("mods:desktop-response", (event, response: DesktopResponse) => {
    scope(event, response?.threadId)
    broker.respond(event.sender.id, response)
  })
  ipc.handle(
    "mods:desktop-copy",
    (event, input: { threadId: string; owner: string; requestId: string; present: boolean }) => {
      scope(event, input?.threadId)
      broker.commitCopy(
        event.sender.id,
        input.threadId,
        input.owner,
        input.requestId,
        input.present
      )
    }
  )
}
