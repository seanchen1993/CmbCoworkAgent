/** Real ZIP upload, paged catalog and original project entry; no model/business execution. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import {
  compositionHostFlow,
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import { openModsSettings } from "./support/mods-sidebar-navigation"
import { readModsSourceCandidate } from "./support/mods-source-candidate"

const root = resolve(__dirname, "..")
const output = join(root, "output", `project-bundle-import-native-${randomUUID()}`)
process.env.COMPOSITION_E2E_ARTIFACT_ROOT = output
const fixture = projectCompositionEnvironment(root)
fixture.env.CMB_MODS_E2E = "0"
const candidate = projectCompositionCandidate(root)
assert(
  candidate.execution === "built-output" || candidate.execution === "source-isolated",
  "Use the current normal build or a verified isolated source candidate"
)
const expectedRendererUrl =
  candidate.execution === "source-isolated"
    ? readModsSourceCandidate(candidate.sourceManifest!).rendererUrl
    : pathToFileURL(join(root, "out/renderer/index.html")).href
fixture.env.ELECTRON_RENDERER_URL = expectedRendererUrl
const suppliedZip = process.env.PROJECT_BUNDLE_ZIP
const inputZip = suppliedZip ?? join(fixture.isolated, "project-template.zip")
if (!suppliedZip) {
  const zip = new AdmZip()
  zip.addLocalFolder(join(root, "resources/native-compositions/autobiz-lean"), "project-template")
  zip.writeZip(inputZip)
}
const inputBytes = readFileSync(inputZip)
const inputSha256 = createHash("sha256").update(inputBytes).digest("hex")
const evidence: Record<string, unknown> = {
  candidate,
  inputZip,
  inputSha256,
  expectedRendererUrl,
  scope:
    "Original built App, real upload and paged catalog, original Plugins/Mods/project form; isolated profile and offline SSO boundary; no installer, external login, model or business execution"
}
const errors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let passed = false
const save = () =>
  writeFileSync(
    join(fixture.isolated, "report.json"),
    JSON.stringify({ ...evidence, passed, errors }, null, 2) + "\n"
  )
const phase = (name: string) => {
  evidence.phase = name
  save()
  console.log(`PHASE project bundle acceptance: ${name}`)
}

async function openPlugins() {
  const sourceList = page!.locator("[data-plugin-source-list]")
  if (await sourceList.isVisible()) return sourceList
  await page!.getByRole("button", { name: "自定义设置", exact: true }).click()
  const group = page!
    .getByRole("navigation")
    .getByRole("button", {
      name: "基础功能",
      exact: true
    })
    .and(page!.locator("button[aria-expanded]"))
  if ((await group.getAttribute("aria-expanded")) === "false") await group.click()
  await page!.getByRole("navigation").getByRole("button", { name: "插件", exact: true }).click()
  await sourceList.waitFor()
  return sourceList
}

async function main() {
  try {
    phase("launch-isolated-app")
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    evidence.pid = app.process().pid
    for (const [name, stream] of [
      ["stdout", app.process().stdout],
      ["stderr", app.process().stderr]
    ] as const)
      stream?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, `main.${name}.log`), bytes)
      )
    page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForURL(expectedRendererUrl, { timeout: 60_000 })
    evidence.actualRendererUrl = page.url()
    page.setDefaultTimeout(25_000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.plugins?.install))
    phase("create-good-and-unavailable-fixture-projects")
    const setup = await page.evaluate(
      async ({ workspace, oldZip, goodZip }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        const thread = await window.api.threads.create({
          title: "项目包导入验收",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const threadId = thread.thread_id
        await window.api.workspace.set(threadId, workspace)
        const install = async (bytes: number[], name: string) => {
          const result = await window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            `${name}.zip`,
            "local"
          )
          if (!result.success) throw Error(result.error)
          const plugin = (await window.api.plugins.list()).find((item) => item.name === name)
          if (!plugin) throw Error("FIXTURE_PLUGIN_MISSING")
          await window.api.plugins.setEnabled(plugin.id, true)
          const prepared = await window.api.plugins.prepareStartUse({
            pluginId: plugin.id,
            threadId,
            expectedWorkspace: workspace,
            expected: { name: plugin.name, version: plugin.version }
          })
          if (prepared.kind !== "host-project") throw Error("REAL_NATIVE_PROJECT_REQUIRED")
          return { plugin, prepared }
        }
        const create = async (
          source: Awaited<ReturnType<typeof install>>,
          name: string,
          code: string
        ) =>
          window.api.harnessBoard.createProject({
            adapterId: source.plugin.id,
            adapterType: "plugin",
            name,
            projectCode: code,
            projectFromLean: false,
            projectDir: code.toLowerCase(),
            description: "Isolated container only; no feature or business run",
            systemId: "fixture",
            systemName: "Fixture",
            workspacePath: workspace,
            expectedNativeTemplate: source.prepared.identity
          })
        const old = await install(oldZip, "composition-host-fixture")
        const unavailable = await create(old, "旧插件已移除的项目", "MISSING_PLUGIN_OLD")
        const removed = await window.api.plugins.delete(old.plugin.id)
        if (!removed.success) throw Error(removed.error)
        const good = await install(goodZip, "composition-reader-fixture")
        const available = await create(good, "正常的独立项目", "HEALTHY_PROJECT")
        return { threadId, unavailable, available, goodPluginId: good.plugin.id }
      },
      {
        workspace: fixture.workspace,
        oldZip: compositionHostFlow(),
        goodZip: compositionHostFlow(true)
      }
    )
    evidence.setup = setup
    phase("upload-original-zip")
    await page.reload()
    await page.getByText("项目包导入验收", { exact: true }).first().click()
    const sourceList = await openPlugins()
    await sourceList.getByRole("button", { name: /composition-reader-fixture/ }).waitFor()
    // Select the header action, independently of the initial empty/loading state.
    await sourceList
      .locator(":scope > div")
      .first()
      .locator("button")
      .filter({ has: page.locator("svg.lucide-plus") })
      .click()
    const upload = page.getByRole("dialog", { name: "安装 Plugin", exact: true })
    await upload.locator("input[type=file]").setInputFiles(inputZip)
    await upload.waitFor({ state: "hidden", timeout: 60_000 })

    const catalog = await page.evaluate(async () => {
      const plugins = [] as Awaited<ReturnType<typeof window.api.plugins.list>>
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await window.api.skills.catalog.read(
          {
            kind: "plugins",
            limit: 2,
            revision: "real-bundle-import-acceptance",
            ...(cursor ? { cursor } : {})
          },
          "real-bundle-import-acceptance"
        )
        plugins.push(...page.plugins)
        cursor = page.cursor ?? undefined
        pages++
        if (pages > 20) throw Error("UNEXPECTED_CATALOG_PAGE_COUNT")
      } while (cursor)
      return { plugins, pages }
    })
    const mainPlugins = catalog.plugins.filter(
      (plugin) => (plugin.projectDependencyIds?.length ?? 0) === 3
    )
    assert.equal(
      mainPlugins.length,
      1,
      "The real paged catalog must identify exactly one uploaded project"
    )
    const main = mainPlugins[0]
    assert.equal(
      catalog.plugins.length,
      5,
      "Four bundle identities and one independent fixture remain installed"
    )
    assert(catalog.pages >= 3, "The acceptance must cross real catalog page boundaries")
    const dependencies = main.projectDependencyIds!.map(
      (id) => catalog.plugins.find((plugin) => plugin.id === id)!
    )
    assert(dependencies.every(Boolean))
    evidence.catalog = catalog
    phase("verify-paged-plugin-grouping")
    const assertPluginGrouping = async () => {
      const list = page!.locator("[data-plugin-source-list]")
      await list
        .getByRole("button", { name: new RegExp(main.name) })
        .first()
        .waitFor()
      const group = list.getByLabel(`${main.name}的依赖组件`, { exact: true })
      assert.equal(await group.count(), 1)
      assert.equal(await group.getAttribute("open"), null)
      for (const child of dependencies)
        assert.equal(await list.getByRole("button", { name: child.name, exact: true }).count(), 0)
      await group.locator("summary").click()
      for (const child of dependencies)
        await group.getByRole("button", { name: child.name, exact: true }).waitFor()
      await group.locator("summary").click()
      return list
    }
    await assertPluginGrouping()
    await page.screenshot({
      path: join(fixture.isolated, "plugins-one-project-collapsed.png"),
      animations: "disabled"
    })
    await page.reload()
    await page.getByText("项目包导入验收", { exact: true }).first().click()
    await openPlugins()
    await assertPluginGrouping()

    phase("open-original-project-form-from-mods")
    await openModsSettings(page)
    const installed = page.getByRole("region", { name: "已安装插件", exact: true })
    const rootCard = installed.locator(`[data-installed-mod-id="${main.id}"]`)
    await rootCard.getByRole("heading", { name: main.name, exact: true }).waitFor()
    assert.equal(await installed.locator(":scope > article").count(), 2)
    for (const child of dependencies)
      assert.equal(
        await installed.locator(`[data-installed-mod-id="${child.id}"]`).isVisible(),
        false
      )
    await rootCard.getByRole("button", { name: /^(开始使用|去使用)$/ }).click()
    const dialog = page.getByRole("dialog", { name: "新建项目", exact: true })
    await dialog.waitFor()
    await dialog.getByRole("textbox", { name: "项目名称 *", exact: true }).waitFor()
    for (const name of ["项目编号 *", "系统编号 *", "系统名称 *", "插件配置"])
      await dialog.getByText(name, { exact: true }).waitFor()
    for (const field of [
      dialog.getByPlaceholder("输入项目编号搜索", { exact: true }),
      dialog.getByRole("textbox", { name: "项目名称 *", exact: true }),
      dialog.getByRole("textbox", { name: "系统编号 *", exact: true }),
      dialog.getByRole("textbox", { name: "系统名称 *", exact: true })
    ]) {
      assert(await field.isEnabled())
      assert(await field.isEditable())
    }
    assert.equal(await page.getByRole("dialog", { includeHidden: true }).count(), 1)
    evidence.originalProjectForm = {
      accessible: true,
      openDialogCount: 1,
      originalProjectFields: true
    }
    assert.equal(await page.getByText("PROJECT_PLUGIN_UNAVAILABLE", { exact: false }).count(), 0)
    await page.screenshot({
      path: join(fixture.isolated, "original-project-form.png"),
      animations: "disabled"
    })
    const details = await page.evaluate(async ({ unavailable, available }) => {
      const batch = await window.api.harnessBoard.getProjectDetails(
        [unavailable.projectId, available.projectId],
        { watchRefs: false }
      )
      return { unavailable: batch[unavailable.projectId], available: batch[available.projectId] }
    }, setup)
    assert(details.unavailable.error)
    assert.equal(details.unavailable.projectState?.uiKind, "warning")
    assert.equal(details.available.error, null)
    assert(!JSON.stringify(details).includes("PROJECT_PLUGIN_UNAVAILABLE"))
    const messages = await page.evaluate(
      (threadId) => window.api.threads.getMessages(threadId),
      setup.threadId
    )
    assert.equal(messages.length, 0, "Opening the project form must not send a chat or run a model")
    assert.deepEqual(errors, [])
    assert.equal(createHash("sha256").update(readFileSync(inputZip)).digest("hex"), inputSha256)
    assert.equal(projectCompositionCandidate(root).sha256, candidate.sha256)
    evidence.details = details
    evidence.messages = messages
    evidence.inputZipUnchanged = true
    phase("complete")
    passed = true
    console.log(`PASS real project bundle import and original entry: ${fixture.isolated}`)
  } catch (error) {
    evidence.failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
    if (page && !page.isClosed()) {
      evidence.dialogs = await page
        .locator('[role="dialog"]')
        .evaluateAll((dialogs) =>
          dialogs.map((dialog) => ({
            label: dialog.getAttribute("aria-label"),
            title: dialog.querySelector("h2")?.textContent,
            hidden: dialog.getAttribute("aria-hidden"),
            ancestorHidden: dialog.parentElement?.closest('[aria-hidden="true"]')?.tagName,
            display: getComputedStyle(dialog).display
          }))
        )
        .catch(() => undefined)
      await page.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => undefined)
    }
    throw error
  } finally {
    save()
    if (app) await app.close()
  }
}

export const projectBundleImportAcceptance = main().catch((error) => {
  console.error(error)
  process.exitCode = 1
  throw error
})
