/** Real packaged UI, preload, permissions and two independent QuickJS guests. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { compositionEnvironment, compositionPlugin } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { startFlowModel } from "./support/mods-flow-model"

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR, "Explicit newly built package required")
const packageDir = resolve(process.env.CMB_MODS_PACKAGED_DIR)
const asar = join(packageDir, "resources", "app.asar")
const hash = () => createHash("sha256").update(readFileSync(asar)).digest("hex")
const packageHash = hash()
const artifacts = join(
  root,
  "output/simple-authoring-20261013",
  `composition-packaged-${Date.now()}`
)
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const names = ["composition-a", "composition-b"] as const
const goal = "检查这个文件是否存在问题，并说明依据。"
const title = "简单组合真实界面验收"
const historyCount = 80
const checks: string[] = []
const errors: string[] = []
const evidence: Record<string, unknown> = { packageDir, packageHash, isolated, workspace }
let app: ElectronApplication | undefined
let page: Page | undefined
let threadId = ""
let completed = false

// Tighten only the fixtures' declared schemas: retain the original independent guest code.
for (const name of names) {
  const zip = new AdmZip(Buffer.from(compositionPlugin(name)))
  const manifest = JSON.parse(zip.readAsText("plugin.json"))
  manifest.claw.actions[0].outputSchema = {
    type: "object",
    properties: { nonce: { type: "string" }, owner: { type: "string" } },
    required: ["nonce", "owner"]
  }
  zip.updateFile("plugin.json", Buffer.from(JSON.stringify(manifest)))
  zip.writeZip(join(artifacts, `${name}.zip`))
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const result = await read()
    if (accept(result)) return result
    await new Promise((done) => setTimeout(done, 150))
  }
  throw Error(`Timeout: ${label}`)
}
const view = () => page!.evaluate((id) => window.api.mods.clawView(id), threadId)
const runs = () => page!.evaluate((id) => window.api.mods.flowRuns(id), threadId)
async function screenshot(name: string) {
  await page!.screenshot({ path: join(artifacts, `${name}.png`) })
}
function pass(message: string) {
  checks.push(message)
  console.log("PASS " + message)
}

async function main() {
  const model = await startFlowModel(workspace)
  const watchdog = setTimeout(() => {
    errors.push("360 second watchdog expired")
    void app?.close().catch((error) => errors.push(String(error)))
  }, 360_000)
  try {
    app = await launch(60_000)
    page = await app.firstWindow()
    page.setDefaultTimeout(20_000)
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("dialog", async (dialog) => {
      errors.push(`Unexpected dialog: ${dialog.message()}`)
      await dialog.dismiss()
    })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1366, 900)
    )
    await page.addInitScript("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.clawView))
    // Initialization only. All feature mutations below use the actual page controls.
    threadId = await page.evaluate(
      async ({ workspace, title, url, historyCount }) => {
        await window.api.models.setCustomConfig({
          id: "simple-local",
          name: "simple-local",
          baseUrl: url,
          model: "simple-local",
          apiKey: "isolated-local-fixture",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:simple-local")
        const row = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (row as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, workspace)
        const historical = Array.from({ length: historyCount }, (_, index) => ({
          id: `composition-history-${index}`,
          role: index % 2 ? "assistant" as const : "user" as const,
          content: `Historical message ${index}\n\n` +
            "Actual persisted **history** for the packaged virtual list.\n\n".repeat(6)
        }))
        const appended = await window.api.threads.appendMessages(id, historical)
        if (appended.count !== historyCount) throw Error("COMPOSITION_HISTORY_SETUP_FAILED")
        return id
      },
      { workspace, title, url: model.url, historyCount }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    const skip = page.getByRole("button", { name: "跳过导览", exact: true })
    if (await skip.isVisible()) await skip.click()
    await page
      .getByRole("navigation")
      .filter({ has: page.getByRole("button", { name: "基础功能", exact: true }) })
      .getByRole("button", { name: "插件", exact: true })
      .click()
    if (await skip.isVisible()) await skip.click()
    await page.getByRole("button", { name: "我已添加", exact: true }).click()
    const mods = page.locator("[data-mods-settings]")
    await mods.locator("[data-plugin-import-controls] > summary").click()
    for (const name of names) {
      await until(
        () => mods.getByLabel("选择插件 ZIP 文件", { exact: true }).isEnabled(),
        Boolean,
        "upload ready"
      )
      await mods
        .getByLabel("选择插件 ZIP 文件", { exact: true })
        .setInputFiles(join(artifacts, `${name}.zip`))
      await until(
        () => page!.evaluate(() => window.api.plugins.list()),
        (items) => items.some((item) => item.name === name),
        `install ${name}`
      )
    }
    await mods.locator("[data-mods-more-settings] > summary").click()
    await mods.getByRole("checkbox", { name: "允许使用灵件", exact: true }).click()
    await until(
      () => page!.evaluate(() => window.api.mods.globalEnabled()),
      Boolean,
      "global enable"
    )
    await mods.getByRole("checkbox", { name: "在此项目使用灵件", exact: true }).click()
    await until(
      () => page!.evaluate((id) => window.api.mods.status(id), threadId),
      (s) => s.enabled,
      "project enable"
    )
    for (const name of names) {
      await mods
        .getByRole("article", { name, exact: true })
        .getByRole("button", { name: "管理", exact: true })
        .click()
      const card = mods.locator(`[data-function-mod-id="${name}"]`)
      await card.getByText("权限与版本详情", { exact: true }).click()
      await card.getByRole("button", { name: "授权以上能力", exact: true }).click()
      await until(
        () => page!.evaluate((id) => window.api.mods.status(id), threadId),
        (s) => s.functionMods?.find((item) => item.name === name)?.state === "ready",
        `grant ${name}`
      )
    }
    pass("Both independent guests installed and authorized through UI")
    await page.getByRole("button", { name: "常用搭配", exact: true }).click()
    const simple = page.getByRole("region", { name: "简单组合", exact: true })
    await simple.getByLabel("组合名称", { exact: true }).fill("两个插件先后处理")
    for (const name of names) await simple.getByRole("checkbox", { name, exact: true }).check()
    await simple.getByRole("button", { name: /先后执行/ }).click()
    const catalog = await page.evaluate((id) => window.api.mods.flowCatalog(id), threadId)
    for (const [index, name] of names.entries()) {
      if (index > 0) await simple.getByRole("button", { name: "添加步骤", exact: true }).click()
      const action = catalog.actions?.find((item) => item.plugin === name)
      assert(action)
      await simple
        .getByLabel(`步骤${index + 1}动作`, { exact: true })
        .selectOption(`${action.pluginId}:${action.actionId}`)
    }
    await simple
      .getByLabel("步骤2输入来源", { exact: true })
      .selectOption(JSON.stringify(["step-1", ""]))
    await simple.getByLabel("步骤1输入 · nonce", { exact: true }).fill(goal)
    await screenshot("01-two-actions")
    await simple.getByRole("button", { name: "保存并核对应用", exact: true }).click()
    const preview = simple.getByRole("region", { name: "简单组合应用预览", exact: true })
    await preview.waitFor()
    assert.equal((await view()).active, null)
    assert.equal((await runs()).length, 0)
    await preview.getByRole("button", { name: "确认应用", exact: true }).click()
    const applied = await until(view, (v) => !!v.active, "apply")
    evidence.applied = applied
    assert.equal(applied.active?.capabilities.length, 2)
    assert.equal((await runs()).length, 0)
    assert.equal(model.requests.length, 0)
    await screenshot("02-applied")
    pass("Save and apply preserve zero executions and zero provider requests")
    await simple.getByRole("button", { name: "去这段聊天使用", exact: true }).click()
    await page.getByRole("button", { name: "按此步骤执行", exact: true }).waitFor()
    await page.locator("[data-virtuoso-scroller]").waitFor()
    const scroller = await page.locator("[data-virtuoso-scroller]").elementHandle()
    assert(scroller)
    assert.equal(await page.locator("textarea.composer-textarea").count(), 1)
    assert.equal(await page.locator("textarea.composer-textarea").inputValue(), "")
    await page.locator("textarea.composer-textarea").fill(goal)
    assert.equal((await runs()).length, 0)
    await screenshot("03-first-task")
    await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
    const finished = await until(
      runs,
      (items) => items.some((run) => ["complete", "failed", "cancelled"].includes(run.status)),
      "ordered run"
    )
    assert.equal(finished.length, 1)
    const run = finished[0]
    evidence.run = run
    assert.equal(run.status, "complete", JSON.stringify(run))
    assert.equal(run.taskGoal, goal)
    const actions = run.attempts.filter((attempt) => attempt.result?.source === "plugin-action")
    assert.equal(actions.length, 2)
    assert.deepEqual(
      actions.map((a) => a.status),
      ["passed", "passed"]
    )
    assert.deepEqual(
      actions.map((a) => a.result?.output?.owner),
      names
    )
    assert.equal(actions[1].result?.output?.receivedFrom, names[0])
    assert(actions[0].finishedAt! <= actions[1].startedAt)
    assert(run.attempts.every((attempt) => attempt.status === "passed"))
    assert(
      run.attempts
        .filter((attempt) => attempt.result?.source !== "plugin-action")
        .every((attempt) => attempt.stepId === "__final" && attempt.result?.source === "host")
    )
    assert.equal(model.requests.length, 0)
    const task = page.locator(`[data-chat-task-id="${run.id}"]`)
    await task.waitFor()
    assert(await task.evaluate((node) => !!node.closest("[data-virtuoso-scroller]")))
    assert(await scroller.evaluate((node) => node === document.querySelector("[data-virtuoso-scroller]")))
    const messages = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    assert.equal(messages.length, historyCount, "Task state must not append synthetic messages")
    evidence.history = { count: messages.length, taskInsideVirtuoso: true, scrollerRetained: true }
    assert.deepEqual(errors, [])
    await screenshot("04-ordered-results")
    pass("Explicit send executes two real guest actions in order with upstream output")
    pass("Actual Virtuoso retains its scroller and renders the native run card without appending messages")
    completed = true
  } catch (error) {
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close().catch((error) => errors.push(String(error)))
    await model.close()
    assert.equal(hash(), packageHash, "Package changed during acceptance")
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify({ completed, checks, errors, evidence }, null, 2)
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
