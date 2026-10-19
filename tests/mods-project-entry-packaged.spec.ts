/** Real final ASAR: fixed/custom project entry, dependency preview, feature and stage overview. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Explicit final ASAR required")
const argument = (name: string) => {
  const at = process.argv.indexOf(name)
  assert(at >= 0 && process.argv[at + 1], `Explicit ${name} ZIP required`)
  return resolve(process.argv[at + 1])
}
const fixedPath = argument("--fixed")
const customPath = argument("--custom")
const projectStepsOnly = process.argv.includes("--project-steps-only")
const candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root)
const expected = ["biz.prd", "dev.specs", "warehouse.model", "warehouse.sql", "warehouse.quality"]
const rows: Array<Record<string, unknown>> = []
let app: ElectronApplication | undefined
let page: Page | undefined
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

async function snapshot(name: string) {
  assert(page)
  writeFileSync(join(fixture.isolated, `${name}.txt`), await page.locator("body").innerText())
  await page.screenshot({ path: join(fixture.isolated, `${name}.png`), animations: "disabled", timeout: 4000 })
}

async function settings() {
  assert(page)
  // Bootstrap the persisted real threads and production store, then use its normal navigation.
  await page.reload()
  await page.getByText("对话模式", { exact: true }).first().click()
  await page.getByText("Mods entry acceptance chat", { exact: true }).first().click()
  await page.getByRole("button", { name: "自定义设置", exact: true }).click()
  await page.getByRole("button", { name: "常用搭配", exact: true }).click()
  await page.getByRole("button", { name: "配置聊天搭配", exact: true }).waitFor()
}

async function main() {
  const watchdog = setTimeout(() => void app?.close(), 300000)
  console.log(`Project entry isolated profile: ${fixture.isolated}`)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, { unobtrusivePresentation: true })()
    app.process().stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app.process().stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await page.waitForFunction(() => Boolean(window.api?.nodeComposition))
    const installed: Array<{ pluginId: string; name: string; projectId: string; projectRoot: string; catalog: Awaited<ReturnType<typeof window.api.nodeComposition.catalog>> }> = []
    for (const [index, path] of [fixedPath, customPath].entries()) {
      const bytes = readFileSync(path)
      const zip = new AdmZip(bytes)
      const metadata = JSON.parse(zip.readAsText("plugin.json"))
      const result = await page.evaluate(({ bytes, filename }) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, filename, "local"),
      { bytes: [...bytes], filename: basename(path) })
      assert(result.success, result.error)
      const plugin = (await page.evaluate(() => window.api.plugins.list())).find((item) => item.name === metadata.name)
      assert(plugin)
      await page.evaluate((id) => window.api.plugins.setEnabled(id, true), plugin.id)
      const project = await page.evaluate(({ pluginId, workspace, index }) =>
        window.api.harnessBoard.createProject({
          adapterId: pluginId, adapterType: "plugin", name: index ? "UI自选九步项目" : "UI固定八步项目",
          projectCode: `ENTRY${index}`, projectFromLean: false, projectDir: `entry-project-${index}`,
          description: "Isolated real UI acceptance", systemId: "fixture", systemName: "Fixture",
          workspacePath: workspace
        }), { pluginId: plugin.id, workspace: fixture.workspace, index })
      const projectRoot = join(fixture.workspace, `entry-project-${index}`)
      installed.push({ pluginId: plugin.id, name: plugin.name, projectId: project.projectId, projectRoot,
        catalog: undefined as never })
      rows.push({ path, zipSha256: createHash("sha256").update(bytes).digest("hex"), pluginId: plugin.id,
        name: metadata.name, projectId: project.projectId, projectRoot })
    }
    const threadId = await page.evaluate(async (workspace) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      const thread = await window.api.threads.create({
        title: "Mods entry acceptance chat", workspacePath: workspace, agentMode: "normal"
      })
      await window.api.workspace.set(thread.thread_id, workspace)
      await window.api.mods.configureGlobal(true)
      const status = await window.api.mods.status(thread.thread_id)
      await window.api.mods.configure(thread.thread_id, true, status.outputPolicy, status.workspace)
      return thread.thread_id
    }, fixture.workspace)
    const scope = { threadId, expectedWorkspace: fixture.workspace }
    for (const item of installed) item.catalog = await page.evaluate((input) => window.api.nodeComposition.catalog(input), { ...scope, projectId: item.projectId })
    const [fixed, custom] = installed
    assert.equal(fixed.catalog.config.templates.some((item) => item.templateType === "custom"), false)
    assert.equal(fixed.catalog.nodes.length, 8)
    assert(custom.catalog.config.templates.some((item) => item.templateType === "custom"))
    assert.equal(custom.catalog.nodes.length, 9)

    await settings()
    await page.getByLabel("组合名称", { exact: true }).fill("保留真实聊天搭配草稿")
    await page.getByRole("button", { name: "从 Mods 组装新插件", exact: true }).click()
    await page.getByRole("heading", { name: "从业务 Mods 组装新插件", exact: true }).waitFor()
    await snapshot("01-goal-real-assembly")
    await page.getByRole("button", { name: "配置聊天搭配", exact: true }).click()
    assert.equal(await page.getByLabel("组合名称", { exact: true }).inputValue(), "保留真实聊天搭配草稿")
    const fixedCard = page.getByRole("article", { name: fixed.name, exact: true })
    await fixedCard.getByRole("button", { name: "查看项目流程", exact: true }).click()
    await page.getByLabel("选择节点所属项目").selectOption(fixed.projectId)
    const nodes = page.getByLabel("项目节点组合", { exact: true })
    await nodes.getByRole("button", { name: "在原项目中使用", exact: true }).waitFor()
    assert.equal(await nodes.getByRole("checkbox").count(), 0)
    assert.equal(await nodes.getByRole("alert").count(), 0)
    for (const node of fixed.catalog.nodes) await nodes.getByText(node.label, { exact: true }).waitFor()
    await snapshot("02-fixed-eight-steps")
    await nodes.getByRole("button", { name: "在原项目中使用", exact: true }).click()
    // A clean profile shows the real first-use project guide above the project detail.
    const projectGuide = page.getByRole("button", { name: "知道了，不再提示", exact: true })
    await projectGuide.waitFor({ state: "visible", timeout: 5000 }).catch(() => {})
    if (await projectGuide.isVisible()) await projectGuide.click()
    await page.getByRole("heading", { name: "UI固定八步项目", exact: true }).waitFor()
    await page.getByRole("button", { name: "打开项目工作区", exact: true }).waitFor()
    assert.equal(await page.getByRole("region", { name: "为新插件创建项目", exact: true }).count(), 0)
    await snapshot("03-exact-fixed-project")

    await settings()
    const customCard = page.getByRole("article", { name: custom.name, exact: true })
    if (!projectStepsOnly) {
      await customCard.getByRole("button", { name: "用这些 Mods 组装新插件", exact: true }).click()
      await page.getByRole("heading", { name: "从业务 Mods 组装新插件", exact: true }).waitFor()
      await page.getByLabel("已安装的 Mods 来源").locator(`option[value="${custom.pluginId}"]`).waitFor({ state: "attached" })
      assert.equal(await page.getByLabel("已安装的 Mods 来源").inputValue(), custom.pluginId)
      await snapshot("04-card-assembly-source")
      await page.getByRole("button", { name: "配置聊天搭配", exact: true }).click()
    }
    await customCard.getByRole("button", { name: "查看项目流程", exact: true }).click()
    await page.getByLabel("选择节点所属项目").selectOption(custom.projectId)
    const quality = custom.catalog.nodes.find((item) => item.id === "warehouse.quality")!
    assert(quality)
    await nodes.getByRole("checkbox", { name: new RegExp(quality.label) }).check()
    await nodes.getByRole("checkbox", { name: "自动加入可选输入的上游步骤", exact: true }).uncheck()
    await nodes.getByRole("button", { name: "检查并预览步骤", exact: true }).click()
    const preview = page.getByLabel("节点组合预览", { exact: true })
    await preview.waitFor()
    const labels = expected.map((id) => custom.catalog.nodes.find((item) => item.id === id)!.label)
    const orderedText = await preview.locator("ol > li").allTextContents()
    assert.equal(orderedText.length, 5)
    for (const [index, label] of labels.entries()) assert(orderedText[index].includes(label))
    await snapshot("05-real-five-step-closure")

    // Only the user's native folder selection is supplied; all IPC/closure/create/store is product code.
    await app.evaluate(({ dialog }, projectRoot) => {
      const original = dialog.showOpenDialog.bind(dialog)
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { properties?: string[] }
        if (!options.properties?.includes("openDirectory")) return Reflect.apply(original, dialog, args)
        return { canceled: false, filePaths: [projectRoot] }
      }) as typeof dialog.showOpenDialog
    }, custom.projectRoot)
    await preview.getByRole("button", { name: "在项目里创建需求", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "创建特性", exact: true })
    await dialog.waitFor()
    await dialog.getByPlaceholder("请输入特性名称", { exact: true }).fill("ui-five-step-quality")
    await dialog.getByLabel("会话工作区", { exact: true }).click()
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await dialog.getByLabel("会话工作区", { exact: true }).inputValue()).includes("entry-project-1")) break
      await pause(100)
    }
    assert((await dialog.getByLabel("会话工作区", { exact: true }).inputValue()).includes("entry-project-1"))
    await snapshot("06-original-create-dialog")
    await dialog.getByRole("button", { name: "创建", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    const overview = page.getByLabel("流程节点概览", { exact: true })
    await overview.waitFor()
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await overview.locator("[data-stage-node]").count() === 5) break
      await pause(100)
    }
    const actualIds = await overview.locator("[data-stage-node]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-stage-node")))
    assert.deepEqual(actualIds, expected)
    for (const id of expected) assert(await overview.locator(`[data-stage-node="${id}"]`).isVisible())
    await overview.scrollIntoViewIfNeeded()
    await snapshot("07-five-visible-stage-overview")
    const qualityCard = overview.locator('[data-stage-node="warehouse.quality"]')
    await qualityCard.locator(":scope > button").click()
    assert.equal(await qualityCard.locator(":scope > button").getAttribute("aria-pressed"), "true")
    assert((await page.locator("body").innerText()).includes(`正在查看：${quality.label}`))
    await snapshot("08-quality-stage-detail")
    const state = JSON.parse(readFileSync(join(custom.projectRoot, ".autobizdevops/state.json"), "utf8"))
    assert.deepEqual(state.features["ui-five-step-quality"].workflowNodes, expected)
    assert.equal(state.features["ui-five-step-quality"].workflowTemplate, "custom")
    const report = { candidate, isolated: fixture.isolated, scope, installed: rows, expected, actualIds,
      assemblySourcePreselectionVerified: !projectStepsOnly,
      state: state.features["ui-five-step-quality"],
      limits: "Real installed old fixed and new custom packages, original project initialization, real renderer navigation/closure/feature creation and stage detail. Native folder picker selects only the isolated project root. No model/workflow execution or user data changes."
    }
    const output = join(root, "output/demo-readiness-20261016")
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, `mods-project-entry-packaged${projectStepsOnly ? ".steps-only" : ""}.json`), JSON.stringify(report, null, 2))
    writeFileSync(join(fixture.isolated, "evidence.json"), JSON.stringify(report, null, 2))
    console.log(`PASS packaged ${projectStepsOnly ? "project steps only" : "full fixed/custom entry"} and real five-step feature UI: ${fixture.isolated}`)
  } catch (error) {
    writeFileSync(join(fixture.isolated, "failure.json"), JSON.stringify({ candidate, rows, error: String(error) }, null, 2))
    if (page) await snapshot("failure").catch(() => {})
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
