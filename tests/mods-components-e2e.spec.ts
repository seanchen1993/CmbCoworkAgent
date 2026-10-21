/** Production UI/IPC/native component projection/QuickJS/Agent integration. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { _electron, type ElectronApplication, type Page } from "playwright"
import type { ClawProfile } from "../src/shared/mods/claw"
import type { FlowDefinition, FlowRun } from "../src/shared/mods/flows/types"
import { compositionEnvironment, compositionPlugin } from "./support/mods-composition-fixtures"
import { componentsPlugin } from "./support/mods-components-fixtures"
import { startFlowModel } from "./support/mods-flow-model"
import {
  closeModsProgress,
  openModsAdvancedSettings,
  openModsClawEditor,
  openModsClawMoreSettings,
  openModsFlowHistory,
  openModsFlowPreset,
  openModsProgress
} from "./support/mods-sidebar-navigation"

const root = resolve(__dirname, "..")
const artifacts = join(root, "output/mods-components-e2e")
const { isolated, workspace, env } = compositionEnvironment(root)
mkdirSync(artifacts, { recursive: true })
for (const name of ["report.json", "failure.json", "failure.png"])
  rmSync(join(artifacts, name), { force: true })
const checks: string[] = []
const errors: string[] = []
const runs: FlowRun[] = []
let app: ElectronApplication | undefined
let page: Page
let threadId: string
const pass = (label: string) => {
  checks.push(label)
  console.log("PASS " + label)
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
async function boot() {
  app = await _electron.launch({
    executablePath: join(root, "tests/support/electron-launcher.cmd"),
    args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
    cwd: root,
    env,
    timeout: 60_000
  })
  app.process().stdout?.on("data", (data) => appendFileSync(join(artifacts, "runtime.log"), data))
  app.process().stderr?.on("data", (data) => appendFileSync(join(artifacts, "runtime.log"), data))
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
  await page.waitForFunction(() => Boolean(window.api?.mods?.clawView))
  await page.evaluate(() => {
    ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
  })
}
async function saveProfile(profile: ClawProfile, apply = false) {
  return page.evaluate(
    async ({ threadId, profile, apply }) => {
      let view = await window.api.mods.clawView(threadId)
      view = await window.api.mods.clawChange(threadId, {
        kind: "save",
        profile,
        workspace: view.workspace,
        revision: view.revision
      })
      return apply
        ? window.api.mods.clawChange(threadId, {
            kind: "apply",
            id: profile.id,
            workspace: view.workspace,
            revision: view.revision
          })
        : view
    },
    { threadId, profile, apply }
  )
}
async function command(name: string, text = "inspect") {
  // Re-read a catalog invalidated by configuration; never replay enqueue or a command.
  const descriptor = await until(
    () =>
      page.evaluate(
        async ({ threadId, name }) => {
          try {
            return (await window.api.mods.commands(threadId)).find((row) => row.command === name)
          } catch (error) {
            if (!String(error).includes("MODS_SCOPE_CHANGED")) throw error
            return undefined
          }
        },
        { threadId, name }
      ),
    (row) => Boolean(row),
    `Missing current command ${name}`
  )
  const job = await page.evaluate(
    ({ threadId, descriptor, text }) => window.api.mods.enqueue(threadId, descriptor!, { text }),
    { threadId, descriptor, text }
  )
  const result = await until(
    () =>
      page.evaluate(
        async ({ threadId, id }) =>
          (await window.api.mods.jobs(threadId)).find((row) => row.id === id),
        { threadId, id: job.id }
      ),
    (row) => Boolean(row && ["succeeded", "failed", "cancelled"].includes(row.state)),
    "Component command did not settle"
  )
  assert.equal(result?.state, "succeeded", JSON.stringify(result))
  return result!.result!.text
}
async function runState(id: string, expected: FlowRun["status"]) {
  const run = await until(
    () =>
      page.evaluate(({ threadId, id }) => window.api.mods.flowRun(threadId, id), { threadId, id }),
    (row) =>
      Boolean(
        row && [expected, "complete", "failed", "cancelled", "interrupted"].includes(row.status)
      ),
    `Flow did not become ${expected}`
  )
  assert.equal(run?.status, expected, JSON.stringify(run))
  runs.push(run!)
  return run!
}
async function main() {
  const model = await startFlowModel(workspace)
  const watchdog = setTimeout(() => void app?.close(), 480_000)
  writeFileSync(join(artifacts, "runtime.log"), "")
  try {
    await boot()
    threadId = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.mods.configureGlobal(true)
        await window.api.models.setCustomConfig({
          id: "components",
          name: "组件演示模型",
          baseUrl: url,
          model: "components",
          apiKey: "isolated-fixture",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:components")
        const row = await window.api.threads.create({
          title: "组件 DIY 实机演示",
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
    // Empty applied selection precedes installation. Approval's isolated register probe
    // may evaluate all entries; the marker must remain absent in real selected sessions.
    await saveProfile({ id: "components-claw", name: "我的组件组合", capabilities: [] }, true)
    for (const side of ["a", "b"] as const) {
      const result = await page.evaluate(
        (bytes) =>
          window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            "components.zip",
            "local",
            undefined,
            true
          ),
        componentsPlugin(side)
      )
      assert(result.success, result.error)
    }
    const plugins = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.filter((row) => row.name.startsWith("components-"))
    assert.equal(plugins.length, 2)
    for (const plugin of plugins) {
      assert(plugin.digest && plugin.components?.length)
      await page.evaluate(
        async ({ threadId, plugin }) => {
          await window.api.mods.approveFunction(threadId, plugin.pluginId, plugin.digest!)
          await window.api.mods.setCompletionPolicy(threadId, plugin.name, {
            mode: "off",
            scope: "diff",
            checks: [],
            maxRepairs: 0,
            timeoutMs: 120000,
            modelTokenBudget: 4096
          })
        },
        { threadId, plugin }
      )
    }
    assert.equal((await page.evaluate((id) => window.api.mods.commands(id), threadId)).length, 0)
    pass(
      "Real installation/approval succeeds while the empty applied Claw exposes no business commands"
    )

    await page.reload()
    await page.getByText("组件 DIY 实机演示", { exact: true }).first().click()
    await openModsAdvancedSettings(page, "搭配管理")
    await openModsClawEditor(page)
    await page.getByRole("button", { name: "我的组件组合", exact: true }).click()
    for (const name of ["components-a", "components-b"]) {
      await page.getByLabel(`选择能力 ${name}`, { exact: true }).check()
      await page.getByLabel(`组件范围 ${name}`, { exact: true }).selectOption("selected")
    }
    await page.getByLabel("选择组件 components-a · 自动改写", { exact: true }).uncheck()
    await page.getByLabel("选择组件 components-a · 基础能力", { exact: true }).uncheck()
    assert(await page.getByRole("button", { name: "保存组合", exact: true }).isDisabled())
    await page.getByRole("button", { name: "加入所需依赖", exact: true }).click()
    assert(await page.getByLabel("选择组件 components-a · 基础能力", { exact: true }).isChecked())
    await page.getByLabel("设置 组件配置 components-a · 代码检视 · 标记", { exact: true }).check()
    await page
      .getByLabel("组件配置 components-a · 代码检视 · 标记", { exact: true })
      .fill("review-alpha")
    await page.getByLabel("设置 组件配置 components-b · 生成报告 · 标记", { exact: true }).check()
    await page
      .getByLabel("组件配置 components-b · 生成报告 · 标记", { exact: true })
      .fill("report-beta")
    await openModsClawMoreSettings(page)
    await page.getByLabel("聊天默认模型", { exact: true }).selectOption("custom:components")
    for (const width of [1366, 1024, 800]) {
      await app!.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(640, 600)
        window.setContentSize(width, 900)
      }, width)
      await page.waitForFunction((width) => window.innerWidth === width, width)
      await page.locator("[data-claw-components]").first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(artifacts, `component-editor-${width}.png`) })
    }
    await page.getByRole("button", { name: "保存组合", exact: true }).click()
    await until(
      () => page.evaluate((id) => window.api.mods.clawView(id), threadId),
      (view) => view.profiles.some((profile) => profile.capabilities.length === 2),
      "Component save did not persist"
    )
    await page
      .getByRole("button", { name: "我的组件组合", exact: true })
      .locator("..")
      .getByRole("button", { name: "应用到所选聊天", exact: true })
      .click()
    await page.getByRole("button", { name: "确认应用", exact: true }).click()
    const applied = await until(
      () => page.evaluate((id) => window.api.mods.clawView(id), threadId),
      (view) => view.active?.capabilities.length === 2,
      "Component apply did not persist"
    )
    let profile = applied.active!
    assert.deepEqual(
      new Set(profile.capabilities.find((row) => row.name === "components-a")!.components!.ids),
      new Set(["core", "review"])
    )
    pass(
      "Real component UI saves explicit dependencies, own config, cross-package selection and model"
    )

    const inspection = JSON.parse(await command("component-review"))
    assert.deepEqual(inspection.order, ["core", "review"])
    assert.equal(inspection.marker, "review-alpha")
    assert.equal(inspection.shared, "package-a")
    assert.equal(inspection.excludedEvaluated, false)
    assert.equal(JSON.parse(await command("component-report")).marker, "report-beta")
    assert(
      !(await page.evaluate((id) => window.api.mods.commands(id), threadId)).some(
        (row) => row.command === "component-rewrite"
      )
    )
    pass(
      "Only selected entries execute; dependency ordering and per-component config remain isolated"
    )

    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    await page.locator("textarea.composer-textarea").fill("使用当前组件组合说明代码检视流程")
    await page.locator("textarea.composer-textarea").press("Enter")
    await page
      .getByText("普通聊天答复：已读取本次问题与运行摘要。", { exact: true })
      .first()
      .waitFor({ timeout: 60000 })
    assert(JSON.parse(await command("component-review")).chats > 0)
    assert(model.requests.some((row) => row.model === "components" && row.marker === "UNKNOWN"))
    pass("Ordinary chat uses the selected component hook and real configured HTTP model")

    const catalog = await page.evaluate((id) => window.api.mods.flowCatalog(id), threadId)
    const identity = (name: string, actionId: string) => {
      const plugin = plugins.find((row) => row.name === name)!
      const action = catalog.actions!.find(
        (row) => row.pluginId === plugin.pluginId && row.actionId === actionId
      )
      assert(action)
      return { pluginId: plugin.pluginId, plugin: name, digest: plugin.digest!, actionId }
    }
    const definition: FlowDefinition = {
      schemaVersion: 2,
      execution: { kind: "host" },
      id: "components-flow",
      name: "组件跨包协作",
      goal: "检视并生成报告",
      timeoutMs: 120000,
      maxExecutions: 8,
      steps: [
        {
          id: "review",
          name: "只检视不改写",
          kind: "plugin-action",
          enabled: true,
          ...identity("components-a", "review"),
          input: { file: "src/orders.ts" }
        },
        {
          id: "report",
          name: "跨包生成报告",
          kind: "plugin-action",
          enabled: true,
          ...identity("components-b", "report"),
          input: {},
          inputFrom: { stepId: "review" }
        },
        {
          id: "agent",
          name: "模型总结",
          kind: "agent",
          enabled: true,
          prompt: "[FLOW-IMPLEMENT] Summarize selected review and report components.",
          modelId: "custom:components"
        },
        {
          id: "approval",
          name: "用户核对",
          kind: "approval",
          enabled: true,
          prompt: "确认使用以上组件结果"
        }
      ]
    }
    const saved = await page.evaluate(
      ({ threadId, definition }) => window.api.mods.flowSave(threadId, definition, 0),
      { threadId, definition }
    )
    profile = { ...profile, flow: saved }
    const appliedFlow = await saveProfile(profile, true)
    await page.reload()
    await page.getByText("组件 DIY 实机演示", { exact: true }).first().click()
    const preset = await openModsFlowPreset(page)
    await preset.selectOption(`claw:${appliedFlow.bindingRevision}`)
    await page.locator("textarea.composer-textarea").fill("检视 orders 并合并两个插件组件的结果")
    await closeModsProgress(page)
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    const started = (
      await until(
        () => page.evaluate((id) => window.api.mods.flowRuns(id), threadId),
        (rows) => rows.length > 0,
        "Real chat did not start bound component flow"
      )
    )[0]
    const waiting = await runState(started.id, "waiting")
    const output = waiting.attempts.find((row) => row.stepId === "report")!.result!.output!
    assert.equal(output.reviewMarker, "review-alpha")
    assert.equal(output.reportMarker, "report-beta")
    assert.equal(output.file, "src/orders.ts")
    assert.equal(output.reviewExcludedEvaluated, false)
    assert.equal(
      waiting.attempts.find((row) => row.stepId === "agent")!.result!.modelId,
      "custom:components"
    )
    await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1366, 900)
    )
    await page.screenshot({ path: join(artifacts, "component-chat-approval.png") })
    await assert.rejects(
      saveProfile({ ...profile, name: "Cannot switch while running" }, true),
      /busy|运行|任务|审批|lease/i
    )
    const taskPanel = await openModsProgress(page)
    await taskPanel.getByRole("button", { name: "同意并继续", exact: true }).click()
    await runState(started.id, "complete")
    const completeDetails = await openModsFlowHistory(page, started.id)
    await completeDetails.getByText("当前任务 · 已完成", { exact: true }).waitFor()
    for (const name of ["只检视不改写", "跨包生成报告"]) {
      await completeDetails
        .getByRole("listitem")
        .filter({ hasText: name })
        .getByText("查看结果与证据", { exact: true })
        .click()
    }
    await completeDetails.getByText("当前任务 · 已完成", { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, "component-chat-complete.png") })
    await completeDetails.screenshot({ path: join(artifacts, "component-complete-evidence.png") })
    pass(
      "Real chat starts A.review → B.report → actual model → approval; busy binding switch is rejected"
    )

    const edited = structuredClone(profile)
    edited.capabilities.find(
      (row) => row.name === "components-a"
    )!.components!.config.review.marker = "review-edited"
    await saveProfile(edited)
    assert.equal(JSON.parse(await command("component-review")).marker, "review-alpha")
    await saveProfile(edited, true)
    assert.equal(JSON.parse(await command("component-review")).marker, "review-edited")
    profile = edited
    pass(
      "Saving a template leaves the applied configuration frozen; explicit idle apply replaces the guest"
    )

    for (const kind of ["dependency", "configuration"] as const) {
      const bad = structuredClone(profile)
      const selection = bad.capabilities.find((row) => row.name === "components-a")!.components!
      if (kind === "dependency") selection.ids = ["review"]
      else selection.config.review = { marker: 17 }
      await assert.rejects(saveProfile(bad), /component|组件|schema|depend|config|标记/i)
    }
    await assert.rejects(
      page.evaluate(
        (threadId) =>
          window.api.mods.setCompletionPolicy(threadId, "components-a", {
            mode: "check",
            scope: "diff",
            checks: ["code-review"],
            maxRepairs: 0,
            timeoutMs: 120000,
            modelTokenBudget: 4096
          }),
        threadId
      ),
      /component|组件|partial|mandatory|完整|全部/i
    )
    assert.equal(JSON.parse(await command("component-review")).marker, "review-edited")
    pass(
      "Dependency/config errors and mandatory completion policy cannot bypass explicit partial selection"
    )

    await app!.close()
    app = undefined
    await boot()
    assert.equal(
      (
        await page.evaluate((id) => window.api.mods.clawView(id), threadId)
      ).active?.capabilities.find((row) => row.name === "components-a")?.components?.config.review
        .marker,
      "review-edited"
    )
    assert.equal(JSON.parse(await command("component-review")).marker, "review-edited")
    pass(
      "Full application restart retains selected components and config without evaluating the excluded entry"
    )

    const legacy = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "legacy.zip",
          "local",
          undefined,
          true
        ),
      compositionPlugin("composition-a")
    )
    assert(legacy.success, legacy.error)
    const old = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((row) => row.name === "composition-a")!
    await page.evaluate(
      ({ threadId, old }) => window.api.mods.approveFunction(threadId, old.pluginId, old.digest!),
      { threadId, old }
    )
    profile = {
      ...profile,
      capabilities: [
        ...profile.capabilities,
        { pluginId: old.pluginId, name: old.name, digest: old.digest! }
      ]
    }
    await saveProfile(profile, true)
    assert.equal(await command("composition-a", "inspect-count"), "0")
    assert.equal(JSON.parse(await command("component-review")).marker, "review-edited")
    pass("Unmodified legacy whole-package guest and selected native components coexist in one Claw")

    const revoked = await page.evaluate(async (id) => {
      const view = await window.api.mods.clawView(id)
      return window.api.mods.clawStart(id, view.bindingRevision, "撤权期间不得发布结果")
    }, threadId)
    await runState(revoked.id, "waiting")
    await page.evaluate((id) => window.api.mods.revokeFunction(id, "components-a"), threadId)
    const ended = await until(
      () =>
        page.evaluate(({ threadId, id }) => window.api.mods.flowRun(threadId, id), {
          threadId,
          id: revoked.id
        }),
      (run) => Boolean(run && ["cancelled", "failed", "interrupted"].includes(run.status)),
      "Revocation did not terminate running component flow"
    )
    runs.push(ended!)
    assert.notEqual(ended?.status, "complete")
    await assert.rejects(
      page.evaluate((id) => window.api.mods.commands(id), threadId),
      /components-a.*(?:更改|禁用|未授权)/
    )
    pass(
      "Revoking a package cancels its active composed flow and cannot revive its selected command"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        { passed: true, isolated, checks, runs, requests: model.requests, errors },
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
          runs,
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
          body: await page
            ?.locator("body")
            .textContent()
            .catch(() => null)
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
