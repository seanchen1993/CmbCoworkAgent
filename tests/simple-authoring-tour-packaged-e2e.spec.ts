/** Production package tour: actual layouts, retained drafts and real navigation. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { simpleTourTasks } from "../src/renderer/src/components/customize/simple-tour-tasks"

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR, "Explicit newly built package required")
const packageDir = resolve(process.env.CMB_MODS_PACKAGED_DIR)
const hash = () =>
  createHash("sha256")
    .update(readFileSync(join(packageDir, "resources/app.asar")))
    .digest("hex")
const packageHash = hash()
const artifacts = join(root, "output/simple-authoring-20261013", `tour-packaged-${Date.now()}`)
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const errors: string[] = []
const checks: string[] = []
const previews: unknown[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let completed = false
const draft = "保留这条未发送的原始草稿"
const profileDraft = "保留我的组合草稿"
async function shot(name: string) {
  await page!.screenshot({ path: join(artifacts, `${name}.png`) })
}
async function main() {
  const watchdog = setTimeout(() => {
    errors.push("300 second watchdog expired")
    void app?.close()
  }, 300_000)
  try {
    app = await launch(60_000)
    page = await app.firstWindow()
    page.setDefaultTimeout(20_000)
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("dialog", async (dialog) => {
      errors.push(`Unexpected dialog: ${dialog.message()}`)
      await dialog.dismiss()
    })
    await page.addInitScript("window.__name = value => value")
    await page.waitForFunction(() => !!window.api?.threads)
    const threadId = await page.evaluate(async (workspace) => {
      const row = await window.api.threads.create({
        title: "三任务导览同包验收",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id = (row as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, workspace)
      return id
    }, workspace)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("三任务导览同包验收", { exact: true }).first().click()
    await page.locator("textarea.composer-textarea").fill(draft)
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await page.getByRole("button", { name: "添加功能", exact: true }).click()
    const tour = page.getByRole("region", { name: "新功能导览", exact: true })
    await page.getByRole("button", { name: "新功能导览", exact: true }).click()
    await tour.waitFor()
    await page.keyboard.press("Escape")
    // Enable editing through the real settings UI before creating the retained local draft.
    await page.getByRole("button", { name: "我已添加", exact: true }).click()
    await page.getByRole("checkbox", { name: "允许使用灵件", exact: true }).click()
    await page.waitForFunction(() => window.api.mods.globalEnabled())
    await page.getByRole("checkbox", { name: "在此项目使用灵件", exact: true }).click()
    await page.waitForFunction(async (id) => (await window.api.mods.status(id)).enabled, threadId)
    await page.getByRole("button", { name: "助手组合", exact: true }).click()
    const simple = page.getByRole("region", { name: "简单组合", exact: true })
    await simple.getByLabel("组合名称", { exact: true }).fill(profileDraft)
    await page.getByRole("button", { name: "新功能导览", exact: true }).click()
    for (const width of [1366, 375]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(0, 0)
        window.setContentSize(width, 900)
      }, width)
      await page.waitForFunction((width) => window.innerWidth === width, width)
      for (const [task, item] of simpleTourTasks.entries()) {
        // Remount each task to start at its first screen, including the first task on the next width.
        await tour.getByLabel("选择任务", { exact: true }).selectOption(String((task + 1) % 3))
        await tour.getByLabel("选择任务", { exact: true }).selectOption(String(task))
        for (const [step, screen] of item.steps.entries()) {
          await tour.getByRole("heading", { name: screen.title, exact: true }).waitFor()
          const preview = tour.locator(
            `[data-tour-preview-chapter="${task}"][data-tour-preview-stage="${step}"]`
          )
          const geometry = await preview.evaluate((node) => {
            const bounds = node.getBoundingClientRect()
            return {
              width: bounds.width,
              height: bounds.height,
              left: bounds.left,
              right: bounds.right,
              borderedCards: Array.from(node.querySelectorAll("div,p")).filter((child) => {
                const style = getComputedStyle(child)
                return (
                  child.getBoundingClientRect().height > 20 && parseFloat(style.borderTopWidth) > 0
                )
              }).length,
              overflow: node.scrollWidth > node.clientWidth + 1,
              text: node.textContent
            }
          })
          assert(geometry.width > 80 && geometry.height > 100 && geometry.borderedCards > 0)
          assert.equal(geometry.overflow, false)
          assert(geometry.left >= 0 && geometry.right <= width + 1)
          previews.push({ width, task, step, geometry })
          if (task === 0 && step === 1) await tour.getByLabel("新插件名称").fill("我的导览副本")
          await shot(`${width}-task-${task + 1}-step-${step + 1}`)
          if (step < 2) {
            const next = tour.getByRole("button", { name: screen.action, exact: true })
            await next.focus()
            await page.keyboard.press("Enter")
          }
        }
      }
    }
    await page.keyboard.press("Escape")
    assert.equal(await simple.getByLabel("组合名称", { exact: true }).inputValue(), profileDraft)
    assert(
      await page
        .getByRole("button", { name: "看看这页怎么用", exact: true })
        .evaluate((node) => node === document.activeElement)
    )
    checks.push(
      "Three tasks × three real rendered previews at desktop and 375px; keyboard progression and Escape preserve combination draft"
    )
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1366, 900)
    )
    for (const [task, item] of simpleTourTasks.entries()) {
      if (task === 2) await page.getByRole("button", { name: "助手组合", exact: true }).click()
      await page.getByRole("button", { name: "新功能导览", exact: true }).click()
      await tour.getByLabel("选择任务", { exact: true }).selectOption(String(task))
      for (const [step, screen] of item.steps.entries()) {
        if (task === 0 && step === 1) await tour.getByLabel("新插件名称").fill("我的导览副本")
        await tour.getByRole("button", { name: screen.action, exact: true }).click()
      }
      if (task === 0) {
        const create = page.getByRole("region", { name: "从已有插件创建", exact: true })
        await create.getByRole("button", { name: "按演练要求新建插件", exact: true }).waitFor()
        assert((await create.innerText()).includes("我的导览副本"))
      } else if (task === 1) {
        await simple.getByRole("button", { name: "另建演练中的组合", exact: true }).waitFor()
        assert.equal(
          await simple.getByLabel("组合名称", { exact: true }).inputValue(),
          profileDraft
        )
      } else {
        await page.getByRole("dialog", { name: "查看改动", exact: true }).waitFor()
      }
      await shot(`handoff-${item.task}`)
    }
    await page.keyboard.press("Escape")
    assert.equal(await page.locator("textarea.composer-textarea").inputValue(), draft)
    assert.equal((await page.evaluate((id) => window.api.mods.flowRuns(id), threadId)).length, 0)
    assert.equal(await page.evaluate(() => localStorage.getItem("devclaw.sparks-tour.v1")), "seen")
    checks.push(
      "Real create/combine/diff destinations reached; suggested name handed off; chat draft intact; no runs"
    )
    assert.deepEqual(errors, [])
    completed = true
  } catch (error) {
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close().catch((error) => errors.push(String(error)))
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        { completed, checks, errors, previews, packageHash, packageDir, isolated },
        null,
        2
      )
    )
    assert.equal(hash(), packageHash, "Package changed during acceptance")
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
