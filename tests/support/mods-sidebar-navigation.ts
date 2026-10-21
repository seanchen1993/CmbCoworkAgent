import type { Locator, Page } from "playwright"
import assert from "node:assert/strict"
import { normalizeWorkspacePathKey } from "../../src/shared/workspace-path"

/** Use the production chat switch; never write creator state or a grant from the fixture. */
export async function enterModsCreatorChat(page: Page, threadId: string, workspace: string) {
  const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
  const creator = chat.getByRole("button", { name: "创造者模式", exact: true })
  await creator.waitFor({ state: "visible" })
  if ((await creator.getAttribute("aria-pressed")) !== "true") await creator.click()
  await chat.getByRole("button", { name: "创造者模式", exact: true, pressed: true }).waitFor()
  const actual = await page.evaluate(
    (id) => window.api.mods.development.status({ threadId: id }),
    threadId
  )
  assert.equal(actual.threadId, threadId)
  assert.equal(normalizeWorkspacePathKey(actual.workspace), normalizeWorkspacePathKey(workspace))
  assert.equal(actual.mode, "creator")
}

async function dismissModsTour(page: Page): Promise<void> {
  const tour = page.getByRole("region", { name: "任务示例演练", exact: true })
  if (await tour.isVisible())
    await tour.getByRole("button", { name: "关闭示例演练", exact: true }).click()
}

/** Opening an already visible panel must not toggle it closed or enter a hidden retained copy. */
export async function openModsProgress(
  page: Page,
  tab: "当前任务" | "结果" | "高级设置" = "当前任务"
): Promise<Locator> {
  const panel = page.getByRole("complementary", { name: "任务进展", exact: true })
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  await panel.getByRole("tab", { name: tab, exact: true }).click()
  return panel
}

export async function openModsResults(page: Page): Promise<void> {
  const panel = await openModsProgress(page, "结果")
  const records = panel.getByText("命令与完成记录", { exact: true })
  if (!(await records.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await records.click()
}

export async function closeModsProgress(page: Page): Promise<void> {
  await page
    .getByRole("complementary", { name: "任务进展", exact: true })
    .getByRole("button", { name: "收起任务进展", exact: true })
    .click()
}

export async function openModsFlowPreset(page: Page): Promise<Locator> {
  const panel = await openModsProgress(page, "高级设置")
  const summary = panel.getByText("高级：为下一条消息使用预设任务", { exact: true })
  if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await summary.click()
  return panel.getByLabel("本次使用的步骤", { exact: true })
}

export async function openModsFlowHistory(page: Page, runId: string): Promise<Locator> {
  const panel = await openModsProgress(page)
  const run = panel.locator(`[data-flow-run="${runId}"]`)
  await run.waitFor({ state: "visible" })
  const details = run.getByText("排查详情：执行记录", { exact: true })
  if (!(await details.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await details.click()
  const summary = run.getByText("历史步骤与技术详情", { exact: true })
  if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await summary.click()
  await run.getByRole("list", { name: "步骤执行记录", exact: true }).waitFor()
  return run
}

export async function openModsAdvancedSettings(
  page: Page,
  section: "灵件管理" | "搭配管理" | "聊天任务模板"
): Promise<void> {
  const advanced = page.getByRole("button", { name: "高级自定义", exact: true })
  if (!(await advanced.isVisible()))
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
  await advanced.waitFor({ state: "visible" })
  await dismissModsTour(page)
  if ((await advanced.getAttribute("aria-expanded")) === "false") await advanced.click()
  await page.getByRole("button", { name: section, exact: true }).click()
  if (section === "聊天任务模板") {
    const details = page.locator("[data-diy-flows] > details")
    await details.waitFor({ state: "visible" })
    if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
      await details.locator(":scope > summary").click()
  }
}

export async function openModsClawEditor(page: Page): Promise<void> {
  const summary = page.getByText("高级编辑与已保存组合", { exact: true })
  await summary.waitFor({ state: "visible" })
  await dismissModsTour(page)
  if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await summary.click()
}

export async function openModsClawMoreSettings(page: Page): Promise<void> {
  const summary = page.getByText("更多设置：技能、工具、模型与步骤", { exact: true })
  if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await summary.click()
}

/** Open the installed Mod settings through the current production navigation. */
export async function openModsSettings(page: Page): Promise<void> {
  await openModsAdvancedSettings(page, "灵件管理")
  await page
    .getByRole("navigation", { name: "灵件工作区", exact: true })
    .getByRole("button", { name: "我已添加", exact: true })
    .click()
  await page.locator("[data-mods-settings]").waitFor()
}

/** Select the active settings form; retained sidebar copies and nested help stay untouched. */
export async function openModUserConfig(page: Page, pluginId: string): Promise<Locator> {
  const form = page
    .locator("[data-mods-settings]")
    .locator(`[data-function-user-config="${pluginId}"]`)
  await form.waitFor({ state: "visible" })
  if (!(await form.evaluate((element) => (element as HTMLDetailsElement).open)))
    await form.locator(":scope > summary").click()
  return form
}
