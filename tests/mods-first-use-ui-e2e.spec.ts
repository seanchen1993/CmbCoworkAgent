/** Frozen customer ZIPs: public UI mutations, real guests and real provider HTTP. */
import assert from "node:assert/strict"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { basename, join, relative, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import type { ElectronApplication, Locator, Page } from "playwright"
import type { ClawView } from "../src/shared/mods/claw"
import type { FlowRun, SavedFlow } from "../src/shared/mods/flows/types"
import type { ModCommandJob } from "../src/shared/mods/types"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { attemptModsE2eCleanup, runModsE2eWithFailures } from "./support/mods-e2e-failures"
import { modsUiFileHash as hashFile, selectModsUiRelease } from "./support/mods-ui-release-pins"

const root = resolve(__dirname, "..")
const release = selectModsUiRelease(root)
const starter = release.starter
const artifacts = resolve(
  root,
  process.env.CMB_MODS_CORE_E2E_ARTIFACTS ??
    (release.release === "old157"
      ? "output/mods-v2-validation/stage40-first-use-ui-20261008"
      : `output/mods-v2-validation/stage42-first-use-ui-${Date.now()}`)
)
const artifactParent = resolve(root, "output/mods-v2-validation")
assert(relative(artifactParent, artifacts).match(/^[^./\\][^/\\]*$/))
assert(!existsSync(artifacts), "Use a fresh acceptance directory; preserve earlier failures")
mkdirSync(artifacts, { recursive: true })

const packageFiles = release.packageFiles
const sourceHashes = [__filename, join(root, "tests/support/mods-ui-release-pins.ts")].map(
  (path) => ({ path, sha256: hashFile(path) })
)
function verifyFrozenPackage(): void {
  release.verify()
  for (const file of sourceHashes) assert.equal(hashFile(file.path), file.sha256)
}
function workspaceIdentity(input: string): string {
  const actual = realpathSync(input)
  return process.platform === "win32" ? actual.toLowerCase() : actual
}
verifyFrozenPackage()
const manifest = JSON.parse(readFileSync(join(starter, "packages.json"), "utf8")) as {
  schemaVersion: number
  packages: Array<{ name: string; file: string; sha256: string }>
}
assert.equal(manifest.schemaVersion, 1)
const names = ["mods-composition-board", "mods-composition-style", "component-review-kit"]
assert.deepEqual(
  manifest.packages.map((item) => item.name),
  names
)
for (const item of manifest.packages) {
  assert.equal(item.file, item.name + ".zip")
  assert.equal(hashFile(join(starter, item.file)), item.sha256)
}
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const profileName = "界面验收 Claw"
const flowName = "界面文本检视与汇报"
const threadTitle = "首次使用 DIY Claw 公开界面验收"
const taskGoal = "运行本次文本检视与汇报并等待我的确认"
const code = "function first(xs) { return xs[0].name }"
const focus = "空数组与空值"
const checks: string[] = []
const screenshots: string[] = []
const pageErrors: string[] = []
const dialogErrors: string[] = []
const confirmations: Array<{ type: string; message: string }> = []
const stageDurations: Array<{ name: string; elapsedMs: number }> = []
const waitDurations: Array<{
  label: string
  elapsedMs: number
  reads: number
  succeeded: boolean
}> = []
const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = []
const answers: string[] = []
const readBack: Record<string, unknown> = {}
let app: ElectronApplication | undefined
let page: Page
let threadId = ""
let completed = false
let watchdogExpired = false
let stageStartedAt = performance.now()
const startedAt = stageStartedAt
function pass(name: string): void {
  checks.push(name)
  stageDurations.push({ name, elapsedMs: performance.now() - stageStartedAt })
  stageStartedAt = performance.now()
  console.log("PASS " + name)
}
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeout = 30_000
): Promise<T> {
  const waitStartedAt = performance.now()
  const deadline = Date.now() + timeout
  let reads = 0
  let succeeded = false
  try {
    while (Date.now() < deadline) {
      const value = await read()
      reads++
      if (accept(value)) {
        succeeded = true
        return value
      }
      await new Promise<void>((done) => setTimeout(done, 100))
    }
    throw Error("Timeout: " + label)
  } finally {
    waitDurations.push({ label, elapsedMs: performance.now() - waitStartedAt, reads, succeeded })
  }
}
async function screenshot(name: string): Promise<void> {
  await page.screenshot({ path: join(artifacts, name) })
  screenshots.push(name)
}
async function view(): Promise<ClawView> {
  const json = await page.evaluate(
    async (id) => JSON.stringify(await window.api.mods.clawView(id)),
    threadId
  )
  return JSON.parse(json) as ClawView
}
async function jobs(): Promise<ModCommandJob[]> {
  const json = await page.evaluate(
    async (id) => JSON.stringify(await window.api.mods.jobs(id)),
    threadId
  )
  return JSON.parse(json) as ModCommandJob[]
}
async function runs(): Promise<FlowRun[]> {
  const json = await page.evaluate(
    async (id) => JSON.stringify(await window.api.mods.flowRuns(id)),
    threadId
  )
  return JSON.parse(json) as FlowRun[]
}
async function commands(): Promise<string[]> {
  return page.evaluate(
    async (id) => (await window.api.mods.commands(id)).map((item) => item.command).sort(),
    threadId
  )
}
async function navigate(tab: "mods" | "claw" | "flows"): Promise<Locator> {
  const tabs = { mods: "Function Mods", claw: "我的 Claw", flows: "DIY 流程" }
  const target = page.locator(tab === "flows" ? "[data-diy-flows]" : `[data-${tab}-settings]`)
  if (!(await target.isVisible())) {
    const menu = page.locator("nav").filter({
      has: page.getByRole("button", { name: "Function Mods", exact: true })
    })
    if (!(await menu.isVisible()))
      await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await menu.getByRole("button", { name: tabs[tab], exact: true }).click()
  }
  await target.waitFor({ state: "visible" })
  return target
}
async function editProfile(): Promise<Locator> {
  const settings = await navigate("claw")
  await settings.getByRole("button", { name: profileName, exact: true }).click()
  assert.equal(
    await settings.getByLabel("Claw 组合名称", { exact: true }).inputValue(),
    profileName
  )
  return settings
}
async function saveAndApply(): Promise<ClawView> {
  const settings = page.locator("[data-claw-settings]")
  const before = await view()
  const beforeJobs = (await jobs()).length
  const beforeRuns = (await runs()).length
  const beforeRequests = requests.length
  await settings.getByRole("button", { name: "保存能力组合", exact: true }).click()
  const saved = await until(view, (value) => value.revision > before.revision, "public Claw save")
  assert.deepEqual(saved.active, before.active, "Saving must retain the applied snapshot")
  assert.equal(saved.profiles.length, 1)
  assert.equal(saved.profiles[0].name, profileName)
  const card = settings.getByRole("button", { name: profileName, exact: true }).locator("..")
  await card.getByRole("button", { name: "应用到当前对话", exact: true }).click()
  const preview = settings.getByRole("region", { name: "应用变化预览", exact: true })
  await preview.getByRole("heading", { name: `核对后应用：${profileName}`, exact: true }).waitFor()
  assert((await preview.innerText()).includes("不会发送任务"))
  await preview.getByRole("button", { name: "确认应用", exact: true }).click()
  const applied = await until(
    view,
    (value) => value.bindingRevision > saved.bindingRevision,
    "public Claw confirmation"
  )
  assert.deepEqual(applied.active, saved.profiles[0])
  assert.equal(requests.length, beforeRequests, "Save/apply must not request a model")
  assert.equal((await jobs()).length, beforeJobs, "Save/apply must not enqueue commands")
  assert.equal((await runs()).length, beforeRuns, "Save/apply must not start a flow")
  return applied
}
async function chat(): Promise<void> {
  const back = page.getByRole("button", { name: "回到聊天使用", exact: true })
  if (await back.isVisible()) await back.click()
  await page.locator("textarea.composer-textarea").waitFor({ state: "visible" })
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "聊天", exact: true }).click()
}
async function sidebar(tab: "插件与结果" | "运行"): Promise<Locator> {
  const panel = page.getByRole("complementary", { name: "Claw 工作台", exact: true })
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "打开 Claw 工作台", exact: true }).click()
  await panel.getByRole("button", { name: tab, exact: true }).click()
  return panel
}
async function command(name: string, argument = ""): Promise<ModCommandJob> {
  await chat()
  const previous = new Set((await jobs()).map((item) => item.id))
  const input = page.locator("textarea.composer-textarea")
  await input.fill("/" + name)
  const option = page
    .getByRole("listbox")
    .getByRole("option")
    .filter({
      has: page.getByText(name, { exact: true })
    })
  await option.waitFor({ state: "visible" })
  assert.equal(await option.count(), 1, "The public slash list must expose one exact command")
  await option.click()
  assert.equal((await input.inputValue()).trim(), "/" + name)
  if (argument) await input.fill("/" + name + " " + argument)
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
  const result = await until(
    jobs,
    (values) =>
      values.some(
        (item) =>
          item.command === name &&
          !previous.has(item.id) &&
          !["queued", "running"].includes(item.state)
      ),
    "public command " + name,
    60_000
  )
  const job = result.find((item) => item.command === name && !previous.has(item.id))!
  assert.equal(job.state, "succeeded", JSON.stringify(job))
  await sidebar("插件与结果")
  return job
}
async function clickCounter(styled: boolean): Promise<void> {
  const pane = page.locator('[data-function-pane="composition-board"]')
  await pane.waitFor({ state: "visible" })
  const text = await pane.innerText()
  assert.equal(text.includes("组合版"), styled)
  const before = /已完成 (\d+) 次操作/.exec(text)
  assert(before)
  const label = styled ? "执行 · 完成一次操作" : "完成一次操作"
  if (styled) assert(text.includes("此按钮仍执行原看板的操作"))
  await pane.getByRole("button", { name: label, exact: true }).click()
  await until(
    () => pane.innerText(),
    (current) => current.includes(`已完成 ${Number(before[1]) + 1} 次操作`),
    "original board callback"
  )
}
async function openFlowDetails(panel: Locator, id: string): Promise<Locator> {
  const summary = panel.getByText(`流程任务 · ${flowName} · 查看进度与结果`, { exact: true })
  await summary.waitFor({ state: "visible" })
  if ((await summary.locator("..").getAttribute("open")) === null) await summary.click()
  const detail = panel.locator(`[data-flow-run="${id}"]`)
  await detail.waitFor({ state: "visible" })
  return detail
}

