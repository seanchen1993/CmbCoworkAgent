import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const readRepositoryFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8")

describe("appearance settings integration", () => {
  const customizeView = readRepositoryFile(
    "src/renderer/src/components/customize/CustomizeView.tsx"
  )
  const generalPanel = readRepositoryFile("src/renderer/src/components/customize/GeneralPanel.tsx")
  const appearancePanel = readRepositoryFile(
    "src/renderer/src/components/customize/AppearancePanel.tsx"
  )

  it("places Appearance directly below General in the settings navigation", () => {
    expect(customizeView).toContain('| "appearance"')
    expect(customizeView).toContain("<AppearancePanel />")
    expect(customizeView).toMatch(
      /\{ tab: "general", label: "通用", icon: Settings2 \},\s*\{ tab: "appearance", label: "外观", icon: Palette \}/
    )
  })

  it("keeps theme and visual-effect controls out of General", () => {
    expect(generalPanel).not.toContain("界面主题")
    expect(generalPanel).not.toContain("输入框动态光效")
    expect(generalPanel).not.toContain("会话滚动")
    expect(generalPanel).not.toContain("智能跟随最新消息")
    expect(appearancePanel).toContain("界面主题")
    expect(appearancePanel).toContain("外观模式")
    expect(appearancePanel).toContain("输入框动态光效")
    expect(appearancePanel).toContain("setThemeModePreference")
    expect(appearancePanel).toContain("setThemeForColorScheme")
  })
})
