import { verifyClawJourney } from "./support/mods-claw-e2e"
/** Isolated production Electron + React + IPC + Agent tools + real Autobiz business checks. */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { _electron, type ElectronApplication, type Page } from "playwright"
import AdmZip from "adm-zip"
import { createBusinessProject } from "./support/mods-business-project"
import { approveBusinessOperation } from "./support/mods-business-approval"
import { startFlowModel, fixedOrderExport } from "./support/mods-flow-model"
import type { FlowDefinition, FlowRun } from "../src/shared/mods/flows/types"

const root = resolve(__dirname, "..")
const artifacts = join(root, "output/mods-v3-validation/e2e")
const isolated = mkdtempSync(join(tmpdir(), "cmb-flow-e2e-"))
const project = join(isolated, "workspace")
mkdirSync(artifacts, { recursive: true })
const checks: string[] = []
let app: ElectronApplication | undefined
let page: Page
let threadId: string
const pass = (text: string) => {
  checks.push(text)
  console.log("PASS " + text)
}
async function main() {
  await createBusinessProject(project)
  const model = await startFlowModel(project)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (
      value &&
      /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i.test(
        key
      )
    )
      env[key] = value
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
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    CMB_E2E_ELECTRON_BIN: createRequire(join(root, "package.json"))("electron"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost"
  })
  const logs: string[] = []
  let latest: FlowRun | null = null
  const watchdog = setTimeout(() => {
    void app?.close()
  }, 600_000)
  const readRun = (id: string) =>
    page.evaluate(({ threadId, id }) => window.api.mods.flowRun(threadId, id), { threadId, id })
  const until = async (id: string, status: string, timeout = 120_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await approveBusinessOperation(page, project)
      latest = await readRun(id)
      if (latest?.status === status) return latest
      if (latest && ["failed", "cancelled", "interrupted", "complete"].includes(latest.status))
        throw Error(`Expected ${status}; got ${latest.status}: ${latest.summary}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw Error(`FLOW_E2E_TIMEOUT ${status}: ${JSON.stringify(latest)}`)
  }
  try {
    app = await _electron.launch({
      executablePath: join(root, "tests/support/electron-launcher.cmd"),
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
      cwd: root,
      env,
      timeout: 60_000
    })
    app.process().stderr?.on("data", (data) => logs.push(String(data)))
    await app.firstWindow()
    await app.evaluate(({ ipcMain, dialog }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    page = app.windows()[0]
    await page.waitForFunction(() => Boolean(window.api?.mods?.flowStart))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (v: unknown) => v
    })
    await page.evaluate(async (url) => {
      await window.api.mods.configureGlobal(true)
      for (const id of ["flow-a", "flow-b"])
        await window.api.models.setCustomConfig({
          id,
          name: id,
          baseUrl: url,
          model: id,
          apiKey: "isolated-fixture",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
      await window.api.models.setDefault("custom:flow-a")
    }, model.url)
    threadId = await page.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Autobiz DIY Flow E2E",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, workspace)
      await window.api.mods.configure(id, true, true)
      return id
    }, project)
    const zip = new AdmZip()
    zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "flow-e2e", version: "1.0.0" })))
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./flow.ts"] })))
    zip.addFile(
      "hooks/flow.ts",
      Buffer.from(
        'export function register(on) { on("completion.check", async () => ({decision:"pass"})) }'
      )
    )
    const installed = await page.evaluate(
      (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "flow.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(installed.success, installed.error)
    const plugin = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((p) => p.name === "flow-e2e")!
    await page.evaluate(
      async ({ id, pluginId, digest }) => {
        await window.api.mods.approveFunction(id, pluginId, digest)
        await window.api.mods.setCompletionPolicy(id, "flow-e2e", {
          mode: "off",
          scope: "diff",
          checks: [],
          maxRepairs: 0,
          timeoutMs: 120000,
          modelTokenBudget: 4096
        })
      },
      { id: threadId, pluginId: plugin.pluginId, digest: plugin.digest! }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Autobiz DIY Flow E2E", { exact: true }).first().click()
    if (process.env.CMB_E2E_CLAW_ONLY === "1") {
      await page.getByRole("button", { name: "自定义", exact: true }).click()
      await verifyClawJourney(page, threadId, artifacts)
      pass("真实 Claw A/B 组合和普通聊天 Hook 验证通过")
      return
    }
    const definition: FlowDefinition = {
      schemaVersion: 1,
      id: "autobiz-e2e",
      name: "Autobiz 自选修复流程",
      plugin: "flow-e2e",
      goal: "Verify real business assertions in requirements.md",
      timeoutMs: 300000,
      maxExecutions: 24,
      steps: [
        {
          id: "plan",
          name: "分析需求",
          kind: "agent",
          enabled: true,
          agentType: "plan",
          modelId: "custom:flow-a",
          prompt: "[FLOW-PLAN] Read only planning"
        },
        {
          id: "unit",
          name: "业务单测",
          kind: "check",
          enabled: true,
          check: "unit-test",
          onFailure: { stepId: "repair", maxRetries: 1 },
          onSuccess: "confirm"
        },
        {
          id: "repair",
          name: "修复业务代码",
          kind: "agent",
          enabled: true,
          modelId: "custom:flow-b",
          prompt: "[FLOW-REPAIR] Fix order-export.cjs only"
        },
        { id: "retest", name: "重跑单测", kind: "check", enabled: true, check: "unit-test" },
        {
          id: "disabled",
          name: "未选 E2E",
          kind: "agent",
          enabled: false,
          prompt: "[FLOW-DISABLED]"
        },
        {
          id: "confirm",
          name: "人工验收",
          kind: "approval",
          enabled: true,
          prompt: "确认真实业务测试通过后继续"
        }
      ]
    }
    const saved = await page.evaluate(
      ({ threadId, definition }) => window.api.mods.flowSave(threadId, definition, 0),
      { threadId, definition }
    )
    await page.getByRole("button", { name: "Claw 工作台", exact: true }).click()
    await page
      .getByLabel("对话使用的 DIY 流程")
      .selectOption(`${saved.definition.id}:${saved.revision}`)
    assert.equal((await page.evaluate((id) => window.api.mods.flowRuns(id), threadId)).length, 0)
    await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
    await page.getByRole("button", { name: "执行流程", exact: true }).click()
    await page.locator("textarea.composer-textarea").fill("本次目标：核实订单导出的七项真实业务断言")
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
    await page.locator("[data-chat-flow] [data-flow-run]").waitFor({ timeout: 60000 })
    const started = (await readRun(
      (await page.locator("[data-chat-flow] [data-flow-run]").getAttribute("data-flow-run"))!
    ))!
    assert.equal(started.taskGoal, "本次目标：核实订单导出的七项真实业务断言")
    assert.equal(started.flow.definition.goal, definition.goal)
    const waiting = await until(started.id, "waiting")
    assert(waiting.attempts.some((a) => a.stepId === "unit" && a.status === "failed"))
    assert(waiting.attempts.some((a) => a.stepId === "retest" && a.status === "passed"))
    assert(waiting.attempts.some((a) => a.stepId === "disabled" && a.status === "skipped"))
    assert.deepEqual(
      model.requests.filter((r) => r.tool === "structured_output").map((r) => [r.marker, r.model]),
      [
        ["PLAN", "flow-a"],
        ["REPAIR", "flow-b"]
      ]
    )
    const independent = spawnSync(process.execPath, [join(project, "business.spec.cjs")], {
      encoding: "utf8",
      windowsHide: true
    })
    assert.equal(independent.status, 0, independent.stderr)
    assert.match(independent.stdout, /BUSINESS_ASSERTIONS_PASSED:7/)
    pass("真实 Agent 使用所选模型；原始业务测试失败后进入修复，再通过7项独立断言；禁用步骤零请求")
    assert(model.requests.some((request) => request.prompt.includes(started.taskGoal!)))
    await page.locator("textarea.composer-textarea").fill("这是一条未发送的聊天草稿")
    await page.getByRole("region", { name: "人工成果确认" }).waitFor()
    await page.screenshot({ path: join(artifacts, "approval.png") })
    await page.getByRole("button", { name: "同意并继续", exact: true }).click()
    const complete = await until(started.id, "complete")
    assert(complete.attempts.some((a) => a.stepId === "__final" && a.status === "passed"))
    await page.screenshot({ path: join(artifacts, "complete.png") })
    assert.equal(
      await page.locator("textarea.composer-textarea").inputValue(),
      "这是一条未发送的聊天草稿"
    )
    await page.locator("textarea.composer-textarea").fill("")
    await page.getByText(/流程任务 · Autobiz 自选修复流程 · 查看进度与结果/).click()
    await page.getByRole("button", { name: "带运行摘要追问", exact: true }).click()
    const followup = await page.locator("textarea.composer-textarea").inputValue()
    assert(followup.includes(started.id))
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor()
    await page.locator("textarea.composer-textarea").press("Enter")
    await page
      .getByText("普通聊天答复：已读取本次问题与运行摘要。", { exact: true })
      .first()
      .waitFor({ timeout: 60000 })
    assert.equal((await page.evaluate((id) => window.api.mods.flowRuns(id), threadId)).length, 1)
    assert(
      model.requests.some(
        (request) => request.marker === "UNKNOWN" && request.prompt.includes(started.id)
      )
    )
    pass("真实聊天显式启动、冻结本次目标、按钮不误发草稿；运行摘要进入模型，普通追问不重启流程")
    await page.getByRole("button", { name: "自定义", exact: true }).click()
    await page.getByRole("button", { name: "DIY 流程", exact: true }).click()
    pass("生产 React 人工暂停与点击确认、最终原生重验、完成记录")
    const second = await page.evaluate(
      ({ threadId, saved }) =>
        window.api.mods.flowStart(threadId, saved.definition.id, saved.revision),
      { threadId, saved }
    )
    const secondWaiting = await until(second.id, "waiting")
    assert(secondWaiting.attempts.some((a) => a.stepId === "repair" && a.status === "skipped"))
    assert.equal(
      model.requests.filter((r) => r.marker === "REPAIR" && r.tool === "edit_file").length,
      1
    )
    await page.evaluate(({ threadId, id }) => window.api.mods.flowCancel(threadId, id), {
      threadId,
      id: second.id
    })
    assert.equal((await readRun(second.id))?.status, "cancelled")
    pass("第二次通过路线跳过修复；取消等待不会继续执行")
    const ordering: FlowDefinition = {
      ...definition,
      id: "ordering",
      name: "DIY 顺序与开关",
      steps: [
        {
          id: "alpha",
          name: "步骤A",
          kind: "agent",
          enabled: true,
          prompt: "[FLOW-ALPHA]",
          modelId: "custom:flow-a"
        },
        {
          id: "beta",
          name: "步骤B",
          kind: "agent",
          enabled: true,
          prompt: "[FLOW-BETA]",
          modelId: "custom:flow-b"
        }
      ]
    }
    let orderingRevision = 0
    for (const variant of [
      ordering,
      { ...ordering, steps: [...ordering.steps].reverse() },
      {
        ...ordering,
        steps: ordering.steps.map((step) => ({ ...step, enabled: step.id === "beta" }))
      }
    ]) {
      const offset = model.requests.length
      const saved = await page.evaluate(
        ({ threadId, variant, revision }) => window.api.mods.flowSave(threadId, variant, revision),
        { threadId, variant, revision: orderingRevision }
      )
      orderingRevision = saved.revision
      const run = await page.evaluate(
        ({ threadId, saved }) =>
          window.api.mods.flowStart(threadId, saved.definition.id, saved.revision),
        { threadId, saved }
      )
      await until(run.id, "complete")
      assert.deepEqual(
        model.requests.slice(offset).map((r) => r.marker),
        variant.steps.filter((s) => s.enabled).map((s) => s.id.toUpperCase())
      )
    }
    pass("相同Agent步骤保存A→B、B→A和仅B，真实模型请求顺序/次数随配置改变")
    const statePath = join(project, ".autobizdevops/state.json")
    const originalState = readFileSync(statePath, "utf8")
    writeFileSync(
      join(project, ".autobizdevops/features/order-export/REQUIREMENTS_EVAL.md"),
      "verdict: PASS\nAutomated flow test fixture. Seven independent business assertions passed on order-export.cjs.\n" +
        independent.stdout
    )
    const stageFlow: FlowDefinition = {
      ...definition,
      id: "stage-e2e",
      name: "最终业务验收",
      feature: "order-export",
      stageStart: "requirements_eval_in_progress",
      steps: [
        {
          id: "confirm",
          name: "人工交付确认",
          kind: "approval",
          enabled: true,
          prompt: "确认最终验收"
        },
        { id: "stage", name: "推进阶段", kind: "autobiz-stage", enabled: true }
      ]
    }
    const stageSaved = await page.evaluate(
      ({ threadId, stageFlow }) => window.api.mods.flowSave(threadId, stageFlow, 0),
      { threadId, stageFlow }
    )
    await page.evaluate(
      (id) =>
        window.api.mods.setCompletionPolicy(id, "flow-e2e", {
          mode: "check",
          scope: "project",
          checks: ["unit-test"],
          maxRepairs: 0,
          timeoutMs: 120000,
          modelTokenBudget: 4096
        }),
      threadId
    )
    writeFileSync(join(project, "order-export.cjs"), "exports.exportOrders = () => 'broken'\n")
    const blocked = await page.evaluate(
      ({ threadId, saved }) =>
        window.api.mods.flowStart(threadId, saved.definition.id, saved.revision),
      { threadId, saved: stageSaved }
    )
    const blockedRun = await until(blocked.id, "failed")
    assert(!blockedRun.attempts.some((a) => a.result?.source === "approval"))
    assert.equal(readFileSync(statePath, "utf8"), originalState)
    pass("应用强制单测失败：尚未人工确认、没有推进Autobiz阶段")
    writeFileSync(join(project, "order-export.cjs"), fixedOrderExport)
    const stageRun = await page.evaluate(
      ({ threadId, saved }) =>
        window.api.mods.flowStart(threadId, saved.definition.id, saved.revision),
      { threadId, saved: stageSaved }
    )
    const stageWaiting = await until(stageRun.id, "waiting")
    assert(stageWaiting.pendingApproval!.summary.includes("最终阶段验收"))
    assert.equal(readFileSync(statePath, "utf8"), originalState)
    await page.evaluate(
      ({ threadId, run }) =>
        window.api.mods.flowDecide(threadId, run.id, run.pendingApproval!.nonce, true),
      { threadId, run: stageWaiting }
    )
    const stageComplete = await until(stageRun.id, "complete")
    assert.equal(
      JSON.parse(readFileSync(statePath, "utf8")).features["order-export"].checkpoint,
      "requirements_eval_done"
    )
    const transitions = (
      await page.evaluate((id) => window.api.mods.completionEvidence(id), threadId)
    ).filter((r) => r.phase === "state.transition" && r.status === "pass")
    assert.equal(transitions.length, 1)
    pass("真实上游Autobiz编译校验、人工确认后仅一次原生checkpoint提交")
    await verifyClawJourney(page, threadId, artifacts)
    pass(
      "真实上传 A/B 组件、React 保存应用组合、普通聊天只触发选中 Hook，恢复配置后核验未选中组件计数不变"
    )
    await app.close()
    app = await _electron.launch({
      executablePath: join(root, "tests/support/electron-launcher.cmd"),
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
      cwd: root,
      env,
      timeout: 60000
    })
    await app.firstWindow()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
    })
    page = app.windows()[0]
    await page.waitForFunction(() => Boolean(window.api?.mods?.flowList))
    const persisted = await page.evaluate((id) => window.api.mods.flowList(id), threadId)
    assert.equal(persisted.find((flow) => flow.definition.id === "ordering")?.revision, 3)
    assert.equal((await readRun(stageRun.id))?.status, "complete")
    const claw = await page.evaluate((id) => window.api.mods.clawView(id), threadId)
    assert.equal(claw.profiles.length, 2)
    assert.equal(claw.active, null)
    const requestsBefore = model.requests.length
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(model.requests.length, requestsBefore)
    pass("完整重启后配置版本和完成记录保留，没有自动重放Agent或阶段提交")
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        { passed: true, isolated, checks, requests: model.requests, complete, stageComplete },
        null,
        2
      )
    )
  } catch (error) {
    writeFileSync(
      join(artifacts, "failure.json"),
      JSON.stringify(
        { isolated, checks, error: String(error), latest, requests: model.requests },
        null,
        2
      )
    )
    if (page!) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    throw error
  } finally {
    clearTimeout(watchdog)
    writeFileSync(join(artifacts, "electron.log"), logs.join(""))
    await app?.close().catch(() => {})
    await model.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
