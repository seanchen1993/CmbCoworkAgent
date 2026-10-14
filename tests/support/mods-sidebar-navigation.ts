import type { Page } from "playwright"

/** Follow the production entry after thread hydration; never skip a not-yet-mounted button. */
export async function openModsResults(page: Page): Promise<void> {
  await page.getByRole("button", { name: "打开 Claw 工作台", exact: true }).click()
  await page.getByRole("button", { name: "插件与结果", exact: true }).click()
}
