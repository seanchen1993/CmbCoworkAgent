import type { Page } from "playwright"

/** Follow visible creator navigation; never prepare, approve, install or start through IPC. */
export async function openCreatorStep(page: Page, step: "trial" | "delivery") {
  const workspace = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  if (!await workspace.isVisible())
    await page.locator('[data-app-guide="workspace"]').click()
  await workspace.getByRole("navigation", { name: "插件制作步骤", exact: true })
    .getByRole("button", { name: step === "trial" ? "2 · 试用" : "3 · 保存插件", exact: true }).click()
  return workspace
}

export async function openCreatorProjectPreview(page: Page) {
  const workspace = await openCreatorStep(page, "trial")
  const panel = workspace.getByRole("region", { name: "项目模板隔离试用", exact: true }).first()
  if (!await panel.isVisible()) {
    const tools = workspace.locator('[data-creator-section="create"] > summary')
    if (!await tools.evaluate(element => (element.parentElement as HTMLDetailsElement).open))
      await tools.click()
    await workspace.getByText("高级：独立项目试用", { exact: true }).click()
  }
  await panel.waitFor()
  return panel
}
