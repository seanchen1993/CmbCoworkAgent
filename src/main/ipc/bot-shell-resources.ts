import { registerBotWindowsNativeSetupHandlers } from "./bot-windows-native-setup"
import { BrowserWindow, ipcMain, shell } from "electron"
import { join } from "node:path"
import { z } from "zod"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { botIpcFailure } from "../bots/error-diagnostic"
import {
  inspectDesktopBotShellResources,
  revealDesktopBotShellResource,
  revealDesktopBotShellResourceDiagnostics
} from "../bots/desktop-owned-shell-maintenance"
import {
  botDesktopShellResourceReviewSchema,
  botShellResourceAddressSchema
} from "../../shared/bot-shell-resources"

export function registerBotShellResourceHandlers(): void {
  registerBotWindowsNativeSetupHandlers(ipcMain)
  const directory = () => join(getCmbCoworkAgentDataRoot(), "bot-host")
  const handlers = {
    inspect: async (input: unknown) => {
      z.undefined().parse(input)
      return botDesktopShellResourceReviewSchema.parse(
        await inspectDesktopBotShellResources(directory())
      )
    },
    reveal: async (input: unknown) => {
      const { nonce } = botShellResourceAddressSchema.parse(input)
      const path = await revealDesktopBotShellResource(directory(), nonce)
      shell.showItemInFolder(path)
    },
    "reveal-diagnostics": async (input: unknown) => {
      z.undefined().parse(input)
      const path = await revealDesktopBotShellResourceDiagnostics(directory())
      if (await shell.openPath(path)) throw new Error("无法打开命令诊断目录，请稍后重试")
    }
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`bots:shell-resources:${name}`, async (event, input: unknown) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Bot 请求必须来自应用主界面")
      try {
        return await handler(input)
      } catch (error) {
        return botIpcFailure(error)
      }
    })
  }
}
