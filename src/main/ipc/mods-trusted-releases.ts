import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import type { TrustedReleaseDelivery } from "../mods/devtools/trusted-release-delivery"

export function registerTrustedReleaseHandlers(
  ipc: IpcMain,
  delivery: TrustedReleaseDelivery,
  window: () => BrowserWindow | null,
  trusted: (event: IpcMainInvokeEvent) => void
): void {
  ipc.handle("mods:trusted-release:available", event => {
    trusted(event)
    return delivery.available
  })
  let installing = false
  ipc.handle("mods:trusted-release:install", async (event, input: unknown) => {
    trusted(event)
    if (!delivery.available) throw Error("TRUSTED_RELEASE_AUTHORITY_UNAVAILABLE")
    if (installing) throw Error("TRUSTED_RELEASE_BUSY")
    const owner = window()
    const sender = event.sender
    const frame = sender.mainFrame
    if (!owner || owner.isDestroyed() || owner.webContents !== sender)
      throw Error("TRUSTED_RELEASE_WINDOW_CHANGED")
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    const assertCurrent = () => {
      if (signal.aborted || owner !== window() || owner.isDestroyed() ||
        sender.isDestroyed() || sender.mainFrame !== frame || event.senderFrame !== frame)
        throw Error("TRUSTED_RELEASE_WINDOW_CHANGED")
      trusted(event)
    }
    installing = true
    sender.on("did-start-navigation", cancel)
    sender.on("render-process-gone", cancel)
    sender.on("destroyed", cancel)
    try {
      return await delivery.install(input, { signal, assertCurrent }, async ({ release, name, version }) => {
        assertCurrent()
        const result = await dialog.showMessageBox(owner, {
          type: "question", title: "安装已核验的灵件版本",
          message: "安装 " + name + " " + version + "？",
          detail: [
            "发布者 " + release.publisherId,
            "发布条目 " + release.listingId,
            "发布版本 " + release.releaseId,
            "包 SHA-256 " + release.package.packageSha256,
            "此版本将独立保存，等待后续配置、授权和启用。"
          ].join("\n"),
          buttons: ["取消", "保存为未启用版本"], defaultId: 0, cancelId: 0, noLink: true
        })
        return result.response === 1
      })
    } finally {
      sender.removeListener("did-start-navigation", cancel)
      sender.removeListener("render-process-gone", cancel)
      sender.removeListener("destroyed", cancel)
      installing = false
    }
  })
}
