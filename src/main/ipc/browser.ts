import type { BrowserWindow, IpcMain } from "electron"
import { BrowserService } from "../browser/browser-service"
import type {
  BrowserAttachOptions,
  BrowserBounds,
  BrowserClickTarget,
  BrowserNavigateOptions
} from "../../shared/browser-types"

export function registerBrowserHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
): BrowserService {
  const browserService = new BrowserService(getMainWindow)

  ipcMain.handle("browser:attach", (_event, sessionId: string, options?: BrowserAttachOptions) =>
    browserService.attach(sessionId, options)
  )

  ipcMain.handle("browser:detach", (_event, sessionId: string) => browserService.detach(sessionId))

  ipcMain.handle(
    "browser:setBounds",
    (_event, sessionId: string, bounds: BrowserBounds, visible?: boolean) =>
      browserService.setBounds(sessionId, bounds, visible)
  )

  ipcMain.handle(
    "browser:navigate",
    (_event, sessionId: string, url: string, options?: BrowserNavigateOptions) =>
      browserService.navigate(sessionId, url, options)
  )

  ipcMain.handle("browser:goBack", (_event, sessionId: string) => browserService.goBack(sessionId))

  ipcMain.handle("browser:goForward", (_event, sessionId: string) =>
    browserService.goForward(sessionId)
  )

  ipcMain.handle("browser:reload", (_event, sessionId: string) => browserService.reload(sessionId))

  ipcMain.handle("browser:stop", (_event, sessionId: string) => browserService.stop(sessionId))

  ipcMain.handle("browser:getState", (_event, sessionId: string) =>
    browserService.getState(sessionId)
  )

  ipcMain.handle("browser:captureScreenshot", (_event, sessionId: string) =>
    browserService.captureScreenshot(sessionId)
  )

  ipcMain.handle("browser:readRenderedState", (_event, sessionId: string, includeHtml?: boolean) =>
    browserService.readRenderedState(sessionId, includeHtml)
  )

  ipcMain.handle("browser:click", (_event, sessionId: string, target: BrowserClickTarget) =>
    browserService.click(sessionId, target)
  )

  ipcMain.handle("browser:typeText", (_event, sessionId: string, text: string) =>
    browserService.typeText(sessionId, text)
  )

  ipcMain.handle("browser:press", (_event, sessionId: string, keyCode: string) =>
    browserService.press(sessionId, keyCode)
  )

  return browserService
}
