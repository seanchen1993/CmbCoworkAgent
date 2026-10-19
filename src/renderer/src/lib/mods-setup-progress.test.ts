import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.mock("@/lib/store", () => ({ useAppStore: {} }))
import { ModsSetupProgress } from "../components/customize/ModsGuide"

const ready = {
  installed: true,
  globalEnabled: true,
  globalLoaded: true,
  workspace: { enabled: true },
  authorized: true
}
it.each([
  [{ readFailed: true }, "配置读取失败"],
  [{ globalLoaded: false, readFailed: true }, "配置读取失败"],
  [{ globalLoaded: false }, "正在读取配置"],
  [{ installed: false }, "日常任务可直接回到普通聊天描述并发送"],
  [{ globalEnabled: false }, "打开下方本应用的功能开关"],
  [{ workspace: null }, "先在聊天中选择项目目录"],
  [{ workspace: { enabled: false } }, "打开下方项目开关"],
  [{ authorized: false }, "在下方插件卡片查看所需权限，确认后授权"],
  [{}, "设置已完成"]
])("shows the next required setup step: %j", (patch, expected) => {
  const html = renderToStaticMarkup(createElement(ModsSetupProgress, { ...ready, ...patch }))
  expect(html).toContain(expected)
  if (Object.keys(patch).length) expect(html).not.toContain("设置已完成")
  if ("installed" in patch && patch.installed === false) {
    expect(html).toContain("插件设置进度")
    expect(html).toContain("想添加功能可先进入创造者模式")
    expect(html).toContain("需要安装现成插件时，再从这里选择")
    expect(html.indexOf("普通聊天描述并发送")).toBeLessThan(
      html.indexOf("需要安装现成插件时")
    )
    expect(html).not.toContain("先选择要添加的插件")
    expect(html).not.toContain("按步骤执行")
    expect(html).not.toContain("先安装一个 Mods")
  }
})

