/** Production Electron/React/IPC: settings password, uninstall and restart, no external model. */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { _electron, type ElectronApplication, type Page } from "playwright"
import AdmZip from "adm-zip"
import { verifyApplicationCompletionSettings } from "./support/mods-application-policy-e2e"

const root = resolve(__dirname, "..")
const localRequire = createRequire(join(root, "package.json"))
const packagedDir = process.env.CMB_MODS_PACKAGED_DIR
const binary = packagedDir
  ? join(resolve(packagedDir), "CMBDevClaw.exe")
  : (localRequire("electron") as string)
const isolated = mkdtempSync(join(tmpdir(), "cmb-mods-settings-e2e-"))
const artifacts = join(root, "output/mods-validation", "settings-e2e")
mkdirSync(artifacts, { recursive: true })
const workspace = join(isolated, "workspace")
mkdirSync(workspace)
writeFileSync(
  join(workspace, "package.json"),
  JSON.stringify({ scripts: { test: "node verify.cjs" } })
)
writeFileSync(
  join(workspace, "verify.cjs"),
  'require("fs").appendFileSync("verified.txt", "once\\n"); console.log("PROJECT_VERIFIED")'
)
writeFileSync(join(workspace, "secret.txt"), "sk-private-fixture-123456789")
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (
    value &&
    /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i.test(
      key
    )
  )
    env[key] = value
}
for (const [key, folder] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  APPDATA: "appdata",
  LOCALAPPDATA: "localappdata",
  CMB_COWORK_AGENT_HOME: "data",
  TEMP: "temp",
  TMP: "temp"
})) {
  env[key] = join(isolated, folder)
  mkdirSync(env[key], { recursive: true })
}
Object.assign(env, {
  CMB_E2E_DISABLE_GPU: "1",
  CMB_E2E_ELECTRON_BIN: binary,
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost"
})