const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      length += bytes.length
      assert(length <= 1024 * 1024, "Provider request exceeds fixture bound")
      chunks.push(bytes)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string
      messages: Array<{ role: string; content: string }>
      stream?: boolean
    }
    assert(["starter-ui-a", "starter-ui-b"].includes(body.model))
    assert(Array.isArray(body.messages))
    requests.push({ model: body.model, messages: body.messages })
    const input = body.messages.findLast((message) => message.role === "user")
    const text = `公开界面协议回显[${requests.length}]：${String(input?.content)}`
    answers.push(text)
    const common = { id: `first-use-ui-${requests.length}`, created: 1, model: body.model }
    const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(
        "data: " +
          JSON.stringify({
            ...common,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }
            ]
          }) +
          "\n\n"
      )
      response.write(
        "data: " +
          JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [], usage }) +
          "\n\ndata: [DONE]\n\n"
      )
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.write(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }
          ],
          usage
        })
      )
    }
    response.end()
  } catch (error) {
    dialogErrors.push(error instanceof Error ? error.message : String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("First-use local protocol fixture failed")
  }
})

async function run(failures: unknown[]): Promise<void> {
  const watchdog = setTimeout(() => {
    watchdogExpired = true
    failures.push(Error("First-use UI watchdog expired after 480 seconds"))
    void app?.close().catch((error) => failures.push(error))
  }, 480_000)
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", done)
    })
    const address = server.address()
    assert(address && typeof address === "object")
    app = await launch(60_000)
    const identity = await release.verifyBoot(app)
    assert.equal(identity.version, release.version)
    assert.equal(identity.packaged, true)
    assert.equal(realpathSync(identity.executable), realpathSync(packageFiles[0].path))
    assert.equal(realpathSync(identity.asar), realpathSync(packageFiles[1].path))
    readBack.packageIdentity = identity
    app
      .process()
      .stdout?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    app
      .process()
      .stderr?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1366, 900)
    })
    await page.waitForFunction(() => window.innerWidth === 1366)
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("dialog", async (dialog) => {
      const message = dialog.message()
      const allowed = [
        "当前组件参数有未完成的草稿，切换会丢弃这些草稿，继续吗？",
        "更换步骤类型会丢弃当前类型的参数和草稿，是否继续？"
      ]
      try {
        confirmations.push({ type: dialog.type(), message })
        if (dialog.type() === "confirm" && allowed.includes(message)) await dialog.accept()
        else {
          dialogErrors.push("Unexpected page dialog: " + message)
          await dialog.dismiss()
        }
      } catch (error) {
        dialogErrors.push(error instanceof Error ? error.message : String(error))
      }
    })
    await page.addInitScript("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.clawView))
    // Initialization only: no Mod switches, installation, grant, selection or execution.
    threadId = await page.evaluate(
      async ({ workspace, url, title }) => {
        for (const model of ["starter-ui-a", "starter-ui-b"])
          await window.api.models.setCustomConfig({
            id: model,
            name: model,
            baseUrl: url,
            model,
            apiKey: "isolated-first-use-ui-fixture",
            maxTokens: 32000,
            maxOutputTokens: 4096
          })
        await window.api.models.setDefault("custom:starter-ui-a")
        const row = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (row as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, workspace)
        return id
      },
      { workspace, url: `http://127.0.0.1:${address.port}/v1`, title: threadTitle }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(threadTitle, { exact: true }).first().click()
    assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), false)
    assert.equal((await page.evaluate(() => window.api.plugins.list())).length, 0)
    assert.equal((await view()).profiles.length, 0)
    assert.equal((await view()).active, null)
    assert.equal((await jobs()).length, 0)
    assert.equal((await runs()).length, 0)
    const mods = await navigate("mods")
    assert.equal(await mods.locator('input[type="password"]').count(), 0)
    const globalSwitch = mods.getByRole("checkbox", {
      name: "允许使用灵件",
      exact: true
    })
    assert.equal(await globalSwitch.isChecked(), false)
    for (const item of manifest.packages) {
      await mods
        .getByLabel("选择插件 ZIP 文件", { exact: true })
        .setInputFiles(join(starter, item.file))
      await mods.getByRole("status", { name: "灵件操作结果", exact: true }).waitFor()
      await until(
        () => page.evaluate(() => window.api.plugins.list()),
        (values) => values.some((plugin) => plugin.name === item.name),
        "public upload " + item.name
      )
    }
    const installed = await page.evaluate(() => window.api.plugins.list())
    assert.deepEqual(installed.map((item) => item.name).sort(), [...names].sort())
    assert.equal(new Set(installed.map((item) => item.id)).size, 3)
    assert.equal(await globalSwitch.isChecked(), false)
    assert.equal(
      await mods.getByRole("checkbox", { name: "在此项目使用灵件", exact: true }).isChecked(),
      false
    )
    readBack.installed = installed
    await screenshot("01-imported.png")
    pass("Three frozen ZIPs upload through the real file input without enabling or executing Mods")

    await globalSwitch.click()
    await until(
      async () => {
        const value = {
          checked: await globalSwitch.isChecked(),
          enabled: await page.evaluate(() => window.api.mods.globalEnabled())
        }
        readBack.applicationSwitch = value
        return value
      },
      (value) => value.checked && value.enabled,
      "application switch UI and backend enabled"
    )
    const projectSwitch = mods.getByRole("checkbox", { name: "在此项目使用灵件", exact: true })
    await projectSwitch.click()
    await until(
      async () => {
        const value = {
          checked: await projectSwitch.isChecked(),
          status: await page.evaluate(async (id) => {
            const current = await window.api.mods.status(id)
            return { enabled: current.enabled, workspace: current.workspace }
          }, threadId)
        }
        readBack.projectSwitch = value
        return value
      },
      (value) =>
        value.checked &&
        value.status.enabled &&
        workspaceIdentity(value.status.workspace) === workspaceIdentity(workspace),
      "project switch UI and private workspace enabled"
    )
    for (const name of names) {
      const card = mods.locator(`[data-function-mod-id="${name}"]`)
      await card.getByText("查看完整能力与版本", { exact: true }).click()
      assert((await card.innerText()).includes("版本摘要："))
      await card.getByRole("button", { name: "授权以上能力", exact: true }).click()
      await card.getByText("已授权", { exact: true }).waitFor()
      await until(
        () => page.evaluate((id) => window.api.mods.status(id), threadId),
        (status) => status.functionMods?.find((item) => item.name === name)?.state === "ready",
        "public authority " + name
      )
    }
    assert.equal(requests.length, 0)
    assert.equal((await jobs()).length, 0)
    assert.equal((await runs()).length, 0)
    await screenshot("02-authorized.png")
    pass(
      "Public application/project switches and per-source grant cards produce real ready authority"
    )

    let claw = await navigate("claw")
    await claw.getByLabel("Claw 组合名称", { exact: true }).fill(profileName)
    await claw.getByLabel("选择能力 mods-composition-board", { exact: true }).check()
    let applied = await saveAndApply()
    assert.deepEqual(
      applied.active?.capabilities.map((item) => item.name),
      [names[0]]
    )
    await screenshot("03-saved-applied.png")
    pass("Public save keeps the old snapshot; preview confirmation applies without starting a task")

    await command("claw-board")
    await clickCounter(false)
    assert.equal(requests.length, 0)
    assert.equal((await runs()).length, 0)
    await screenshot("04-board.png")
    pass("A real slash-list selection and send opens the board and its original button executes")

    claw = await editProfile()
    await claw.getByLabel("选择能力 mods-composition-style", { exact: true }).check()
    applied = await saveAndApply()
    assert.deepEqual(
      applied.active?.capabilities.map((item) => item.name),
      names.slice(0, 2)
    )
    await command("claw-board")
    await clickCounter(true)
    await screenshot("05-cross-plugin.png")
    claw = await editProfile()
    await claw.getByLabel("选择能力 mods-composition-style", { exact: true }).uncheck()
    await saveAndApply()
    await command("claw-board")
    await clickCounter(false)
    assert.equal(requests.length, 0)
    pass(
      "Adding a second ZIP visibly composes the board; removing it restores a working original button"
    )

    claw = await editProfile()
    await claw.getByLabel("选择能力 component-review-kit", { exact: true }).check()
    await claw.getByLabel("组件范围 component-review-kit", { exact: true }).selectOption("selected")
    await claw.getByLabel("选择组件 component-review-kit · 汇报整理", { exact: true }).uncheck()
    await claw.getByLabel("选择组件 component-review-kit · 示例说明", { exact: true }).uncheck()
    await claw.getByText("还缺少配套功能，请点击“加入所需依赖”后保存。", { exact: true }).waitFor()
    assert(await claw.getByRole("button", { name: "保存能力组合", exact: true }).isDisabled())
    await claw.getByRole("button", { name: "加入所需依赖", exact: true }).click()
    assert(
      await claw.getByLabel("选择组件 component-review-kit · 示例说明", { exact: true }).isChecked()
    )
    const configLabel = "组件配置 component-review-kit · 代码检视 · 检视重点"
    await claw.getByLabel("设置 " + configLabel, { exact: true }).check()
    await claw.getByLabel(configLabel, { exact: true }).fill(focus)
    await claw.getByLabel("Claw 默认模型", { exact: true }).selectOption("custom:starter-ui-a")
    applied = await saveAndApply()
    const selectedKit = applied.active!.capabilities.find((item) => item.name === names[2])!
    assert.deepEqual(new Set(selectedKit.components?.ids), new Set(["review", "context"]))
    assert.equal(selectedKit.components?.mode, "selected")
    assert.deepEqual(selectedKit.components?.config.review, { focus })
    assert.equal(applied.active?.models?.default, "custom:starter-ui-a")
    await screenshot("06-component-model.png")
    pass(
      "Public partial selection rejects a missing dependency and saves the chosen config/model A"
    )

    const reviewJob = await command("component-review", code)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, "starter-ui-a")
    assert(requests[0].messages.some((item) => item.role === "user" && item.content.includes(code)))
    assert(requests[0].messages.some((item) => item.content.includes(focus)))
    assert.equal(reviewJob.result?.text, answers[0])
    await page.locator("[data-mod-jobs]").getByText(answers[0], { exact: true }).waitFor()
    assert(!(await commands()).includes("component-report"))
    await page.locator("textarea.composer-textarea").fill("/component-report")
    await page.getByRole("listbox").waitFor()
    assert.equal(
      await page
        .getByRole("listbox")
        .getByRole("option")
        .filter({
          has: page.getByText("component-report", { exact: true })
        })
        .count(),
      0
    )
    await page.locator("textarea.composer-textarea").fill("")
    await screenshot("07-review-result.png")
    pass(
      "The chat command calls model A with real code/config; an unselected report has no slash option"
    )

    claw = await editProfile()
    await claw.getByLabel("选择组件 component-review-kit · 汇报整理", { exact: true }).check()
    await claw.getByLabel("Claw 默认模型", { exact: true }).selectOption("custom:starter-ui-b")
    applied = await saveAndApply()
    assert.equal(applied.active?.models?.default, "custom:starter-ui-b")
    assert.deepEqual(
      new Set(applied.active!.capabilities.find((item) => item.name === names[2])!.components?.ids),
      new Set(["review", "context", "report"])
    )
    assert((await commands()).includes("component-report"))
    assert.equal(requests.length, 1)
    pass("Public save/confirm adds reporting and model B without executing either action")

    await navigate("flows")
    await page.getByRole("button", { name: "新建代码检视流程", exact: true }).click()
    const editor = page.getByRole("group", { name: "流程编辑器", exact: true })
    await editor.getByLabel("流程名称", { exact: true }).fill(flowName)
    await editor
      .getByLabel("任务目标", { exact: true })
      .fill("检视给定文本并整理真实返回，等待人工确认")
    const first = editor.locator("[data-flow-step]").nth(0)
    const firstButton = first.getByRole("button", { name: "配置步骤：检视代码", exact: true })
    if ((await firstButton.getAttribute("aria-expanded")) !== "true") await firstButton.click()
    await first.getByLabel("步骤类型", { exact: true }).selectOption("plugin-action")
    await first.getByLabel("动作提供者", { exact: true }).selectOption({
      label: "component-review-kit · 检视提供的代码"
    })
    await first.getByLabel("步骤名称", { exact: true }).fill("检视给定文本")
    await first.getByLabel("设置 动作输入 · text", { exact: true }).check()
    await first.getByLabel("动作输入 · text", { exact: true }).fill(code)
    const reviewStepId = await first.getAttribute("data-flow-step")
    assert(reviewStepId)
    await editor.getByRole("button", { name: "添加插件动作", exact: true }).click()
    const appended = editor.locator("[data-flow-step]").last()
    const reportStepId = await appended.getAttribute("data-flow-step")
    assert(reportStepId && reportStepId !== reviewStepId)
    const report = editor.locator(`[data-flow-step="${reportStepId}"]`)
    await report.getByRole("button", { name: "上移步骤", exact: true }).click()
    const reportExpand = report.locator("button[aria-expanded]")
    if ((await reportExpand.getAttribute("aria-expanded")) !== "true") await reportExpand.click()
    await report.getByLabel("动作提供者", { exact: true }).selectOption({
      label: "component-review-kit · 整理提供的结果"
    })
    await report.getByLabel("步骤名称", { exact: true }).fill("汇报检视结果")
    await report.getByLabel("接收前置步骤输出", { exact: true }).selectOption(reviewStepId)
    assert.equal(await report.getByLabel("输出来源路径", { exact: true }).inputValue(), "")
    assert.equal(await editor.locator("[data-flow-step]").count(), 3)
    const beforeSaveRuns = (await runs()).length
    await page.getByRole("button", { name: "保存流程", exact: true }).click()
    const saved = await until(
      async () =>
        JSON.parse(
          await page.evaluate(
            async (id) => JSON.stringify(await window.api.mods.flowList(id)),
            threadId
          )
        ) as SavedFlow[],
      (values) => values.some((item) => item.definition.name === flowName),
      "public Flow editor save"
    )
    const flow = saved.find((item) => item.definition.name === flowName)!
    assert.equal(flow.revision, 1)
    assert.equal(flow.definition.schemaVersion, 2)
    assert(flow.definition.schemaVersion === 2)
    assert.deepEqual(flow.definition.execution, { kind: "host" })
    assert.deepEqual(
      flow.definition.steps.map((item) => item.kind),
      ["plugin-action", "plugin-action", "approval"]
    )
    assert(flow.definition.steps.every((item) => item.enabled))
    const firstDefinition = flow.definition.steps[0]
    const reportDefinition = flow.definition.steps[1]
    assert(firstDefinition.kind === "plugin-action" && reportDefinition.kind === "plugin-action")
    assert.equal(firstDefinition.plugin, names[2])
    assert.equal(firstDefinition.actionId, "review")
    assert.deepEqual(firstDefinition.input, { text: code })
    assert.equal(reportDefinition.pluginId, firstDefinition.pluginId)
    assert.equal(reportDefinition.digest, firstDefinition.digest)
    assert.equal(reportDefinition.actionId, "report")
    assert.deepEqual(reportDefinition.input, {})
    assert.deepEqual(reportDefinition.inputFrom, { stepId: reviewStepId })
    assert.equal((await runs()).length, beforeSaveRuns)
    assert.equal(requests.length, 1)
    readBack.savedFlow = flow
    await screenshot("08-flow-editor.png")
    pass("The public editor saves review→whole-object report→approval with no hidden IPC creation")

    claw = await editProfile()
    await claw
      .getByLabel("Claw 绑定流程", { exact: true })
      .selectOption(`${flow.definition.id}:${flow.revision}`)
    applied = await saveAndApply()
    assert.deepEqual(applied.active?.flow, flow)
    assert.equal(applied.active?.models?.default, "custom:starter-ui-b")
    readBack.applied = applied
    await chat()
    const side = await sidebar("运行")
    const selector = side.getByLabel("对话使用的 DIY 流程", { exact: true })
    await selector.selectOption(`claw:${applied.bindingRevision}`)
    assert.equal(await selector.inputValue(), `claw:${applied.bindingRevision}`)
    await side.getByText("使用已应用 Claw 的流程副本。", { exact: false }).waitFor()
    await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
    await page.getByRole("button", { name: "执行流程", exact: true }).click()
    await page.locator("textarea.composer-textarea").fill(taskGoal)
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
    await screenshot("09-chat-flow-start.png")
    const waitingRows = await until(
      runs,
      (values) =>
        values.some((item) => ["waiting", "failed", "cancelled", "complete"].includes(item.status)),
      "public bound Flow waiting",
      60_000
    )
    assert.equal(waitingRows.length, 1)
    const waiting = waitingRows[0]
    assert.equal(waiting.status, "waiting", JSON.stringify(waiting))
    assert(waiting.pendingApproval, "Waiting must represent the visible human approval")
    assert.equal(waiting.taskGoal, taskGoal)
    assert.deepEqual(waiting.flow, applied.active?.flow)
    assert.equal(requests.length, 3)
    assert.equal(requests[1].model, "starter-ui-b")
    assert.equal(requests[2].model, "starter-ui-b")
    assert(requests[1].messages.some((item) => item.role === "user" && item.content === code))
    for (const [id, answer] of [
      [reviewStepId, answers[1]],
      [reportStepId, answers[2]]
    ]) {
      const attempt = waiting.attempts.find((item) => item.stepId === id)
      assert.equal(attempt?.status, "passed")
      assert.notEqual(attempt?.invalidated, true)
      assert.deepEqual(attempt?.result?.output, { text: answer })
    }
    assert(requests[2].messages.some((item) => item.role === "user" && item.content === answers[1]))
    const runPane = side.locator(`[data-flow-run="${waiting.id}"]`)
    await runPane.waitFor({ state: "visible" })
    for (const summary of await runPane.getByText("查看结果与证据", { exact: true }).all())
      await summary.click()
    assert(await runPane.getByText(answers[1], { exact: true }).isVisible())
    assert(await runPane.getByText(answers[2], { exact: true }).isVisible())
    const tests = runPane.getByLabel("原生项目测试证据", { exact: true })
    assert((await tests.innerText()).includes("尚无可确认的项目测试结果"))
    assert(!waiting.attempts.some((item) => item.result?.source === "native-check"))
    readBack.waiting = waiting
    await screenshot("10-flow-waiting.png")
    pass(
      "Real chat starts the applied Flow; both actions use B and pass actual {text}, with no test claim"
    )

    await runPane.getByRole("button", { name: "同意并继续", exact: true }).click()
    const final = await until(
      runs,
      (values) =>
        values.some((item) =>
          ["complete", "failed", "cancelled", "interrupted"].includes(item.status)
        ),
      "public Flow acceptance",
      60_000
    )
    assert.equal(final.length, 1)
    assert.equal(final[0].status, "complete", JSON.stringify(final[0]))
    assert.equal(requests.length, 3)
    const finalPane = await openFlowDetails(side, waiting.id)
    await finalPane.getByText(flowName + " · 已完成", { exact: true }).waitFor()
    await screenshot("11-flow-complete.png")
    pass("Public approval completes the real Flow without repeating model actions")

    const bindingBeforeReload = await view()
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(threadTitle, { exact: true }).first().click()
    const restoredSide = await sidebar("运行")
    const restoredPane = await openFlowDetails(restoredSide, waiting.id)
    await restoredPane.getByText(flowName + " · 已完成", { exact: true }).waitFor()
    for (const summary of await restoredPane.getByText("查看结果与证据", { exact: true }).all())
      await summary.click()
    assert(await restoredPane.getByText(answers[1], { exact: true }).isVisible())
    assert(await restoredPane.getByText(answers[2], { exact: true }).isVisible())
    assert.deepEqual(await view(), bindingBeforeReload)
    assert.equal((await runs()).length, 1)
    assert.equal(requests.length, 3)
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(dialogErrors, [])
    readBack.completedRuns = await runs()
    readBack.completedJobs = await jobs()
    await screenshot("12-restored.png")
    pass("Renderer refresh preserves the applied snapshot and visible results without replay")
    completed = true
  } catch (error) {
    failures.push(error)
    await attemptModsE2eCleanup(failures, () =>
      page?.screenshot({ path: join(artifacts, "failure.png") })
    )
    await attemptModsE2eCleanup(failures, () =>
      writeFileSync(
        join(artifacts, "failure.json"),
        JSON.stringify(
          {
            error: error instanceof Error ? error.stack : String(error),
            checks,
            pageErrors,
            dialogErrors
          },
          null,
          2
        ) + "\n",
        { flag: "wx" }
      )
    )
  } finally {
    clearTimeout(watchdog)
    await attemptModsE2eCleanup(failures, () => app?.close())
    await attemptModsE2eCleanup(failures, async () => {
      server.closeAllConnections()
      if (server.listening)
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done()))
        )
    })
    await attemptModsE2eCleanup(failures, verifyFrozenPackage)
    await attemptModsE2eCleanup(failures, () => {
      assert.deepEqual(pageErrors, [])
      assert.deepEqual(dialogErrors, [])
      if (completed) assert.equal(requests.length, 3)
    })
    await attemptModsE2eCleanup(failures, () =>
      writeFileSync(
        join(artifacts, "report.json"),
        JSON.stringify(
          {
            passed: completed && failures.length === 0,
            version: release.version,
            release: release.release,
            freezeManifest: { path: release.manifestPath, sha256: release.manifestSha256 },
            sourceHashes,
            isolated,
            workspace,
            threadId,
            packageFiles,
            starterPackages: manifest.packages,
            checks,
            screenshots,
            stageDurations,
            waitDurations,
            totalElapsedMs: performance.now() - startedAt,
            pageErrors,
            dialogErrors,
            confirmations,
            watchdogExpired,
            requests,
            answers,
            readBack,
            failures: failures.map((error) =>
              error instanceof Error ? error.stack : String(error)
            ),
            mutationBoundary:
              "Model/thread initialization only; all Mod/Claw/Flow mutations use public UI",
            notCovered: [
              "customer NSIS installation",
              "enterprise login",
              "customer model quality",
              "real project review/tests/repair",
              "full-process restart"
            ],
            fixtures: ["private profile", "offline SSO", "local protocol echo models"],
            artifacts: basename(artifacts)
          },
          null,
          2
        ) + "\n",
        { flag: "wx" }
      )
    )
  }
}
void runModsE2eWithFailures(run).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
