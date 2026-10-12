import type { IpcMain, WebContents, Session } from "electron"
import { botLinkPreviewCancel } from "../../shared/bot-link-preview"
import { botIpcFailure } from "./error-diagnostic"
import { BotDomainError } from "../../shared/bot-types"
import { BotLinkPreviewService } from "./link-preview-service"
import { LinkPreviewFailure } from "./public-link-fetch"
import type { BotLinkPreviewServiceOptions } from "./link-preview-service"

/** Logical cancellation of Electron's non-cancellable resolveProxy, without retaining raw late results. */
export function previewProxyPolicy(
  session: Pick<Session, "resolveProxy">,
  environment: NodeJS.ProcessEnv = process.env
) {
  // Electron cannot abort resolveProxy physically. Keep its actual outstanding
  // calls bounded even after their cancelled consumer has already settled.
  let pendingNative = 0
  return async (url: string, signal: AbortSignal): Promise<string> => {
    if (
      (environment.https_proxy ?? environment.HTTPS_PROXY ?? "") ||
      (environment.http_proxy ?? environment.HTTP_PROXY ?? "") ||
      (environment.all_proxy ?? environment.ALL_PROXY ?? "")
    )
      return "PROXY configured"
    signal.throwIfAborted()
    if (pendingNative >= 2) throw new LinkPreviewFailure("unavailable")
    ++pendingNative
    const native = Promise.resolve().then(() => session.resolveProxy(url))
    return new Promise((resolve, reject) => {
      let finished = false
      const abort = () => {
        if (finished) return
        finished = true
        reject(signal.reason)
      }
      signal.addEventListener("abort", abort, { once: true })
      native
        .then(
          (value) => {
            if (finished) return
            finished = true
            resolve(value)
          },
          () => {
            if (finished) return
            finished = true
            resolve("PROXY unavailable")
          }
        )
        .finally(() => {
          --pendingNative
          signal.removeEventListener("abort", abort)
        })
    })
  }
}
/** Narrow future integration: caller provides the existing trusted-window mainFrame validator. */
export function registerBotLinkPreviewIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  service: BotLinkPreviewService,
  assertMainFrame: (event: Electron.IpcMainInvokeEvent) => void
) {
  const owners = new Map<number, { contents: WebContents; destroy: () => void }>()
  const owner = (event: Electron.IpcMainInvokeEvent) => {
    assertMainFrame(event)
    if (!owners.has(event.sender.id)) {
      const destroy = () => {
        service.closeOwner(String(event.sender.id))
        owners.delete(event.sender.id)
      }
      owners.set(event.sender.id, { contents: event.sender, destroy })
      event.sender.once("destroyed", destroy)
    }
    return String(event.sender.id)
  }
  ipc.handle("bots:getLinkPreview", async (event, input: unknown) => {
    const identity = owner(event)
    try {
      return await service.get(identity, input)
    } catch (error) {
      return botIpcFailure(error)
    }
  })
  try {
    ipc.handle("bots:cancelLinkPreview", (event, input: unknown) => {
      const identity = owner(event)
      try {
        const parsed = botLinkPreviewCancel.safeParse(input)
        if (!parsed.success)
          throw new BotDomainError("invalid_link_preview_request", "链接预览请求无效，请重试")
        service.cancel(identity, parsed.data.requestId)
        return undefined
      } catch (error) {
        return botIpcFailure(error)
      }
    })
  } catch (error) {
    ipc.removeHandler("bots:getLinkPreview")
    throw error
  }
  let closing: Promise<void> | undefined
  return () => {
    if (closing) return closing
    ipc.removeHandler("bots:getLinkPreview")
    ipc.removeHandler("bots:cancelLinkPreview")
    closing = service.close().finally(() => {
      for (const owner of owners.values()) owner.contents.removeListener("destroyed", owner.destroy)
      owners.clear()
    })
    return closing
  }
}
export function createMainBotLinkPreviewService(
  session: Pick<Session, "resolveProxy">,
  image: BotLinkPreviewServiceOptions["image"]
) {
  return new BotLinkPreviewService({
    proxyFor: previewProxyPolicy(session),
    image
  })
}
