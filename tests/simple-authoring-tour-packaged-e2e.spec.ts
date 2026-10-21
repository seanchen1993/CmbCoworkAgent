/** Production package tour: actual layouts, retained drafts and real navigation. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { waitForAsyncEvidence } from "./support/async-evidence"
import {
  enterModsCreatorChat,
  openModsAdvancedSettings,
  openModsSettings
} from "./support/mods-sidebar-navigation"
import { simpleTourTasks } from "../src/renderer/src/components/customize/simple-tour-tasks"
import { normalizeWorkspacePathKey } from "../src/shared/workspace-path"

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
let failureState
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
    await page.addLocatorHandler(
      page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
      async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    )
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
    await openModsAdvancedSettings(page, "灵件与使用设置")
    const tour = page.getByRole("region", { name: "任务示例演练", exact: true })
    assert.equal(await page.getByRole("button", { name: "任务示例演练", exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "本页任务示例", exact: true }).count(), 0)
    assert.equal(
      (await page.evaluate((id) => window.api.mods.development.status({ threadId: id }), threadId))
        .mode,
      "normal"
    )
    // Enable editing through the real settings UI before creating the retained local draft.
    await openModsSettings(page)
    await page.getByRole("checkbox", { name: "允许使用灵件", exact: true }).click()
    await waitForAsyncEvidence(
      () => page!.evaluate(() => window.api.mods.globalEnabled()),
      (enabled) => enabled,
      "global Mods opt-in persisted",
      20_000
    )
    await page.getByRole("checkbox", { name: "在此项目使用灵件", exact: true }).click()
    await waitForAsyncEvidence(
      () => page!.evaluate((id) => window.api.mods.status(id), threadId),
      (status) => status.enabled,
      "project Mods opt-in persisted",
      20_000
    )
    assert.equal(
      await page.getByRole("button", { name: "任务示例演练", exact: true }).count(),
      0,
      "Enabling Mods alone must not enter creator mode or reveal its manual guide"
    )
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    await enterModsCreatorChat(page, threadId, workspace)
    assert.equal(await page.locator("textarea.composer-textarea").inputValue(), draft)
    assert.deepEqual(await page.evaluate((id) => window.api.threads.getMessages(id), threadId), [])
    assert.equal((await page.evaluate((id) => window.api.mods.flowRuns(id), threadId)).length, 0)
    await openModsAdvancedSettings(page, "灵件与使用设置")
    await page.getByRole("button", { name: "任务示例演练", exact: true }).click()
    await tour.waitFor()
    await page.keyboard.press("Escape")
    checks.push(
      "Ordinary mode and Mods opt-in hide creator guides; the real chat mode switch preserves the draft without messages or runs"
    )
    await openModsAdvancedSettings(page, "搭配管理")
    const simple = page.getByRole("region", { name: "简单组合", exact: true })
    await simple.getByLabel("组合名称", { exact: true }).fill(profileDraft)
    await page.getByRole("button", { name: "任务示例演练", exact: true }).click()
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
        .getByRole("button", { name: "本页任务示例", exact: true })
        .evaluate((node) => node === document.activeElement)
    )
    checks.push(
      "Three tasks × three real rendered previews at desktop and 375px; keyboard progression and Escape preserve combination draft"
    )
    await openModsAdvancedSettings(page, "灵件与使用设置")
    await openModsAdvancedSettings(page, "搭配管理")
    assert.equal(await simple.getByLabel("组合名称", { exact: true }).inputValue(), profileDraft)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1366, 900)
    )
    for (const [task, item] of simpleTourTasks.entries()) {
      await page.getByRole("button", { name: "任务示例演练", exact: true }).click()
      await tour.getByLabel("选择任务", { exact: true }).selectOption(String(task))
      for (const [step, screen] of item.steps.entries()) {
        if (task === 0 && step === 1) await tour.getByLabel("新插件名称").fill("我的导览副本")
        await tour.getByRole("button", { name: screen.action, exact: true }).click()
      }
      if (task < 2) {
        await page
          .getByRole("button", { name: "返回应用", exact: true })
          .waitFor({ state: "detached" })
        const status = await waitForAsyncEvidence(
          () =>
            page!.evaluate(
              (threadId) => window.api.mods.development.status({ threadId }),
              threadId
            ),
          (status) => status.mode === "creator",
          `${item.task} enters creator mode in the original chat`,
          20_000
        )
        assert.equal(status.threadId, threadId)
        assert.equal(
          normalizeWorkspacePathKey(status.workspace),
          normalizeWorkspacePathKey(workspace)
        )
        assert.equal(status.enabled, true)
        await page
          .locator(
            `[data-chat-thread-id="${threadId}"] [data-app-guide="creator"][aria-pressed="true"]`
          )
          .waitFor({ state: "visible" })
      } else {
        await page.getByRole("dialog", { name: "查看改动", exact: true }).waitFor()
      }
      await shot(`handoff-${item.task}`)
      if (task === 2) await page.keyboard.press("Escape")
      const chat = page.locator(`[data-chat-thread-id="${threadId}"]`)
      await chat.waitFor({ state: "visible" })
      assert.equal(await chat.locator("textarea.composer-textarea").inputValue(), draft)
      assert.deepEqual(
        await page.evaluate((id) => window.api.threads.getMessages(id), threadId),
        []
      )
      assert.equal((await page.evaluate((id) => window.api.mods.flowRuns(id), threadId)).length, 0)
      // The icon guide has separate coverage; close its real UI if it auto-opens here.
      const guideClose = page.getByRole("button", { name: "关闭使用指引", exact: true })
      if (await guideClose.isVisible()) await guideClose.click()
      await openModsAdvancedSettings(page, "搭配管理")
      assert.equal(
        await simple.getByLabel("组合名称", { exact: true }).inputValue(),
        profileDraft,
        `${item.task} handoff must preserve the existing unsaved combination on return`
      )
    }
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    assert.equal(await page.locator("textarea.composer-textarea").inputValue(), draft)
    assert.equal((await page.evaluate((id) => window.api.mods.flowRuns(id), threadId)).length, 0)
    assert.equal(await page.evaluate(() => localStorage.getItem("devclaw.sparks-tour.v1")), "seen")
    checks.push(
      "Create and combine return to the original creator chat; diff opens the real dialog; every handoff preserves combination and chat drafts without messages or runs"
    )
    assert.deepEqual(errors, [])
    completed = true
  } catch (error) {
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    failureState = await page
      ?.evaluate(async () => {
        const thread = (await window.api.threads.list()).find(
          (row) => row.title === "三任务导览同包验收"
        )
        const status = thread
          ? await window.api.mods.development.status({ threadId: thread.thread_id })
          : null
        return {
          thread,
          status: status && {
            enabled: status.enabled,
            mode: status.mode,
            workspace: status.workspace
          },
          text: document.body.innerText
        }
      })
      .catch((error) => ({ observationError: String(error) }))
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close().catch((error) => errors.push(String(error)))
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        { completed, checks, errors, previews, packageHash, packageDir, isolated, failureState },
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
