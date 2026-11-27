import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { _electron } from "playwright"
import { expect } from "playwright/test"

async function run() {
  const root = await mkdtemp(join(tmpdir(), "workspace-project-onboarding-"))
  const paths = ["零售工作区", "暂不关联", "关闭弹窗", "键盘退出"].map((name) => join(root, name))
  const [retail, skipped, closed, escaped] = paths
  const editGuide = process.argv.includes("--guide-edit")
  const botsStartup = process.argv.includes("--bots-startup")
  if (botsStartup) {
    await mkdir(join(root, "data"))
    await writeFile(join(root, "data", "settings.json"), JSON.stringify({ startupView: "bots" }))
  }
  await Promise.all(paths.map((path) => mkdir(path)))
  const app = await _electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [resolve("out/main/index.js"), "--user-data-dir=" + join(root, "electron")],
    env: {
      ...process.env,
      CMB_COWORK_AGENT_HOME: join(root, "data"),
      ELECTRON_RUN_AS_NODE: "",
      NO_PROXY: "127.0.0.1,localhost"
    }
  })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    const add = page.getByRole("button", { name: "新增工作区", exact: true })
    await app.evaluate(
      ({ dialog, ipcMain }, folders) => {
        dialog.showOpenDialog = async () => {
          const folder = folders.shift()
          return { canceled: !folder, filePaths: folder ? [folder] : [] }
        }
        const choice = { projectCode: "P001", projectName: "零售改造", pm: "张三" }
        ipcMain.removeHandler("harnessBoard:searchEnterpriseProjects")
        ipcMain.handle("harnessBoard:searchEnterpriseProjects", (_, { keyword }) => ({
          projects: [choice].filter((p) => (p.projectName + p.projectCode).includes(keyword)),
          hasMore: false
        }))
        ipcMain.removeHandler("harnessBoard:verifyEnterpriseProjectCode")
        ipcMain.handle(
          "harnessBoard:verifyEnterpriseProjectCode",
          (_, code) => code === choice.projectCode
        )
      },
      [retail, retail, skipped, skipped, closed, escaped]
    )
    const modal = page.getByRole("dialog", { name: "关联工作区项目" })
    const code = modal.getByLabel("项目编码", { exact: true })
    const firstRows = (path: string) =>
      page.evaluate(
        async (path) =>
          (await window.api.threads.listPage({ limit: 50 })).threads
            .filter((row) => row.metadata?.workspacePath === path)
            .map((row) => row.metadata?.chatProject),
        path
      )
    const guide = page.getByRole("dialog", { name: "工作区项目指引" })
    const guideState = () =>
      page.evaluate(() =>
        window.api.uiGuides.getState({
          guideId: "workspace-project-binding",
          revision: 1,
          maxShowCount: 1
        })
      )
    if (botsStartup) {
      await page.locator(".bots-workspace").waitFor({ timeout: 30_000 })
      await expect(guide).toBeHidden()
      await page.reload()
    }
    await add.waitFor({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "关联工作区项目", exact: true })).toHaveCount(0)
    await expect(guide).toBeHidden()
    expect((await guideState()).shownCount).toBe(0)
    async function checkGuideOnEntry(workspace: string, buttonLabel: string) {
      await expect(guide).toBeHidden()
      const scheduled = page.getByRole("button", { name: "自动化", exact: true })
      await scheduled.click()
      await expect(scheduled).toHaveAttribute("aria-current", "page")
      expect((await guideState()).shownCount).toBe(0)
      await expect(guide).toBeHidden()
      const threadId = await page.evaluate(
        async (path) =>
          (await window.api.threads.listPage({ limit: 50 })).threads.find(
            (t) => t.metadata?.workspacePath === path
          )!.thread_id,
        workspace
      )
      await page
        .locator(`[data-sidebar-thread-id="${threadId}"]`)
        .click({ position: { x: 6, y: 12 } })
      await expect(guide).toBeVisible()
      const anchor = page.getByRole("button", { name: buttonLabel, exact: true })
      await expect(anchor).toHaveAttribute("aria-describedby", /.+/)
      if (process.env.WORKSPACE_PROJECT_GUIDE_SCREENSHOT) {
        const row = (await anchor.locator("..").boundingBox())!
        const tip = (await guide.boundingBox())!
        const x = Math.floor(Math.min(row.x, tip.x))
        const y = Math.floor(Math.min(row.y, tip.y))
        await page.screenshot({
          path: process.env.WORKSPACE_PROJECT_GUIDE_SCREENSHOT,
          animations: "disabled",
          clip: {
            x,
            y,
            width: Math.ceil(Math.max(row.x + row.width, tip.x + tip.width) - x),
            height: Math.ceil(Math.max(row.y + row.height, tip.y + tip.height) - y)
          }
        })
      }
      if (editGuide) {
        await guide.getByRole("button", { name: "去关联" }).click()
        await expect(
          modal.getByText(workspace.split(/[\\/]/).at(-1)!, { exact: true })
        ).toBeVisible()
        await modal.getByRole("button", { name: "取消" }).click()
      } else await guide.getByRole("button", { name: "知道了" }).click()
      await expect(guide).toBeHidden()
      expect((await guideState()).shownCount).toBe(1)
    }
    await add.click()
    await expect(modal).toBeVisible()
    await expect(modal.getByText("新建会话会继承工作区项目，已有会话保留原项目。")).toBeVisible()
    if (process.env.WORKSPACE_PROJECT_UX_SCREENSHOT)
      await modal.screenshot({
        path: process.env.WORKSPACE_PROJECT_UX_SCREENSHOT,
        animations: "disabled"
      })
    const name = modal.getByLabel("项目名称", { exact: true })
    await name.fill("不存在")
    await expect(page.getByText("未找到匹配的精益项目")).toBeVisible()
    await name.press("Escape")
    await expect(page.getByText("未找到匹配的精益项目")).toBeHidden()
    await expect(modal).toBeVisible()
    await name.fill("零售")
    const match = page.getByRole("button", { name: /P001.*零售改造/ })
    await expect(match).toBeVisible()
    await name.press("ArrowDown")
    await expect(match).toBeFocused()
    await match.press("Enter")
    await expect(code).toHaveValue("P001")
    await modal.getByRole("button", { name: "关联项目", exact: true }).click()
    const lean = { code: "P001", name: "零售改造", fromLean: true }
    await expect.poll(() => firstRows(retail)).toEqual([lean])
    const badge = page.getByRole("button", { name: "更改工作区项目 P001" })
    await expect(badge).toBeVisible()
    if (!editGuide) await checkGuideOnEntry(retail, "更改工作区项目 P001")
    await badge.click()
    await expect(name).toHaveValue("零售改造")
    await code.fill("零售二期")
    await expect(name).toHaveValue("零售改造")
    await name.fill("零售业务改造二期")
    await expect(code).toHaveValue("零售二期")
    await modal.getByRole("button", { name: "保存更改" }).click()
    await expect(modal).toBeHidden()
    await page.getByRole("button", { name: "更改工作区项目 零售二期" }).click()
    await expect(name).toHaveValue("零售业务改造二期")
    await name.fill("零售业务改造")
    await modal.getByRole("button", { name: "保存更改" }).click()
    await expect(modal).toBeHidden()
    await add.click()
    await expect
      .poll(() => firstRows(retail))
      .toEqual([{ code: "零售二期", name: "零售业务改造", fromLean: false }, lean])
    const sessionBadge = page.getByTitle("更改会话项目").filter({ hasText: "零售二期" })
    await sessionBadge.click()
    const session = page.getByRole("dialog", { name: "关联会话项目" })
    await expect(
      session.getByText("本会话历史和后续的代码生成与采纳都会计入所选项目。")
    ).toBeVisible()
    await expect(session.getByLabel("项目名称", { exact: true })).toHaveValue("零售业务改造")
    await session.getByLabel("项目名称", { exact: true }).fill("会话专用名称")
    await session.getByRole("button", { name: "保存更改" }).click()
    await expect
      .poll(() => firstRows(retail))
      .toEqual([{ code: "零售二期", name: "会话专用名称", fromLean: false }, lean])
    for (const [path, action] of [
      [skipped, "暂不关联"],
      [closed, "Close"],
      [escaped, "Escape"]
    ]) {
      await add.click()
      await expect(modal).toBeVisible()
      if (action === "Escape") {
        await expect(code).toBeFocused()
        await page.keyboard.press("Escape")
      } else await modal.getByRole("button", { name: action, exact: true }).click()
      await expect(modal).toBeHidden()
      await expect.poll(() => firstRows(path)).toEqual([null])
      if (path === skipped) {
        if (editGuide) await checkGuideOnEntry(skipped, "关联工作区项目")
        const icon = page.getByRole("button", { name: "关联工作区项目", exact: true })
        await expect(guide).toBeHidden()
        await page.mouse.move(0, 0)
        await expect(icon).toBeVisible()
        assert.equal(await icon.evaluate((el) => getComputedStyle(el).opacity), "1")
        const initialX = (await icon.boundingBox())!.x
        await icon.hover()
        await icon.evaluate(async (el) => {
          await Promise.all(
            el.parentElement!.getAnimations({ subtree: true }).map((a) => a.finished)
          )
        })
        assert.ok(
          Math.abs((await icon.boundingBox())!.x - initialX) <= 1,
          "hover actions must not move the project button"
        )
        await page.mouse.move(0, 0)
        if (process.env.WORKSPACE_PROJECT_SIDEBAR_SCREENSHOT)
          await icon.locator("..").screenshot({
            path: process.env.WORKSPACE_PROJECT_SIDEBAR_SCREENSHOT,
            animations: "disabled"
          })
        await icon.click()
        await expect(modal.getByRole("button", { name: "取消" })).toBeVisible()
        await name.fill("先填的自定义名称")
        await code.fill("仅草稿")
        await expect(name).toHaveValue("先填的自定义名称")
        await modal.getByRole("button", { name: "取消" }).click()
        await add.click()
        await expect.poll(() => firstRows(path)).toEqual([null, null])
        await expect(modal).toBeHidden()
      }
    }
    await page.reload()
    await expect(page.getByRole("button", { name: "更改工作区项目 零售二期" })).toBeVisible()
    await expect(guide).toBeHidden()
    await page.getByRole("button", { name: "更改工作区项目 零售二期" }).click()
    await expect(name).toHaveValue("零售业务改造")
    await modal.getByRole("button", { name: "取消" }).click()
    await add.click() // cancel the system folder picker
    await expect(modal).toBeHidden()
    console.log(
      "PASS workspace onboarding, independent project code/name, session inheritance, name-only edits, persisted names and one-time project guidance"
    )
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
