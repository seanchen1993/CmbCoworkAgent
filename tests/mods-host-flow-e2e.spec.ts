/** Ownerless v2 Flow, real Skill/MCP/models/checks/approval, and unchanged legacy isolation. */
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { ClawProfile } from "../src/shared/mods/claw"
import type { FlowDefinition, FlowRun, FlowStep, SavedFlow } from "../src/shared/mods/flows/types"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { flowFormsPlugin } from "./support/mods-flow-forms-fixtures"
import {
  createHostCheckProject,
  HOST_SKILL_DOCUMENT,
  HOST_SKILL_NAME,
  hostSkillZip,
  readJournal,
  startHostFlowModel
} from "./support/mods-host-flow-fixtures"

const root = resolve(__dirname, "..")
const artifacts = process.env.CMB_MODS_CORE_E2E_ARTIFACTS
  ? resolve(process.env.CMB_MODS_CORE_E2E_ARTIFACTS)
  : join(root, "output/mods-host-flow-e2e")
const { isolated, workspace, env } = compositionEnvironment(root)
const launchApp = createModsCoreLauncher(root, isolated, env, artifacts)
mkdirSync(artifacts, { recursive: true })
for (const name of ["report.json", "failure.json", "failure.png"])
  rmSync(join(artifacts, name), { force: true })
const mcpJournal = join(isolated, "mcp.jsonl")
const checkJournal = join(isolated, "checks.jsonl")
createHostCheckProject(workspace, checkJournal)
const checks: string[] = []
const errors: string[] = []
const runs: FlowRun[] = []
const durations: Record<string, number> = {}
const dialogs: { title: string; message: string; detail: string }[] = []
let app: ElectronApplication | undefined
let page: Page
let threadId: string
const pass = (name: string) => {
  checks.push(name)
  console.log("PASS " + name)
}
const mcpCalls = () => readJournal(mcpJournal).filter((row) => row.event === "call").length

async function approveCheck() {
  const button = page
    .getByRole("button", { name: "运行", exact: true })
    .and(page.locator("button:not(nav button)"))
  if (await button.count()) {
    const command = (await button.locator("../..").locator("pre").innerText()).trim()
    assert(
      ["npm test", "npm run test", "npm run test:e2e"].includes(command),
      `Unexpected check approval: ${command}`
    )
    await button.click()
  }
}

async function until<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
  timeout = 60_000
) {
  const deadline = Date.now() + timeout
  let latest: T
  do {
    await approveCheck()
    latest = await read()
    if (accepts(latest)) return latest
    await new Promise((done) => setTimeout(done, 100))
  } while (Date.now() < deadline)
  throw Error(`${label}: ${JSON.stringify(latest)}`)
}

async function boot() {
  app = await launchApp(60000)
  app.process().stdout?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
  app.process().stderr?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
  page = await app.firstWindow()
  page.on("pageerror", (error) => errors.push(error.message))
  await app.evaluate(({ ipcMain, dialog }) => {
    ipcMain.removeHandler("open-login-page")
    ipcMain.handle("open-login-page", () => undefined)
    const recorded: { title: string; message: string; detail: string }[] = []
    ;(globalThis as unknown as { __hostFlowDialogs: typeof recorded }).__hostFlowDialogs = recorded
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string; message?: string; detail?: string }
      recorded.push({
        title: options.title ?? "",
        message: options.message ?? "",
        detail: options.detail ?? ""
      })
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  await page.waitForFunction(() => Boolean(window.api?.mods?.flowSave))
  await page.evaluate(() => {
    ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
  })
}

function definition(id: string, steps: FlowStep[]): FlowDefinition {
  return {
    schemaVersion: 2,
    execution: { kind: "host" },
    id,
    name: id,
    goal: "Verify ownerless host Flow",
    timeoutMs: 120000,
    maxExecutions: 16,
    steps
  }
}
const approval: FlowStep = {
  id: "approval",
  name: "人工确认",
  enabled: true,
  kind: "approval",
  prompt: "Confirm the real host results"
}
async function save(flow: FlowDefinition) {
  return page.evaluate(
    ({ threadId, flowJson }) => {
      const flow: FlowDefinition = JSON.parse(flowJson)
      return window.api.mods.flowSave(threadId, flow, 0)
    },
    { threadId, flowJson: JSON.stringify(flow) }
  )
}
async function start(saved: SavedFlow, id = threadId) {
  return page.evaluate(
    ({ id, flowId, revision }) => window.api.mods.flowStart(id, flowId, revision),
    { id, flowId: saved.definition.id, revision: saved.revision }
  )
}
async function readRun(id: string) {
  return page.evaluate(({ threadId, id }) => window.api.mods.flowRun(threadId, id), {
    threadId,
    id
  })
}
async function terminal(id: string, expected?: FlowRun["status"]) {
  const result = await until(
    () => readRun(id),
    (run) =>
      Boolean(run && ["complete", "failed", "cancelled", "interrupted"].includes(run.status)),
    "Flow did not terminate"
  )
  if (expected) assert.equal(result?.status, expected, JSON.stringify(result))
  runs.push(result!)
  return result!
}
async function waiting(id: string) {
  const result = await until(
    () => readRun(id),
    (run) =>
      Boolean(
        run && ["waiting", "failed", "cancelled", "interrupted", "complete"].includes(run.status)
      ),
    "Flow did not reach approval"
  )
  assert.equal(result?.status, "waiting", JSON.stringify(result))
  return result!
}
async function apply(profile: ClawProfile) {
  return page.evaluate(
    async ({ threadId, profileJson }) => {
      const profile: ClawProfile = JSON.parse(profileJson)
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
        revision: view.revision
      })
    },
    { threadId, profileJson: JSON.stringify(profile) }
  )
}

