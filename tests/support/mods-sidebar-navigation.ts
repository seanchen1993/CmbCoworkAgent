import type { Page } from "playwright"

/** Follow the production entry after thread hydration; never skip a not-yet-mounted button. */
export async function openModsResults(page: Page): Promise<void> {
  await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  await page
    .getByRole("complementary", { name: "任务进展", exact: true })
    .getByRole("tab", { name: "结果", exact: true })
    .click()
}

/** Open the installed Mod settings through the current production navigation. */
export async function openModsSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "自定义设置", exact: true }).click()
  const advanced = page.getByRole("button", { name: "高级自定义", exact: true })
  if ((await advanced.getAttribute("aria-expanded")) === "false") await advanced.click()
  await page.getByRole("button", { name: "灵件管理", exact: true }).click()
  await page
    .getByRole("navigation", { name: "灵件工作区", exact: true })
    .getByRole("button", { name: "我已添加", exact: true })
    .click()
  await page.locator("[data-mods-settings]").waitFor()
}
