import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import type { TrustedReleaseUseRequest } from "../../shared/mods/trusted-release"
import type { TrustedReleaseDelivery } from "../mods/devtools/trusted-release-delivery"

export function registerTrustedReleaseHandlers(
  ipc: IpcMain,
  delivery: TrustedReleaseDelivery,
  window: () => BrowserWindow | null,
  trusted: (event: IpcMainInvokeEvent) => void,
  captureUseTarget?: (threadId: string, workspace: string) => () => void
): void {
  ipc.handle("mods:trusted-release:available", event => {
    trusted(event)
    return delivery.available
  })
  let busy = false
  type Scope = { signal: AbortSignal; assertCurrent(): void }
  async function withOwner<T>(
    event: IpcMainInvokeEvent,
    operation: (owner: BrowserWindow, scope: Scope) => Promise<T>
  ): Promise<T> {
    trusted(event)
    if (!delivery.available) throw Error("TRUSTED_RELEASE_AUTHORITY_UNAVAILABLE")
    if (busy) throw Error("TRUSTED_RELEASE_BUSY")
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
    busy = true
    sender.on("did-start-navigation", cancel)
    sender.on("render-process-gone", cancel)
    sender.on("destroyed", cancel)
    try {
      assertCurrent()
      return await operation(owner, { signal, assertCurrent })
    } finally {
      sender.removeListener("did-start-navigation", cancel)
      sender.removeListener("render-process-gone", cancel)
      sender.removeListener("destroyed", cancel)
      busy = false
    }
  }
  ipc.handle("mods:trusted-release:install", (event, input: unknown) =>
    withOwner(event, (owner, scope) =>
      delivery.install(input, scope, async ({ release, name, version }) => {
        scope.assertCurrent()
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
    )
  )
  ipc.handle("mods:trusted-release:prepare-use", (event, input: unknown) =>
    withOwner(event, async (_owner, scope) => {
      if (!captureUseTarget || !input || typeof input !== "object")
        throw Error("TRUSTED_RELEASE_DESTINATION_UNSUPPORTED")
      const { threadId, expectedWorkspace, installationId, publisherId, listingId, releaseId } =
        input as Partial<TrustedReleaseUseRequest>
      if (typeof threadId !== "string" || !threadId || threadId.length > 200 ||
        typeof expectedWorkspace !== "string" || !expectedWorkspace || expectedWorkspace.length > 4096 ||
        typeof installationId !== "string" || installationId.length !== 36)
        throw Error("TRUSTED_RELEASE_USE_INPUT_INVALID")
      const assertTarget = captureUseTarget(threadId, expectedWorkspace)
      return delivery.prepareUse({ publisherId, listingId, releaseId }, installationId, {
        threadId, workspace: expectedWorkspace
      }, {
        signal: scope.signal,
        assertCurrent() {
          scope.assertCurrent()
          assertTarget()
        }
      })
    })
  )
}