async function main() {
  const model = await startHostFlowModel()
  const watchdog = setTimeout(() => void app?.close(), 480000)
  writeFileSync(join(artifacts, "runtime.log"), "")
  try {
    await boot()
    threadId = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.mods.configureGlobal(true)
        await window.api.models.setCustomConfig({
          id: "host-flow",
          name: "Host Flow local model",
          baseUrl: url,
          model: "host-flow",
          apiKey: "isolated-fixture",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:host-flow")
        const row = await window.api.threads.create({
          title: "无插件宿主流程",
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
    const uploaded = await page.evaluate(
      (bytes) => window.api.skills.upload(new Uint8Array(bytes).buffer, "host-skill.zip"),
      hostSkillZip()
    )
    assert(uploaded.success, uploaded.error)
    const connector = await page.evaluate((config) => window.api.mcp.create(config), {
      name: "host-flow-local",
      kind: "stdio" as const,
      command: process.execPath,
      args: [join(root, "tests/support/legacy-plugin-mcp-server.mjs"), mcpJournal, "host-flow"],
      enabled: true,
      lazyLoad: true
    })
    assert.deepEqual(await page.evaluate(() => window.api.plugins.list()), [])
    assert.deepEqual(
      (await page.evaluate((id) => window.api.mods.status(id), threadId)).functionMods,
      []
    )
    const sourceCatalog = await page.evaluate((id) => window.api.mods.clawSources(id), threadId)
    const skill = sourceCatalog.skills.find((row) => row.name === HOST_SKILL_NAME)!
    const mcp = sourceCatalog.mcp.find((row) => row.name === "host-flow-local")!
    assert(skill && mcp, JSON.stringify(sourceCatalog))
    assert.equal(mcpCalls(), 0)
    const skillFile = (await page.evaluate(() => window.api.skills.list())).find(
      (row) => row.name === HOST_SKILL_NAME
    )!
    assert(skillFile?.path, "Uploaded user Skill must be discoverable")
    model.setSkillPath(skillFile.path)
    const profile: ClawProfile = {
      id: "host-claw",
      name: "无需插件的 Claw",
      capabilities: [],
      skills: { mode: "selected", items: [skill] },
      mcp: { mode: "selected", items: [mcp] },
      models: { default: "custom:host-flow", roles: {} }
    }
    await apply(profile)
    const hostCatalog = await page.evaluate((id) => window.api.mods.flowCatalog(id), threadId)
    assert.equal(hostCatalog.hostAvailable, true)
    assert.deepEqual(hostCatalog.plugins, [])
    assert.equal(model.requests.length, 0)
    assert.equal(mcpCalls(), 0)
    pass(
      "Zero installed plugins and zero Function grants still expose host Flow and selected user Skill/MCP without execution"
    )
    const tools = await page.evaluate((id) => window.api.mods.flowMcpTools(id), threadId)
    const echo = tools.find((tool) => tool.provider.id === mcp.id && tool.toolName === "echo")!
    assert(echo && !echo.unavailableReason, JSON.stringify(tools))
    const mcpStep: FlowStep = {
      id: "mcp",
      name: "独立 MCP 调用",
      enabled: true,
      kind: "mcp-tool",
      provider: echo.provider,
      toolName: echo.toolName,
      schemaDigest: echo.schemaDigest,
      input: { text: "host-no-plugin" }
    }
    const skillStep: FlowStep = {
      id: "skill",
      name: "读取真实 Skill",
      enabled: true,
      kind: "skill",
      skill,
      prompt: "[HOST-SKILL] Read the selected Skill instructions and return a structured result.",
      modelId: "custom:host-flow"
    }
    const agentStep: FlowStep = {
      id: "agent",
      name: "独立模型步骤",
      enabled: true,
      kind: "agent",
      prompt: "[HOST-AGENT] Return a structured passing result.",
      modelId: "custom:host-flow"
    }
    const hookIds = await page.evaluate(
      async ({ base, matcher }) =>
        Promise.all(
          (["PreSkillUse", "PostSkillUse"] as const).map((event) =>
            window.api.hooks.create({
              event,
              matcher,
              type: "http",
              enabled: true,
              timeout: 10000,
              url: `${base}/skill-hook/${event === "PreSkillUse" ? "pre" : "post"}`
            })
          )
        ),
      { base: model.url.replace(/\/v1$/, ""), matcher: HOST_SKILL_NAME }
    )
    const chain = await save(
      definition("host-chain", [
        skillStep,
        mcpStep,
        agentStep,
        { id: "unit", name: "真实单元测试", enabled: true, kind: "check", check: "unit-test" },
        { id: "e2e", name: "真实 E2E 检查", enabled: true, kind: "check", check: "e2e" },
        approval
      ])
    )
    const bound = await apply({ ...profile, flow: chain })
    assert.equal(bound.active?.flow?.definition.schemaVersion, 2)
    await page.reload()
    await page.getByText("无插件宿主流程", { exact: true }).first().click()
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await page.getByRole("button", { name: "DIY 流程", exact: true }).click()
    await page.getByRole("button", { name: "host-chain · v1", exact: true }).click()
    assert.equal(await page.getByLabel("所属插件", { exact: true }).count(), 0)
    await page.screenshot({ path: join(artifacts, "host-no-plugin-editor.png") })
    await page.getByRole("button", { name: "到聊天启动此流程", exact: true }).click()
    await page.getByRole("button", { name: "打开 Claw 工作台", exact: true }).click()
    const workbench = page.getByRole("complementary", { name: "Claw 工作台", exact: true })
    await workbench.getByRole("button", { name: "运行", exact: true }).click()
    await workbench.getByText("使用独立流程模板。", { exact: false }).waitFor({ state: "visible" })
    const flowSelector = workbench.getByLabel("对话使用的 DIY 流程", { exact: true })
    const boundChoice = `claw:${bound.bindingRevision}`
    await flowSelector.selectOption(boundChoice)
    assert.equal(await flowSelector.inputValue(), boundChoice)
    await page
      .getByText("使用已应用 Claw 的流程副本。", { exact: false })
      .waitFor({ state: "visible" })
    await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
    await page.getByRole("button", { name: "执行流程", exact: true }).click()
    await page
      .locator("textarea.composer-textarea")
      .fill("执行没有所属插件的 Skill、MCP、模型和真实检查")
    const startedAt = performance.now()
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
    const first = (
      await until(
        () => page.evaluate((id) => window.api.mods.flowRuns(id), threadId),
        (rows) => rows.length > 0,
        "Chat did not start host Flow"
      )
    )[0]
    const pending = await waiting(first.id)
    durations.chatToApprovalMs = performance.now() - startedAt
    assert.equal(mcpCalls(), 1)
    dialogs.push(
      ...(await app!.evaluate(
        () => (globalThis as unknown as { __hostFlowDialogs: typeof dialogs }).__hostFlowDialogs
      ))
    )
    const hostDialogs = dialogs.filter((entry) => entry.title === "批准流程操作")
    assert(
      hostDialogs.length > 0,
      "Real host execution must show an accurately attributed operation approval"
    )
    assert(!dialogs.some((entry) => entry.title === "批准插件操作"), JSON.stringify(dialogs))
    for (const entry of hostDialogs) {
      assert.match(entry.message, /DIY 流程请求执行/)
      assert(!/插件|flow:/i.test(entry.message), entry.message)
    }
    assert(
      hostDialogs.some((entry) =>
        entry.message.endsWith(`mcp:connector:${connector.id}:${echo.toolName}`)
      ),
      "Approval must retain the exact selected MCP target"
    )
    assert(
      model.hooks.some((url) => url.endsWith("/pre")) &&
        model.hooks.some((url) => url.endsWith("/post"))
    )
    assert(
      model.requests.some((request) =>
        (request.messages as { role: string; content: unknown }[]).some(
          (message) =>
            message.role === "tool" &&
            JSON.stringify(message.content).includes("HOST_FLOW_REAL_SKILL_DOCUMENT")
        )
      )
    )
    assert(readJournal(checkJournal).some((row) => row.kind === "unit" && row.passed))
    assert(readJournal(checkJournal).some((row) => row.kind === "e2e" && row.passed))
    await page.screenshot({ path: join(artifacts, "host-no-plugin-approval.png") })
    await page.getByRole("button", { name: "同意并继续", exact: true }).click()
    const completed = await terminal(pending.id, "complete")
    assert.equal(completed.flow.definition.schemaVersion, 2)
    assert(!("plugin" in completed.flow.definition))
    assert(readJournal(checkJournal).filter((row) => row.kind === "unit").length >= 2)
    assert(readJournal(checkJournal).filter((row) => row.kind === "e2e").length >= 2)
    assert.equal(mcpCalls(), 1)
    await page.getByText("流程任务 · host-chain · 查看进度与结果", { exact: true }).click()
    await page.screenshot({ path: join(artifacts, "host-no-plugin-complete.png") })
    pass(
      "Real chat runs Skill read/Pre/Post, MCP once, Agent, npm unit/e2e checks, user approval and final rechecks with no plugin owner"
    )

    for (const forbidden of ["code-review", "autobiz-validator", "autobiz-stage"] as const) {
      const step: FlowStep =
        forbidden === "autobiz-stage"
          ? { id: "bad", name: "Forbidden", enabled: true, kind: "autobiz-stage" }
          : { id: "bad", name: "Forbidden", enabled: true, kind: "check", check: forbidden }
      await assert.rejects(save(definition(`forbidden-${forbidden}`, [step])))
    }
    await assert.rejects(
      page.evaluate(
        ({ id, flowJson }) => {
          const flow: FlowDefinition = JSON.parse(flowJson)
          return window.api.mods.flowSave(id, flow, 0)
        },
        {
          id: threadId,
          flowJson: JSON.stringify({
            ...definition("forbidden-owner", [approval]),
            plugin: "pretend"
          })
        }
      )
    )
    pass(
      "v2 rejects plugin ownership and unsupported review/Autobiz operations at save, before execution"
    )

    const waitThenCall = await save(definition("wait-before-call", [approval, mcpStep]))
    const waitRun = await waiting((await start(waitThenCall)).id)
    const other = await page.evaluate(async (workspace) => {
      const row = await window.api.threads.create({
        title: "Host concurrent thread",
        workspacePath: workspace,
        agentMode: "normal"
      })
      const id = (row as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, workspace)
      return id
    }, workspace)
    await assert.rejects(start(waitThenCall, other), /同一项目|执行|运行/)
    await page.evaluate(({ threadId, id }) => window.api.mods.flowCancel(threadId, id), {
      threadId,
      id: waitRun.id
    })
    await terminal(waitRun.id, "cancelled")
    await assert.rejects(
      page.evaluate(
        ({ threadId, id, nonce }) => window.api.mods.flowDecide(threadId, id, nonce, true),
        { threadId, id: waitRun.id, nonce: waitRun.pendingApproval!.nonce }
      )
    )
    assert.equal(mcpCalls(), 1)
    pass(
      "Ownerless runs retain project lease exclusion and cancel/expired approval never invokes the pending MCP"
    )

    const mcpRevoked = await waiting((await start(waitThenCall)).id)
    const requestsBeforeRevoke = model.requests.length
    await page.evaluate((id) => window.api.mcp.setEnabled(id, false), connector.id)
    await assert.rejects(
      page.evaluate(
        ({ threadId, id, nonce }) => window.api.mods.flowDecide(threadId, id, nonce, true),
        { threadId, id: mcpRevoked.id, nonce: mcpRevoked.pendingApproval!.nonce }
      )
    )
    assert.notEqual((await terminal(mcpRevoked.id)).status, "complete")
    assert.equal(mcpCalls(), 1)
    assert.equal(model.requests.length, requestsBeforeRevoke)
    await page.evaluate((id) => window.api.mcp.setEnabled(id, true), connector.id)
    const waitOnly = await save(definition("host-wait-only", [approval]))
    const disabledRun = await waiting((await start(waitOnly)).id)
    await page.evaluate((id) => window.api.mods.configure(id, false, true), threadId)
    assert.notEqual((await terminal(disabledRun.id)).status, "complete")
    assert.equal(
      (await page.evaluate((id) => window.api.mods.flowCatalog(id), threadId)).hostAvailable,
      false
    )
    await page.evaluate((id) => window.api.mods.configure(id, true, true), threadId)
    pass(
      "Real MCP disable and workspace Mods disable invalidate active host authority without late model/tool execution"
    )

    const skillWait = await save(definition("host-skill-drift", [approval, skillStep]))
    const skillRun = await waiting((await start(skillWait)).id)
    const beforeDrift = model.requests.length
    const mutated = await page.evaluate(
      ({ path, content }) => window.api.skills.write(path, content),
      {
        path: skillFile.path,
        content: HOST_SKILL_DOCUMENT + "\nSource changed after preparation.\n"
      }
    )
    assert(mutated.success, mutated.error)
    await assert.rejects(
      page.evaluate(
        ({ threadId, id, nonce }) => window.api.mods.flowDecide(threadId, id, nonce, true),
        { threadId, id: skillRun.id, nonce: skillRun.pendingApproval!.nonce }
      )
    )
    assert.notEqual((await terminal(skillRun.id)).status, "complete")
    assert.equal(model.requests.length, beforeDrift)
    const restoredSkill = await page.evaluate(
      ({ path, content }) => window.api.skills.write(path, content),
      {
        path: skillFile.path,
        content: HOST_SKILL_DOCUMENT
      }
    )
    assert(restoredSkill.success, restoredSkill.error)
    pass("Skill content mutation invalidates prepared host flow before any Skill model call")

    const interrupted = await waiting((await start(waitOnly)).id)
    const beforeRestart = {
      requests: model.requests.length,
      calls: mcpCalls(),
      checks: readJournal(checkJournal).length
    }
    await app!.close()
    app = undefined
    await boot()
    const history = await page.evaluate((id) => window.api.mods.flowRuns(id), threadId)
    assert.equal(history.find((run) => run.id === interrupted.id)?.status, "cancelled")
    assert.equal(history.find((run) => run.id === completed.id)?.status, "complete")
    assert.deepEqual(
      {
        requests: model.requests.length,
        calls: mcpCalls(),
        checks: readJournal(checkJournal).length
      },
      beforeRestart
    )
    const restored = await page.evaluate((id) => window.api.mods.clawView(id), threadId)
    assert.equal(restored.active?.flow?.digest, chain.digest)
    assert.equal(restored.active?.flow?.definition.schemaVersion, 2)
    await assert.rejects(
      page.evaluate(
        ({ threadId, id, nonce }) => window.api.mods.flowDecide(threadId, id, nonce, true),
        { threadId, id: interrupted.id, nonce: interrupted.pendingApproval!.nonce }
      )
    )
    assert.deepEqual(await page.evaluate(() => window.api.plugins.list()), [])
    pass(
      "Graceful restart preserves v2 Claw snapshot and completed history, cancels unfinished approval and never replays side effects"
    )

    for (const metadata of [{ agentMode: "workflow" }]) {
      const id = await page.evaluate(
        async ({ workspace, metadata }) => {
          const row = await window.api.threads.create({
            title: "Unsupported host flow scope",
            workspacePath: workspace,
            ...metadata
          })
          const id = (row as unknown as { thread_id: string }).thread_id
          await window.api.workspace.set(id, workspace)
          return id
        },
        { workspace, metadata }
      )
      await assert.rejects(
        page.evaluate((id) => window.api.mods.flowCatalog(id), id),
        /本地项目|上下文|scope|binding/i
      )
    }
    await assert.rejects(
      page.evaluate(
        (id) =>
          window.api.threads.patchMetadata(id, {
            set: { harnessProjectSession: { projectId: "probe", kind: "chat" } }
          }),
        threadId
      ),
      /not renderer-writable: harnessProjectSession/
    )
    pass(
      "Workflow remains ineligible and renderer cannot forge Harness bindings; real local project/feature support is tested separately"
    )

    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "unapproved.zip",
          "local",
          undefined,
          true
        ),
      flowFormsPlugin(true)
    )
    assert(installed.success, installed.error)
    const plugin = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((row) => row.name === "forms-producer")!
    assert(plugin?.digest)
    const action: FlowStep = {
      id: "action",
      name: "Explicit plugin action",
      enabled: true,
      kind: "plugin-action",
      pluginId: plugin.pluginId,
      plugin: plugin.name,
      digest: plugin.digest,
      actionId: "prepare-review",
      input: { feature: "host", path: "host-value.json" },
      config: { strict: false, retries: 0, note: "" }
    }
    const mixed = await save(definition("host-mixed-action", [action]))
    const denied = await terminal((await start(mixed)).id, "failed")
    assert(!denied.attempts.some((attempt) => attempt.status === "passed"))
    await page.evaluate(
      async ({ threadId, pluginId, digest, name }) => {
        await window.api.mods.approveFunction(threadId, pluginId, digest)
        await window.api.mods.setCompletionPolicy(threadId, name, {
          mode: "off",
          scope: "diff",
          checks: [],
          maxRepairs: 0,
          timeoutMs: 120000,
          modelTokenBudget: 4096
        })
      },
      { threadId, pluginId: plugin.pluginId, digest: plugin.digest!, name: plugin.name }
    )
    const selectedDenied = await terminal((await start(mixed)).id, "failed")
    assert(!selectedDenied.attempts.some((attempt) => attempt.status === "passed"))
    await apply({
      ...profile,
      capabilities: [{ pluginId: plugin.pluginId, name: plugin.name, digest: plugin.digest }],
      flow: mixed
    })
    const actionCount = async () => {
      const job = await page.evaluate(async (threadId) => {
        const descriptor = (await window.api.mods.commands(threadId)).find(
          (row) => row.command === "forms-producer"
        )!
        return window.api.mods.enqueue(threadId, descriptor, { text: "inspect-count" })
      }, threadId)
      const result = await until(
        () =>
          page.evaluate(
            async ({ threadId, id }) =>
              (await window.api.mods.jobs(threadId)).find((row) => row.id === id),
            { threadId, id: job.id }
          ),
        (row) => Boolean(row && ["succeeded", "failed", "cancelled"].includes(row.state)),
        "Action counter did not settle"
      )
      assert.equal(result?.state, "succeeded", JSON.stringify(result))
      return Number(result?.result?.text)
    }
    assert.equal(
      await actionCount(),
      0,
      "Rejected unapproved/unselected flows must not call the guest"
    )
    const executed = await terminal((await start(mixed)).id, "complete")
    assert.equal(await actionCount(), 1)
    assert.equal(
      executed.attempts.find((attempt) => attempt.stepId === "action")?.result?.output?.path,
      "host-value.json"
    )
    const legacy: FlowDefinition = {
      schemaVersion: 1,
      plugin: plugin.name,
      id: "host-legacy-v1",
      name: "Legacy v1 unchanged",
      goal: "Legacy owner semantics",
      timeoutMs: 120000,
      maxExecutions: 6,
      steps: [action]
    }
    const savedLegacy = await save(legacy)
    await terminal((await start(savedLegacy)).id, "complete")
    assert.equal(await actionCount(), 2)
    const persisted = (await page.evaluate((id) => window.api.mods.flowList(id), threadId)).find(
      (flow) => flow.definition.id === legacy.id
    )!
    assert.deepEqual(persisted, savedLegacy)
    assert.equal(persisted.definition.schemaVersion, 1)
    assert.equal("plugin" in persisted.definition && persisted.definition.plugin, plugin.name)
    await page.evaluate(({ threadId, name }) => window.api.mods.revokeFunction(threadId, name), {
      threadId,
      name: plugin.name
    })
    await terminal((await start(savedLegacy)).id, "failed")
    await terminal((await start(mixed)).id, "failed")
    pass(
      "Host flow never grants plugin access; explicit grant plus Claw selection is required, and v1 ownership/digest/revocation stay intact"
    )
    for (const hook of hookIds) await page.evaluate((id) => window.api.hooks.delete(id), hook.id)
    assert.deepEqual(errors, [])
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          passed: true,
          isolated,
          checks,
          durations,
          runs,
          modelRequests: model.requests,
          skillHooks: model.hooks,
          dialogs,
          mcp: readJournal(mcpJournal),
          nativeChecks: readJournal(checkJournal),
          errors
        },
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
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
          body: await page
            ?.locator("body")
            .textContent()
            .catch(() => null),
          requests: model.requests,
          dialogs,
          mcp: readJournal(mcpJournal),
          nativeChecks: readJournal(checkJournal),
          runs,
          errors
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
