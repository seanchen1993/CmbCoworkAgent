/** Production React -> IPC -> saved Flow -> real QuickJS action schema integration. */
import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { FlowDefinition, FlowRun, SavedFlow } from "../src/shared/mods/flows/types"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { flowFormsPlugin } from "./support/mods-flow-forms-fixtures"
import { startFlowModel } from "./support/mods-flow-model"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import {
  closeModsProgress,
  openModsAdvancedSettings,
  openModsFlowHistory,
  openModsFlowPreset
} from "./support/mods-sidebar-navigation"

const root = resolve(__dirname, "..")
const requestedArtifacts = process.env.CMB_MODS_CORE_E2E_ARTIFACTS
const artifacts = requestedArtifacts
  ? resolve(requestedArtifacts)
  : join(root, "output/mods-flow-forms-e2e")
const { isolated, workspace, env } = compositionEnvironment(root)
mkdirSync(artifacts, { recursive: true })
const launchApp = createModsCoreLauncher(root, isolated, env, artifacts)
for (const name of ["report.json", "failure.json", "failure.png"])
  rmSync(join(artifacts, name), { force: true })
const checks: string[] = []
const errors: string[] = []
const runs: FlowRun[] = []
let app: ElectronApplication | undefined
let page: Page
let threadId: string
const pass = (text: string) => {
  checks.push(text)
  console.log("PASS " + text)
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 60_000
  let last: T
  do {
    last = await read()
    if (accept(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw Error(`${label}: ${JSON.stringify(last)}`)
}

async function settled(id: string, expected: "complete" | "failed") {
  const run = await until(
    () =>
      page.evaluate(({ threadId, id }) => window.api.mods.flowRun(threadId, id), { threadId, id }),
    (value) =>
      Boolean(value && ["complete", "failed", "cancelled", "interrupted"].includes(value.status)),
    "Flow did not settle"
  )
  assert.equal(run?.status, expected, JSON.stringify(run))
  runs.push(run!)
  return run!
}

async function counts() {
  const result: number[] = []
  for (const command of ["forms-producer", "forms-reviewer"]) {
    const job = await page.evaluate(
      async ({ threadId, command }) => {
        const descriptor = (await window.api.mods.commands(threadId)).find(
          (row) => row.command === command
        )!
        return window.api.mods.enqueue(threadId, descriptor, { text: "inspect-count" })
      },
      { threadId, command }
    )
    const finished = await until(
      () =>
        page.evaluate(
          async ({ threadId, id }) =>
            (await window.api.mods.jobs(threadId)).find((row) => row.id === id),
          { threadId, id: job.id }
        ),
      (value) => Boolean(value && ["succeeded", "failed", "cancelled"].includes(value.state)),
      "Counter command did not settle"
    )
    assert.equal(finished?.state, "succeeded", JSON.stringify(finished))
    result.push(Number(finished?.result?.text))
  }
  return result
}

async function save(definition: FlowDefinition, revision = 0) {
  return page.evaluate(
    ({ threadId, definition, revision }) =>
      window.api.mods.flowSave(threadId, definition, revision),
    { threadId, definition, revision }
  )
}

async function start(saved: SavedFlow) {
  return page.evaluate(
    ({ threadId, saved }) =>
      window.api.mods.flowStart(threadId, saved.definition.id, saved.revision),
    { threadId, saved }
  )
}

async function main() {
  const model = await startFlowModel(workspace)
  const watchdog = setTimeout(() => void app?.close(), 360_000)
  try {
    app = await launchApp(60_000)
    page = await app.firstWindow()
    page.on("pageerror", (error) => errors.push(error.message))
    await app.evaluate(({ ipcMain, dialog }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    await page.waitForFunction(() => Boolean(window.api?.mods?.flowSave))
    await page.addInitScript("window.__name = value => value")
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    threadId = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.mods.configureGlobal(true)
        await window.api.models.setCustomConfig({
          id: "forms",
          name: "Forms controlled model",
          baseUrl: url,
          model: "forms",
          apiKey: "isolated",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:forms")
        const row = await window.api.threads.create({
          title: "参数表单真实联调",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (row as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configure(id, true, true)
        return id
      },
      { workspace, url: model.url }
    )
    for (const producer of [true, false]) {
      const installed = await page.evaluate(
        (bytes) =>
          window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            "forms.zip",
            "local",
            undefined,
            true
          ),
        flowFormsPlugin(producer)
      )
      assert(installed.success, installed.error)
    }
    const plugins = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.filter((plugin) => plugin.name.startsWith("forms-"))
    assert.equal(plugins.length, 2)
    for (const plugin of plugins)
      await page.evaluate(
        async ({ id, plugin }) => {
          await window.api.mods.approveFunction(id, plugin.pluginId, plugin.digest!)
          await window.api.mods.setCompletionPolicy(id, plugin.name, {
            mode: "off",
            scope: "diff",
            checks: [],
            maxRepairs: 0,
            timeoutMs: 120000,
            modelTokenBudget: 4096
          })
        },
        { id: threadId, plugin }
      )
    const catalog = await page.evaluate((id) => window.api.mods.flowCatalog(id), threadId)
    const producer = catalog.actions!.find((action) => action.plugin === "forms-producer")!
    const reviewer = catalog.actions!.find(
      (action) => action.plugin === "forms-reviewer" && action.actionId === "review"
    )!
    const legacy = catalog.actions!.find(
      (action) => action.plugin === "forms-reviewer" && action.actionId === "legacy"
    )!
    assert(producer.configSchema && reviewer.configSchema)
    assert.equal(legacy.configSchema, undefined)
    const identity = (action: typeof producer) => ({
      pluginId: action.pluginId,
      plugin: action.plugin,
      digest: action.digest,
      actionId: action.actionId
    })
    const config = { strict: true, retries: 2, note: "seed", unknown: { retained: [0, false, ""] } }
    const definition: FlowDefinition = {
      schemaVersion: 1,
      id: "forms-roundtrip",
      name: "表单到真实动作",
      plugin: producer.plugin,
      goal: "检视配置的文件",
      timeoutMs: 120000,
      maxExecutions: 8,
      steps: [
        {
          id: "prepare",
          name: "准备文件",
          kind: "plugin-action",
          enabled: true,
          ...identity(producer),
          input: { feature: "seed", path: "seed.ts" },
          config
        },
        {
          id: "review",
          name: "接收前步",
          kind: "plugin-action",
          enabled: true,
          ...identity(reviewer),
          input: { feature: "fixed-override" },
          inputFrom: { stepId: "prepare" },
          config: { strict: false, retries: 0, note: "" }
        }
      ]
    }
    await save(definition)
    await page.reload()
    await page.getByText("参数表单真实联调", { exact: true }).first().click()
    await openModsAdvancedSettings(page, "步骤管理")
    await page.getByRole("button", { name: "表单到真实动作", exact: true }).click()
    const prepare = page.locator('[data-flow-step="prepare"]')
    await prepare.getByRole("button", { name: "配置步骤：准备文件", exact: true }).click()
    await prepare.getByLabel("动作输入 · Feature", { exact: true }).fill("autobiz-feature")
    await prepare.getByLabel("动作输入 · 文件路径", { exact: true }).fill("src/orders.ts")
    await prepare.getByLabel("动作配置 · 严格检查", { exact: true }).selectOption("false")
    await prepare.getByLabel("动作配置 · 重试次数", { exact: true }).fill("0")
    await prepare.getByLabel("动作配置 · 备注", { exact: true }).fill("")
    const review = page.locator('[data-flow-step="review"]')
    await review.getByRole("button", { name: "配置步骤：接收前步", exact: true }).click()
    await review.getByLabel("接收前置步骤输出", { exact: true }).selectOption("prepare")
    await review.getByLabel("输出来源路径", { exact: true }).selectOption("/payload")
    assert.equal(
      await review.getByLabel("输出字段路径（JSON Pointer，可留空）", { exact: true }).inputValue(),
      "/payload"
    )
    await review.getByLabel("输出来源路径", { exact: true }).selectOption("")
    await prepare.getByRole("button", { name: "配置步骤：准备文件", exact: true }).click()
    await prepare.getByRole("button", { name: "动作配置：JSON", exact: true }).click()
    const draft = JSON.parse(await prepare.getByLabel("动作配置", { exact: true }).inputValue())
    assert.deepEqual(draft, {
      strict: false,
      retries: 0,
      note: "",
      unknown: { retained: [0, false, ""] }
    })
    await prepare.getByRole("button", { name: "动作配置：表单", exact: true }).click()
    assert.deepEqual(await counts(), [0, 0])
    assert.equal(model.requests.length, 0)
    await page.getByRole("button", { name: "保存流程", exact: true }).click()
    const saved = (
      await until(
        () => page.evaluate((id) => window.api.mods.flowList(id), threadId),
        (list) => list.some((row) => row.definition.id === definition.id && row.revision === 2),
        "Form save did not persist"
      )
    ).find((row) => row.definition.id === definition.id)!
    assert.deepEqual(saved.definition.steps[0], {
      ...definition.steps[0],
      input: { feature: "autobiz-feature", path: "src/orders.ts" },
      config: draft
    })
    assert.deepEqual(await counts(), [0, 0])
    pass(
      "Production schema catalog renders editable fields; false, zero, empty string and unknown nested config persist without action/model execution"
    )
    for (const width of [1366, 800]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(640, 600)
        window.setContentSize(width, 900)
      }, width)
      await page.waitForFunction((width) => window.innerWidth === width, width)
      await prepare.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(artifacts, `forms-${width}.png`) })
    }
    const profile = {
      id: "forms-claw",
      name: "表单 Claw",
      capabilities: plugins.map((plugin) => ({
        pluginId: plugin.pluginId,
        name: plugin.name,
        digest: plugin.digest!
      })),
      models: { default: "custom:forms", roles: {} },
      flow: saved
    }
    const binding = await page.evaluate(
      async ({ threadId, profile }) => {
        let view = await window.api.mods.clawView(threadId)
        view = await window.api.mods.clawChange(threadId, {
          kind: "save",
          profile,
          workspace: view.workspace,
          revision: view.revision
        })
        return window.api.mods.clawChange(threadId, {
          kind: "apply",
          id: profile.id,
          workspace: view.workspace,
          revision: view.revision,
          bindingRevision: view.bindingRevision
        })
      },
      { threadId, profile }
    )
    await page.getByRole("button", { name: "去这段聊天使用", exact: true }).click()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1366, 900)
    )
    const selection = await openModsFlowPreset(page)
    await selection.selectOption(`claw:${binding.bindingRevision}`)
    assert.equal(await selection.inputValue(), `claw:${binding.bindingRevision}`)
    assert.equal((await page.evaluate((id) => window.api.mods.flowRuns(id), threadId)).length, 0)
    await closeModsProgress(page)
    await page.locator("textarea.composer-textarea").fill("执行刚刚保存的参数表单")
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    const started = (
      await until(
        () => page.evaluate((id) => window.api.mods.flowRuns(id), threadId),
        (value) => value.length > 0,
        "Chat did not start bound flow"
      )
    )[0]
    const complete = await settled(started.id, "complete")
    const result = complete.attempts.find((attempt) => attempt.stepId === "review")!.result!.output!
    assert.equal(result.feature, "fixed-override")
    assert.equal(result.path, "src/orders.ts")
    assert.deepEqual(result.config, { strict: false, retries: 0, note: "" })
    assert.deepEqual(await counts(), [1, 1])
    assert.equal(model.requests.length, 0)
    const history = await openModsFlowHistory(page, complete.id)
    assert.equal(await history.getAttribute("data-flow-run"), complete.id)
    await page.screenshot({ path: join(artifacts, "forms-chat-complete.png") })
    pass(
      "Saved form runs through actual chat/Claw/QuickJS; predecessor output is consumed and explicit constants override it"
    )
    for (const invalid of [undefined, { strict: "wrong", retries: 0, note: "" }]) {
      const bad = structuredClone(saved.definition)
      bad.id = invalid ? "forms-invalid-config" : "forms-missing-config"
      const step = bad.steps[1]
      assert.equal(step.kind, "plugin-action")
      if (step.kind !== "plugin-action") throw Error("Invalid fixture")
      step.config = invalid
      const badRun = await settled((await start(await save(bad))).id, "failed")
      assert(
        !badRun.attempts.some((attempt) => attempt.status === "passed"),
        JSON.stringify(badRun)
      )
      assert.match(badRun.summary ?? "", /config|配置/i)
      assert.deepEqual(await counts(), [1, 1])
    }
    pass(
      "Real preparation rejects missing/wrong config despite inputFrom before either plugin action executes"
    )
    const badOutput = structuredClone(saved.definition)
    badOutput.id = "forms-invalid-upstream"
    const source = badOutput.steps[0]
    const consumer = badOutput.steps[1]
    if (source.kind !== "plugin-action" || consumer.kind !== "plugin-action")
      throw Error("Invalid fixture")
    source.input.emitInvalid = true
    consumer.input = {}
    const rejectedInput = await settled((await start(await save(badOutput))).id, "failed")
    assert.equal(
      rejectedInput.attempts.find((attempt) => attempt.stepId === "prepare")?.status,
      "passed"
    )
    assert(
      !rejectedInput.attempts.some(
        (attempt) => attempt.stepId === "review" && attempt.status === "passed"
      )
    )
    assert.deepEqual(await counts(), [2, 1])
    pass(
      "Real upstream output is validated after merging; an invalid supplied feature never invokes the consumer"
    )
    const old: FlowDefinition = {
      ...definition,
      id: "forms-legacy",
      steps: [
        {
          id: "legacy",
          name: "旧包配置",
          enabled: true,
          kind: "plugin-action",
          ...identity(legacy),
          input: {},
          config: { arbitrary: { enabled: false }, empty: "", count: 0 }
        }
      ]
    }
    const legacyRun = await settled((await start(await save(old))).id, "complete")
    assert.deepEqual(
      legacyRun.attempts[0].result?.output?.config,
      old.steps[0].kind === "plugin-action" ? old.steps[0].config : undefined
    )
    assert.deepEqual(await counts(), [2, 2])
    assert.deepEqual(errors, [])
    pass("Existing action without configSchema still receives arbitrary legacy config unchanged")
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        { passed: true, isolated, checks, runs, modelRequests: model.requests, errors },
        null,
        2
      )
    )
  } catch (error) {
    writeFileSync(
      join(artifacts, "failure.json"),
      JSON.stringify(
        {
          isolated,
          checks,
          errors,
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
          body: await page
            ?.locator("body")
            .textContent()
            .catch(() => null),
          runs
        },
        null,
        2
      )
    )
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    await model.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
