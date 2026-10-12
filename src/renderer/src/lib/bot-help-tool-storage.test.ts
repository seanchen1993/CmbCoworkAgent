import { createElement, type PropsWithChildren } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { BotHelp } from "../components/bots/BotHelp"

// Read Help's actual rendered content without its browser-only portal.
vi.mock("../components/bots/BotDialog", () => ({
  BotDialogContent: ({ children }: PropsWithChildren) => children
}))

afterEach(() => vi.unstubAllGlobals())

it.each(["darwin", "win32", "linux"])(
  "explains temporary command storage and checkpoint limits in Help on %s",
  (platform) => {
    vi.stubGlobal("window", { electron: { process: { platform } }, api: {} })
    const html = renderToStaticMarkup(
      createElement(BotHelp, {
        host: null,
        disconnected: false,
        close: () => {},
        refresh: async () => {},
        openSettings: () => {},
        openKeyboard: () => {}
      })
    )
    const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) ?? []
    const storage = details.find((entry) => entry.includes("安装的工具和临时文件会保留吗？"))
    expect(storage).toBeDefined()
    expect(storage).toContain("具体命令审批")
    expect(storage).toContain("已授权项目目录")
    expect(storage).toContain("HOME 和临时目录不作为持久保存位置")
    expect(storage).toContain("恢复点以实际范围为准")
    expect(storage).toContain("自选项目、系统软件及含链接的依赖目录需另行处理")
  }
)