const checks: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
function pass(name: string) {
  checks.push(name)
  console.log("PASS " + name)
}
async function boot() {
  app = await _electron.launch({
    executablePath: join(root, "tests/support/electron-launcher.cmd"),
    args: [
      ...(packagedDir ? [] : [join(root, "out/main/index.js")]),
      "--user-data-dir=" + join(isolated, "electron")
    ],
    cwd: root,
    env,
    timeout: 60000
  })
  await app.firstWindow()
  if (packagedDir) {
    const identity = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      path: app.getAppPath(),
      argv: process.argv
    }))
    assert.equal(identity.packaged, true)
    assert(identity.path.endsWith("app.asar"))
    assert(!identity.argv.some((argument) => /out[\\/]main[\\/]index\.js$/.test(argument)))
  }
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("open-login-page")
    ipcMain.handle("open-login-page", () => undefined)
  })
  page = app.windows()[0]
  await page.waitForFunction(() => Boolean(window.api?.mods))
  await page.getByRole("button", { name: "自定义", exact: true }).click()
  await page.getByRole("button", { name: "Function Mods", exact: true }).click()
  await page.locator("[data-mods-settings]").waitFor()
}
async function main() {
  const watchdog = setTimeout(() => {
    void app?.close()
  }, 90000)
  try {
    await boot()
    assert.equal(await page!.evaluate(() => window.api.mods.globalEnabled()), false)
    assert.equal(await page!.evaluate(() => window.api.mods.functionUnlocked()), false)
    assert(await page!.getByRole("checkbox", { name: "启用 Mods 功能（应用级）" }).isDisabled())
    assert(await page!.getByRole("button", { name: "安装示范 Mods" }).isDisabled())
    assert(await page!.getByRole("button", { name: "上传 Mods（ZIP）" }).isDisabled())
    assert(await page!.getByRole("button", { name: "从文件夹安装" }).isDisabled())
    assert.equal(await page!.locator("[data-installed-mods]").count(), 0)
    await page!.screenshot({ path: join(artifacts, "locked.png") })
    await assert.rejects(
      page!.evaluate(() => window.api.mods.configureGlobal(true)),
      /MODS_FUNCTION_LOCKED/
    )
    await assert.rejects(
      page!.evaluate(() => window.api.mods.installExamples()),
      /MODS_FUNCTION_LOCKED/
    )
    await page!.getByLabel("输入管理口令解锁 Function Mods 设置").fill("wrong")
    await page!.getByRole("button", { name: "解锁设置" }).click()
    await page!.getByText("管理口令错误，请重试。", { exact: true }).waitFor()
    assert.equal(await page!.evaluate(() => window.api.mods.functionUnlocked()), false)
    pass("locked UI, wrong password and direct IPC cannot enable or install Mods")
    await page!.getByLabel("输入管理口令解锁 Function Mods 设置").fill("admin123456")
    await page!.getByRole("button", { name: "解锁设置" }).click()
    await page!.locator("[data-installed-mods]").waitFor()
    assert.equal(await page!.evaluate(() => window.api.mods.globalEnabled()), false)
    const getPlugins = () => page!.evaluate(() => window.api.plugins.list())
    const input = page!.getByLabel("选择 Mods ZIP 文件")
    await input.setInputFiles({
      name: "broken.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("broken")
    })
    await page!.getByRole("alert").waitFor()
    assert.equal((await getPlugins()).length, 0)
    const ordinary = new AdmZip()
    ordinary.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "ordinary-skill" })))
    ordinary.addFile("skills/sample/SKILL.md", Buffer.from("# Sample"))
    await input.setInputFiles({
      name: "ordinary.zip",
      mimeType: "application/zip",
      buffer: ordinary.toBuffer()
    })
    await page!
      .getByText("未检测到 Mods 模块，请选择包含 Mods 的插件包。普通插件请在“插件”页面安装。", {
        exact: true
      })
      .waitFor()
    assert.equal((await getPlugins()).length, 0)
    const zip = new AdmZip()
    zip.addLocalFolder(join(root, "resources/mods/function-commands"))
    const upload = {
      name: "function-commands.zip",
      mimeType: "application/zip",
      buffer: zip.toBuffer()
    }
    await input.setInputFiles(upload)
    await page!.getByRole("status").waitFor()
    const first = (await getPlugins())[0]
    assert(first && first.name === "function-commands")
    await input.setInputFiles(upload)
    await page!.getByRole("status").waitFor()
    assert.equal((await getPlugins()).length, 1)
    assert.equal((await getPlugins())[0].id, first.id)
    pass(
      "ZIP upload rejects corrupt/non-Mod packages, installs and updates a Mod without duplicates"
    )
    await app!.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({
        canceled: true,
        filePaths: []
      })) as typeof dialog.showOpenDialog
    })
    await page!.getByRole("button", { name: "从文件夹安装" }).click()
    await page!.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "从文件夹安装"
      )
      return button && !button.disabled
    })
    assert.equal((await getPlugins()).length, 1)
    await app!.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [path]
        })) as typeof dialog.showOpenDialog
      },
      join(root, "resources/mods/project-quality")
    )
    await page!.getByRole("button", { name: "从文件夹安装" }).click()
    await page!.getByRole("status").waitFor()
    assert.equal((await getPlugins()).length, 2)
    assert.equal(await page!.evaluate(() => window.api.mods.globalEnabled()), false)
    await page!.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "从文件夹安装"
      )
      return button && !button.disabled
    })
    assert.equal(await page!.getByRole("alert").count(), 0)
    await page!.screenshot({ path: join(artifacts, "upload-installed.png") })
    pass("folder installation and cancel work while Mods remain off")
    await page!.locator("[data-installed-mod-id]").first().waitFor()
    const plugins = await getPlugins()
    const plugin = plugins.find((p) => p.name === "function-commands")!
    assert(plugin)
    const row = page!.locator('[data-installed-mod-id="' + plugin.id + '"]')
    await row.getByRole("button", { name: "卸载", exact: true }).click()
    const dialog = page!.getByRole("dialog")
    await dialog.getByRole("button", { name: "取消", exact: true }).click()
    assert((await getPlugins()).some((p) => p.id === plugin.id))
    pass(
      "unlock does not enable runtime; installed Mods and cancel uninstall work without a project"
    )
    const threadId = await page!.evaluate(async (workspace) => {
      const t = await window.api.threads.create({
        title: "Mods settings E2E",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id = (t as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, workspace)
      return id
    }, workspace)
    await page!.getByRole("checkbox", { name: "启用 Mods 功能（应用级）" }).check()
    const status = await page!.evaluate((id) => window.api.mods.status(id), threadId)
    const mod = status.functionMods!.find((m) => m.pluginId === plugin.id)!
    await page!.evaluate(
      async ({ id, pluginId, digest }) => {
        await window.api.mods.approveFunction(id, pluginId, digest)
        await window.api.mods.configure(id, true, false)
      },
      { id: threadId, pluginId: plugin.id, digest: mod.digest! }
    )
    const descriptor = (await page!.evaluate((id) => window.api.mods.commands(id), threadId)).find(
      (d) => d.command === "claw-info"
    )!
    assert(descriptor)
    await verifyApplicationCompletionSettings(page!, threadId, artifacts, pass)
    await row.getByRole("button", { name: "卸载", exact: true }).click()
    await page!.screenshot({ path: join(artifacts, "uninstall-confirm.png") })
    await dialog.getByRole("button", { name: "确认卸载", exact: true }).click()
    await row.waitFor({ state: "detached" })
    assert.equal(existsSync(plugin.path), false)
    assert(!(await getPlugins()).some((p) => p.id === plugin.id))
    assert.deepEqual(
      (await getPlugins()).map((p) => p.id).sort(),
      plugins
        .filter((p) => p.id !== plugin.id)
        .map((p) => p.id)
        .sort()
    )
    assert(
      !(await page!.evaluate((id) => window.api.mods.commands(id), threadId)).some(
        (d) => d.modId === descriptor.modId
      )
    )
    assert.deepEqual(await page!.evaluate((id) => window.api.mods.panes(id), threadId), [])
    await assert.rejects(
      page!.evaluate(
        ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "stale" }),
        { id: threadId, descriptor }
      )
    )
    pass(
      "uninstall removes disk files, registry and live commands; stale descriptors fail and other plugins remain"
    )
    await page!.getByRole("checkbox", { name: "启用 Mods 功能（应用级）" }).uncheck()
    const other = (await getPlugins()).find((p) => (p.modCount ?? 0) > 0)!
    const otherRow = page!.locator('[data-installed-mod-id="' + other.id + '"]')
    await otherRow.getByRole("button", { name: "卸载", exact: true }).click()
    await dialog.getByRole("button", { name: "确认卸载", exact: true }).click()
    await otherRow.waitFor({ state: "detached" })
    assert.equal(await page!.evaluate(() => window.api.mods.globalEnabled()), false)
    await page!.screenshot({ path: join(artifacts, "uninstalled.png") })
    pass("uninstall works while application Mods switch is off")
    await app!.close()
    app = undefined
    await boot()
    assert.equal(await page!.evaluate(() => window.api.mods.functionUnlocked()), false)
    assert.equal(await page!.evaluate(() => window.api.mods.globalEnabled()), false)
    await page!.locator("[data-mods-locked]").waitFor()
    await assert.rejects(
      page!.evaluate(() => window.api.mods.configureGlobal(true)),
      /MODS_FUNCTION_LOCKED/
    )
    pass("restart restores settings lock and retains the disabled runtime switch")
    const savedPolicy = await page!.evaluate(
      (id) => window.api.mods.completionPolicy(id, "function-commands"),
      threadId
    )
    assert.equal(savedPolicy.source, "application")
    assert.equal(savedPolicy.policy.mode, "off")
    assert.equal(savedPolicy.policy.modelTokenBudget, 4096)
    await assert.rejects(
      page!.evaluate(
        ({ id, policy }) => window.api.mods.setCompletionPolicy(id, "function-commands", policy),
        { id: threadId, policy: savedPolicy.policy }
      ),
      /MODS_FUNCTION_LOCKED/
    )
    pass(
      "real Electron restart retains project completion rules and restores the native write lock"
    )
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    writeFileSync(join(artifacts, "result.json"), JSON.stringify({ checks, isolated }, null, 2))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
