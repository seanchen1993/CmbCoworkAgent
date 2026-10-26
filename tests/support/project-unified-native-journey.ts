import assert from "node:assert/strict"
import type { ElectronApplication, Page } from "playwright"

const guideHandlers = new WeakSet<Page>()

export async function openUnifiedProjectList(page: Page) {
  const creator = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  if (!guideHandlers.has(page)) {
    guideHandlers.add(page)
    const guide = page.getByRole("dialog", { name: "项目模式使用引导", exact: true })
    try {
      await page.addLocatorHandler(creator, async () => {
        await creator.getByRole("button", { name: "Close", exact: true }).click()
        await creator.waitFor({ state: "hidden" })
      })
      await page.addLocatorHandler(guide, async () => {
        await guide.getByRole("button", { name: "知道了，不再提示", exact: true }).click()
        await guide.waitFor({ state: "hidden" })
      })
    } catch (error) {
      guideHandlers.delete(page)
      throw error
    }
  }
  const back = page.getByRole("button", { name: "返回会话", exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByRole("tab", { name: "项目模式", exact: true }).click()
  const list = page.getByRole("button", { name: "项目列表", exact: true }).first()
  if (await list.isVisible()) await list.click()
  await page.getByRole("button", { name: "新建项目", exact: true }).first().waitFor()
}

export async function openUnifiedHostProject(page: Page, name: string) {
  await openUnifiedProjectList(page)
  await page.getByRole("button", { name: `打开项目 ${name}`, exact: true }).click()
  await page.getByRole("heading", { name: new RegExp(`^${escapeRegex(name)} ·`) }).waitFor()
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Real renderer creation; only the native directory picker receives a bounded fixture choice. */
export async function createUnifiedHostProject(app: ElectronApplication, page: Page, input: {
  name: string
  workspace: string
  installedPluginId: string
  pluginName: string
  version: string
  goal: string
}) {
  const previous = await page.evaluate(() => window.api.harnessBoard.localProjects.list())
  await openUnifiedProjectList(page)
  await page.getByRole("button", { name: "新建项目", exact: true }).first().click()
  const nativeSelect = page.getByLabel("项目插件", { exact: true })
  const picker = page.getByRole("button", { name: /^选择插件/ })
  await nativeSelect.or(picker).first().waitFor()
  if (await nativeSelect.isVisible()) {
    await nativeSelect.selectOption(input.installedPluginId)
  } else {
    await picker.click()
    await page.getByRole("option", {
      name: new RegExp(`^${escapeRegex(input.pluginName)} · ${escapeRegex(input.version)}(?: |$)`)
    }).click()
  }
  await page.getByLabel("项目名称", { exact: true }).fill(input.name)
  await page.getByLabel("希望完成什么", { exact: true }).fill(input.goal)
  await app.evaluate(({ dialog }, workspace) => {
    let count = 0
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = (async (_owner: unknown, options?: { title?: string }) => {
      if (options?.title !== "选择任务工作目录" || ++count !== 1)
        throw Error("UNEXPECTED_PROJECT_DIRECTORY_DIALOG")
      dialog.showOpenDialog = original
      return { canceled: false, filePaths: [workspace] }
    }) as typeof dialog.showOpenDialog
  }, input.workspace)
  await page.getByRole("button", { name: "选择工作目录", exact: true }).click()
  await page.getByRole("button", { name: "创建项目", exact: true }).click()
  await page.getByRole("heading", { name: new RegExp(`^${escapeRegex(input.name)} ·`) }).waitFor()
  const projects = await page.evaluate(() => window.api.harnessBoard.localProjects.list())
  const created = projects.filter(project => !previous.some(old => old.projectId === project.projectId))
  assert.equal(created.length, 1, "The public form must create exactly one new Host project")
  const view = await page.evaluate(id => window.api.harnessBoard.localProjects.get(id), created[0].projectId)
  assert.equal(view.project.name, input.name)
  assert.equal(view.project.workspace, input.workspace)
  assert.equal(view.project.installedPluginId, input.installedPluginId)
  assert.equal(view.project.packageVersion, input.version)
  assert.equal(view.project.manifest.mode, "host")
  assert.equal(view.project.stageIndex, 0)
  assert.equal(view.project.version, 1)
  assert.deepEqual(view.operations, [])
  return view
}
