import { ipcMain, type WebContents } from "electron"
import { randomUUID } from "node:crypto"
import { getGlobalBrowserService } from "../browser/core/browser-service-registry"
import { DesignUrlImportService } from "../services/design/url-import-service"
import {
  DESIGN_IMPORT_PROGRESS_CHANNEL,
  type DesignImportRequest
} from "../../shared/design-url-import"

export function registerDesignUrlImportHandlers(getWorkspace: () => string): void {
  const service = new DesignUrlImportService()
  const owners = new Set<number>()
  const watch = (sender: WebContents) => {
    if (owners.has(sender.id)) return
    owners.add(sender.id)
    sender.once("destroyed", () => {
      service.cancelOwner(sender.id)
      owners.delete(sender.id)
    })
    sender.on("render-process-gone", () => service.cancelOwner(sender.id))
    sender.on("did-start-navigation", (_event, _url, _inPlace, main) => {
      if (main) service.cancelOwner(sender.id)
    })
  }
  ipcMain.handle("design:import-url", (event, input: Partial<DesignImportRequest> | string) => {
    watch(event.sender)
    const value = typeof input === "string" ? { url: input } : (input ?? {})
    const request: DesignImportRequest = {
      ...value,
      requestId: typeof value.requestId === "string" ? value.requestId : randomUUID(),
      source: value.source ?? "url",
      allowRestrictedPage: value.allowRestrictedPage === true,
      workspacePath:
        typeof value.workspacePath === "string" && value.workspacePath
          ? value.workspacePath
          : getWorkspace()
    }
    return service.run(event.sender.id, request, (progress) => {
      if (event.sender.isDestroyed()) throw new Error("导入窗口已关闭")
      event.sender.send(DESIGN_IMPORT_PROGRESS_CHANNEL, progress)
    })
  })
  ipcMain.handle("design:cancel-url-import", (event, requestId: string) =>
    service.cancel(event.sender.id, requestId)
  )
  ipcMain.handle("design:finish-url-import", (event, requestId: string, keep: boolean) =>
    service.finish(event.sender.id, requestId, keep === true)
  )
  ipcMain.handle(
    "design:prepare-url-import-for-editing",
    (event, requestId: string, sessionId: string) =>
      service.prepareForEditing(event.sender.id, requestId, sessionId)
  )
  ipcMain.handle("design:open-import-browser", async (_event, url: string) => {
    try {
      const parsed = new URL(url)
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error("仅支持不含账号密码的 HTTP 或 HTTPS 链接")
      const browser = getGlobalBrowserService()
      if (!browser) throw new Error("内置浏览器尚未初始化")
      // The renderer opens the panel and owns visibility through its bounds.
      // Preparing a target may finish after the user has already closed it.
      await browser.prepareTarget({ visible: false })
      const state = await browser.navigate(parsed.href)
      if (state.error) throw new Error(state.error)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "打开内置浏览器失败"
      }
    }
  })
}
