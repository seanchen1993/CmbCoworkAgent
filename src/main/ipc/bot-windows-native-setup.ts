import { BrowserWindow, type IpcMain } from "electron"
import { z } from "zod"
import { botIpcFailure } from "../bots/error-diagnostic"
import {
  botWindowsNativeSetupRequest,
  botWindowsNativeSetupStatus,
  botWindowsNativeSetupResult
} from "../../shared/bot-windows-native-setup"

/** Explicit application setup authority. No arbitrary argv, model request,
 * workspace root, native package path or capability flag crosses this IPC. */
export function registerBotWindowsNativeSetupHandlers(ipcMain: IpcMain): void {
  const handlers = {
    status: async (input: unknown) => {
      z.undefined().parse(input)
      return botWindowsNativeSetupStatus.parse(
        await (
          await import("../bots/desktop-windows-native-setup")
        ).getDesktopWindowsNativeSetupStatus()
      )
    },
    initialize: async (input: unknown) => {
      const request = botWindowsNativeSetupRequest.parse(input)
      const backend = await import("../bots/desktop-windows-native-setup")
      return botWindowsNativeSetupResult.parse(
        await backend.initializeDesktopWindowsNativeSandbox(request)
      )
    }
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`bots:windows-sandbox:${name}`, async (event, input: unknown) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("初始化请求必须来自应用主界面")
      try {
        return await handler(input)
      } catch (error) {
        return botIpcFailure(error)
      }
    })
  }
}
